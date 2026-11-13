/**
 * engine/advance.js — один ход машины состояний Клоузера.
 *
 * advance(dealId, managerInput):
 *   1. собирает контекст (сделка, память, история диалога, общий вход агентов);
 *   2. «заверши сессию» в любом этапе → итог; иначе — обработчик текущего
 *      этапа из steps/ (STEP_HANDLERS);
 *   3. сохраняет результат в deals и возвращает текст для чата.
 * Плюс защита от дублей и очередь запросов по одной сделке (баг №34).
 */
const db = require('../db');
const { runMemoryUpdate } = require('./pipeline');
const { isEndSessionCommand } = require('./intent');
const { formatAgentReplyForChat, formatTimeline } = require('./chat');
const { STEP_HANDLERS } = require('./steps');
const { computeTimeline, moscowToday } = require('./timeline');


function daysSilentNow(deal) {
  const base = Number(deal.days_silent) || 0;
  if (!deal.created_at) return base;
  const created = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(deal.created_at));
  const days = Math.round((Date.parse(`${moscowToday()}T00:00:00Z`) - Date.parse(`${created}T00:00:00Z`)) / 864e5);
  return base + Math.max(0, days);
}

const EMPTY_ASSESSMENT = { financial: '', need: '', trust: '', authority: '', urgency: '' };

// Один шаг машины состояний. managerInput — текст, который менеджер только что отправил.
async function advanceInternal(dealId, managerInput) {
  const deal = await db.getDeal(dealId);
  const memory = (await db.loadMemory(dealId)) || {
    session_number: 1, previous_touchpoints: [], confirmed_facts: [], open_questions: []
  };
  const allMessages = await db.getMessages(dealId);
  const dialogHistory = allMessages
    .filter(m => m.role === 'user' || m.role === 'agent')
    .map(m => `[${m.role === 'user' ? 'Менеджер' : 'Агент'}]: ${m.content}`)
    .join('\n\n');
  // Все материалы менеджера за всё время (переписка с клиентом, заметки,
  // ответы на уточнения). Раньше агенты видели только ТЕКУЩЕЕ сообщение
  // менеджера (на шаге касаний это «ок») и хвост dialog_history в 4000
  // символов, где почти всё — длинные ответы самих агентов. Переписка из
  // первого сообщения выпадала уже на втором ходу: composer не видел
  // «Логотип пришлю» и «успеваем, если согласуем до 10 ноября» (живой
  // тест 2026-11-13). Сообщения менеджера короткие и важные — отдаём их
  // отдельным полем, не смешивая с ответами агентов.
  const managerMessages = allMessages.filter(m => m.role === 'user' && String(m.content || '').trim());
  const sourceMaterials = managerMessages.length
    ? {
      what_is_this: 'Все сообщения менеджера по сделке за всё время, по порядку: переписка с клиентом, заметки, ответы на уточнения. Главный источник фактов — цитаты клиента, его обещания, условия и даты, которые менеджер уже называл.',
      text: managerMessages.map((m, i) => `[Сообщение менеджера ${i + 1}]\n${m.content}`).join('\n\n')
    }
    : undefined;
  const baseInput = {
    // Баг №21: ни один агент в цепочке не получал реальную текущую дату —
    // из-за этого diagnostic не мог достоверно судить "дедлайн прошёл или
    // нет" (Критерий 5 — Срочность), а memory при формировании
    // session_date был вынужден либо выдумывать дату, либо собирать
    // мусор вроде "2025-01-session-1". today передаётся один раз здесь и
    // автоматически доходит до всех агентов через `...baseInput`.
    today: moscowToday(),
    // Сроки, посчитанные кодом (engine/timeline.js). null — если в сделке нет
    // даты клиента или срока производства.
    timeline: computeTimeline({
      today: moscowToday(),
      clientDeadline: deal.client_deadline,
      productionDays: deal.production_days,
      installDaysMin: deal.install_days_min ?? 2,
      installDaysMax: deal.install_days_max ?? 3,
      industry: deal.industry
    }),
    deal: {
      client: deal.client,
      product: deal.product,
      deal_size: deal.deal_size,
      industry: deal.industry,
      last_contact: deal.last_contact,
      // Менеджер вводит «дней без ответа» при создании сделки, дальше число
      // устаревало. Считаем на сегодня: введённое + дни с даты создания.
      days_silent: daysSilentNow(deal),
      days_silent_note: 'Посчитано на сегодня от числа, введённого при создании сделки. Если в материалах есть более свежий ответ клиента — молчание считай от него.'
    },
    materials: {
      correspondence: managerInput,
      source_materials: sourceMaterials,
      dialog_history: dialogHistory,
      // Самооценка МЕНЕДЖЕРА. Не deal.criteria: туда после диагностики пишется
      // оценка самого агента («лампочки» в интерфейсе), и агент сравнивал себя
      // с собой прошлым, называя это «мнением менеджера» (найдено на живом
      // тесте 2026-11-12). Ввода самооценки в интерфейсе пока нет — поле
      // deal.manager_criteria зарезервировано под него (см. HANDOFF).
      user_assessment: deal.manager_criteria || EMPTY_ASSESSMENT
    },
    memory
  };
  const ctx = { dealId, deal, memory, baseInput, managerInput };
  let nextState;
  let output;
  // Явная команда завершения — срабатывает в ЛЮБОМ состоянии, кроме уже
  // завершённого FINAL_OUTPUT (там каждое сообщение начинает новую сессию).
  // Аварийный выход, если, например, planner застрял на уточняющих вопросах.
  if (deal.current_state !== 'FINAL_OUTPUT' && isEndSessionCommand(managerInput)) {
    output = {
      _finalText: await runMemoryUpdate(dealId, baseInput, deal, {
        statusNote: 'Статус: сессия завершена вручную по команде менеджера (досрочно, не весь цикл мог быть пройден).'
      })
    };
    nextState = 'FINAL_OUTPUT';
  } else {
    const handler = STEP_HANDLERS[deal.current_state];
    ({ nextState, output } = handler ? await handler(ctx) : { nextState: 'INIT', output: {} });
  }
  // Сохранить промежуточные выходы агентов на сделке для следующего шага
  const statePatch = { current_state: nextState };
  if (output.diagnostic_output) statePatch.last_diagnostic_output = output.diagnostic_output;
  if (output.strategy_output) statePatch.last_strategy_output = output.strategy_output;
  if (output.composer_output) statePatch.last_composer_output = output.composer_output;
  if (output.reviewer_output) statePatch.last_reviewer_output = output.reviewer_output;
  if (output._composer_iterations) statePatch.composer_iterations = output._composer_iterations;
  if (output._intake_rounds) statePatch.intake_rounds = output._intake_rounds;
  // Флаг ожидания ответа "скорректировать/нет" и текст вопроса, на который
  // ждём этот ответ — сохраняем на сделке, чтобы следующий ход менеджера
  // (в новом HTTP-запросе, с чистого state) знал, что мы сейчас ждём именно
  // да/нет, а не обычную реплику.
  if (typeof output._awaitingCorrectionConfirmation === 'boolean') {
    statePatch.awaiting_correction_confirmation = output._awaitingCorrectionConfirmation;
  }
  if (output._pendingManagerFeedback !== undefined) {
    statePatch.pending_manager_feedback = output._pendingManagerFeedback;
  }
  // Тот же принцип для ручных попыток после ESCALATION (баг №35, HANDOFF_v8).
  // ВАЖНО: проверка на undefined, а не на truthy — сброс в 0 при старте новой
  // сессии (см. case 'FINAL_OUTPUT') иначе молча не сохранился бы в БД, и
  // новая сессия унаследовала бы исчерпанный лимит от предыдущей.
  if (output._escalation_retries !== undefined) statePatch.escalation_retries = output._escalation_retries;
  if (typeof output._awaitingEscalationConfirmation === 'boolean') {
    statePatch.awaiting_escalation_confirmation = output._awaitingEscalationConfirmation;
  }
  if (output._pendingEscalationFeedback !== undefined) {
    statePatch.pending_escalation_feedback = output._pendingEscalationFeedback;
  }
  // Баг №24: раньше здесь проверялось только diag.criteria_assessment, но
  // схема diagnostic_agent.md отдаёт поле "scores" — без этого фоллбэка
  // (тот же, что уже используется в formatAgentReplyForChat выше) deal.criteria
  // в БД никогда не обновлялся реальным выводом diagnostic-агента.
  const diagForCriteria = output.diagnostic_output?.criteria_assessment || output.diagnostic_output?.scores;
  if (diagForCriteria) {
    const c = diagForCriteria;
    statePatch.criteria = {
      financial: c.financial_capacity?.status || c.financial?.status || deal.criteria.financial,
      need: c.need?.status || deal.criteria.need,
      trust: c.trust?.status || deal.criteria.trust,
      authority: c.authority?.status || deal.criteria.authority,
      urgency: c.urgency?.status || deal.criteria.urgency
    };
  }
  await db.updateDealState(dealId, statePatch);
  if (!output.composer_output && deal.last_composer_output) {
    output.composer_output = deal.last_composer_output;
  }
  // Если на этом шаге явно задан "прямой" текст ответа (ответ advisor'а,
  // уточнение да/нет и т.п.) — показываем его как есть, а не через
  // formatAgentReplyForChat(nextState, ...), потому что состояние остаётся
  // COMPOSING и без этого приоритета показались бы прежние касания вместо
  // ответа на вопрос менеджера.
  let chatText = output._directText
    || formatAgentReplyForChat(nextState, output)
    || formatAgentReplyForChat(deal.current_state, output);
  // После свежей диагностики — блок «Сроки» (расчёт кодом).
  if (!output._directText && output.diagnostic_output) chatText += formatTimeline(baseInput.timeline);
  // Что делать дальше: «ок» — следующий шаг, иначе — правка (её учтут и пересоберут).
  if (!output._directText && nextState === 'DIAGNOSING') {
    chatText += '\n\n---\n\n_Напишите «ок» — составлю стратегию. Если в оценке что-то не так или есть новые факты — напишите, пересоберу оценку._';
  } else if (!output._directText && nextState === 'STRATEGY_SELECTION') {
    chatText += '\n\n---\n\n_Напишите «ок» — напишу касания. Если стратегию или список «Обязательно в касаниях» нужно поправить — напишите что, пересоберу._';
  }
  return { nextState, chatText, raw: output };
}


/**
 * Защита от дублей (найдена по логам после включения логирования в
 * agentRunner.js — на реальной сделке planner и diagnostic отработали
 * по два раза подряд с идентичными входными данными). advance() сам по
 * себе не имел никакой защиты от повторной обработки одного и того же
 * сообщения — при двойной отправке (двойной клик, повтор запроса от
 * клиента и т.п.) вся цепочка агентов просто честно отрабатывала дважды,
 * дважды тратя токены.
 *
 * Это НЕ чинит источник дублирования (сам HTTP-роут/вебхук, который
 * вызывает advance(), в этот пакет не входил) — это защитный слой на
 * уровне stateMachine.js, который сработает независимо от того, откуда
 * пришёл дубль.
 *
 * ВАЖНО: дедупликация — в памяти процесса (Map), не в БД. Это значит:
 * - не переживает перезапуск/передеплой сервиса (это нормально, дубли
 *   обычно приходят в пределах секунд, а не через рестарт);
 * - НЕ защищает от дублей, если бэкенд когда-либо будет масштабирован
 *   на несколько инстансов Render одновременно (тогда нужен будет
 *   дедуп на уровне БД — отдельная задача, если/когда до этого дойдёт).
 */
const recentAdvanceCalls = new Map(); // dealId -> { input, timestamp, promise }
const ADVANCE_DEDUP_WINDOW_MS = 15000;


/**
 * Баг №34 (сессия 3, найден в проде через несовпадающий текст касаний
 * между тестами): защита выше ловит только ДОСЛОВНО одинаковый текст
 * сообщения в 15-секундном окне. Если к одной и той же сделке пришли
 * ДВА РАЗНЫХ по тексту запроса почти одновременно (двойной клик с уже
 * изменившимся полем ввода, повтор формы при нестабильном интернете,
 * открытая в двух вкладках сделка) — она их не ловит вообще, и оба
 * запроса выполняют advanceInternal() ПАРАЛЛЕЛЬНО:
 *   1. Оба читают db.getDeal() и видят ОДНУ И ТУ ЖЕ версию сделки
 *      (то, что записал предыдущий, уже завершённый шаг).
 *   2. Оба независимо гоняют agentRunner (десятки секунд на Sonnet-вызовах).
 *   3. Тот, кто запишет db.updateDealState() ПОСЛЕДНИМ — затирает
 *      результат другого. Менеджер может увидеть ответ, посчитанный
 *      на уже устаревших входных данных, или получить "чужой" текст,
 *      как будто пайплайн не запускался вовсе.
 *
 * Фикс — сериализация (не дедупликация): все вызовы advance() для ОДНОЙ
 * И ТОЙ ЖЕ сделки, независимо от текста сообщения, ставятся в очередь
 * (async mutex через цепочку промисов) — второй запрос НАЧИНАЕТ
 * выполняться только после того, как первый полностью завершился и
 * записал результат в БД. Для РАЗНЫХ сделок ограничений нет — параллелизм
 * между сделками не страдает.
 *
 * ТЕ ЖЕ ограничения, что и у дедупликации выше: работает только в памяти
 * одного процесса, не спасает при горизонтальном масштабировании на
 * несколько инстансов (там нужна блокировка на уровне БД).
 */
const dealQueueTail = new Map(); // dealId -> Promise (последний поставленный в очередь вызов)


async function advance(dealId, managerInput) {
  const now = Date.now();
  const prev = recentAdvanceCalls.get(dealId);
  if (prev && prev.input === managerInput && (now - prev.timestamp) < ADVANCE_DEDUP_WINDOW_MS) {
    console.warn(
      `[advance] Повторный вызов для сделки ${dealId} с тем же сообщением в течение ` +
      `${ADVANCE_DEDUP_WINDOW_MS}мс — возвращаю результат первого вызова, агенты повторно не запускаются.`
    );
    return prev.promise;
  }

  const previousTail = dealQueueTail.get(dealId) || Promise.resolve();
  const queuedAlready = dealQueueTail.has(dealId);
  const promise = previousTail
    .catch(() => {}) // ошибка предыдущего запроса не должна ломать очередь для следующего
    .then(() => {
      if (queuedAlready) {
        console.warn(
          `[advance] Сделка ${dealId}: запрос с сообщением "${managerInput}" ждал в очереди ` +
          `завершения предыдущего запроса к этой же сделке (баг №34 — защита от гонки).`
        );
      }
      return advanceInternal(dealId, managerInput);
    });

  dealQueueTail.set(dealId, promise);
  recentAdvanceCalls.set(dealId, { input: managerInput, timestamp: now, promise });

  promise.finally(() => {
    // Убираем себя из очереди, только если мы всё ещё её "хвост" — если
    // за это время встал в очередь более новый запрос, его promise уже
    // должен остаться как хвост, не наш.
    if (dealQueueTail.get(dealId) === promise) dealQueueTail.delete(dealId);
    setTimeout(() => {
      const entry = recentAdvanceCalls.get(dealId);
      if (entry && entry.promise === promise) recentAdvanceCalls.delete(dealId);
    }, ADVANCE_DEDUP_WINDOW_MS);
  }).catch(() => {}); // не даём неотловленному отклонению всплыть из фонового таймера

  return promise;
}

module.exports = { advance, daysSilentNow };

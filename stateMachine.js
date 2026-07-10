const { callAgent } = require('./agentRunner');
const db = require('./db');

const CONFIG = {
  MAX_COMPOSER_ITERATIONS: 3,
  CHANNEL_HISTORY_SIZE: 3,
  MAX_MESSAGE_LENGTH: { telegram: 400, whatsapp: 400, email: 1500, voice: 300, call_script: 500 }
};

function validateMessageLength(composerOutput) {
  const messages = composerOutput?.composer_output?.messages || [];
  const violations = [];
  messages.forEach((msg, i) => {
    const maxLen = CONFIG.MAX_MESSAGE_LENGTH[msg.channel?.toLowerCase()];
    if (maxLen && msg.body?.length > maxLen) {
      violations.push({ touchpoint: i + 1, channel: msg.channel, current: msg.body.length, max: maxLen });
    }
  });
  return { valid: violations.length === 0, violations };
}

// Достаёт массив касаний независимо от того, есть ли лишний уровень вложенности
// composer_output.composer_output.messages или нет.
function getComposerMessages(composerOutput) {
  return composerOutput?.messages || composerOutput?.composer_output?.messages || [];
}

// Превращает объект/массив в читаемую строку вместо сырого JSON.
// Используется для значений ВНУТРИ одной строки (например, элемент массива).
function humanizeValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string' || typeof val === 'number') return String(val);
  if (Array.isArray(val)) return val.map(humanizeValue).filter(Boolean).join('; ');
  if (typeof val === 'object') {
    return Object.entries(val)
      .map(([k, v]) => `${k}: ${humanizeValue(v)}`)
      .filter(Boolean)
      .join('; ');
  }
  return String(val);
}

// Превращает объект в многострочный читаемый блок: каждое поле — на своей строке,
// с человекопонятной подписью вместо технического ключа (если она задана в labels).
// В отличие от humanizeValue не "склеивает" всё через "; " в одну строку.
function renderKeyValueBlock(obj, labels = {}) {
  if (obj === null || obj === undefined) return '—';
  if (typeof obj !== 'object') return String(obj);
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${labels[k] || k}: ${humanizeValue(v)}`)
    .join('\n');
}

const STRATEGY_LABELS = { name: 'Название', goal: 'Цель', rationale: 'Обоснование' };
const SESSION_SUMMARY_LABELS = {
  session_number: 'Номер сессии',
  session_date: 'Дата',
  what_we_know: 'Что известно',
  what_blocks: 'Что блокирует',
  what_was_done: 'Что сделано',
  what_is_next: 'Дальнейшие шаги',
  key_insight: 'Ключевой инсайт'
};

// Блокер иногда приходит не в отдельном поле main_blocker, а зашит внутрь
// primary_strategy (например, в rationale). Проверяем все известные варианты.
function getMainBlocker(strategyOutput) {
  return strategyOutput?.main_blocker
    || strategyOutput?.blocker
    || strategyOutput?.primary_strategy?.main_blocker
    || strategyOutput?.primary_strategy?.blocker
    || null;
}

// primary_strategy иногда приходит простой строкой ('Disqualification'), а иногда
// объектом ({ name: 'Disqualification', goal, rationale, ... }). Раньше код сравнивал
// primary_strategy напрямую со строкой 'Disqualification', и когда агент возвращал
// объект, сравнение всегда проваливалось — сделка не дисквалифицировалась, а шла
// дальше по циклу composer/reviewer, хотя стратегия была определена верно.
function getStrategyName(strategyOutput) {
  const s = strategyOutput?.primary_strategy;
  if (typeof s === 'string') return s;
  return s?.name || null;
}

// Единая логика fallback для объяснения расхождений между менеджером и агентом.
function getConflictExplanation(c) {
  return c?.plain_explanation
    || c?.explanation
    || c?.reason
    || c?.agent_assessment
    || c?.comment
    || 'уточните, пожалуйста, детали по этому критерию';
}

function getConflictQuestion(c) {
  return c?.question_for_manager || c?.question || 'Расскажите подробнее об этом моменте.';
}

// Раньше ЛЮБОЕ сообщение менеджера в состоянии COMPOSING (после показа касаний)
// уходило сразу на формальную проверку reviewer'ом — даже если менеджер написал
// содержательную правку вроде "слишком в лоб, нужно мягче". Reviewer проверяет
// по чек-листу (стоп-слова, персонализация и т.д.), а не по вкусовым пожеланиям
// менеджера, поэтому такой фидбэк тихо терялся, и одобрялся неизменённый вариант.
//
// Первая версия проверки требовала ТОЧНОГО совпадения всего сообщения с фразой
// согласия — это защищало от ложных срабатываний ("в целом норм, но..." больше
// не считалось согласием из-за слова "норм"), но оказалась слишком строгой:
// естественные фразы вроде "хорошо, меня устраивает" или "понял, ок" не совпадали
// один-в-один ни с чем в списке и снова уходили на "доработку" — сессия
// зацикливалась, потому что composer каждый раз возвращал то же самое, а
// согласие никогда не засчитывалось.
//
// Теперь: сообщение разбивается на смысловые части (по запятым/точкам/тире),
// и согласием считается, если КАЖДАЯ часть — это фраза одобрения из списка.
// Отдельно проверяются явные сигналы правки ("но", "хотя", "добавь", "смягчи"
// и т.п.) — если такой сигнал есть где-то в сообщении, это правка, а не
// согласие, даже если рядом есть слово "хорошо" или "норм".
const PURE_APPROVAL_PHRASES = new Set([
  'ок', 'окей', 'окай', 'ok', 'okay', 'да', 'ага', 'угу',
  'супер', 'отлично', 'класс', 'здорово', 'хорошо', 'норм', 'нормально',
  'принято', 'согласен', 'согласна', 'одобряю', 'одобрено',
  'погнали', 'го', 'вперед', 'вперёд', 'давай', 'запускай', 'запускаем',
  'понял', 'поняла', 'ясно', 'ладно', 'идеально', 'верно', 'подходит',
  'устраивает', 'меня устраивает',
  'все ок', 'всё ок', 'все супер', 'всё супер', 'все хорошо', 'всё хорошо',
  'все норм', 'всё норм', 'все отлично', 'всё отлично', 'все верно', 'всё верно',
  'все устраивает', 'всё устраивает', 'все подходит', 'всё подходит'
]);

const REVISION_SIGNAL_WORDS = new Set(['но', 'однако', 'хотя', 'кроме', 'зато']);
const REVISION_SIGNAL_PHRASES = [
  'добавь', 'добавьте', 'поменяй', 'поменяйте', 'убери', 'уберите',
  'замени', 'замените', 'нужно чтобы', 'нужно бы', 'надо чтобы',
  'было бы лучше', 'слишком', 'не хватает', 'хотелось бы', 'хочу чтобы',
  'а также', 'ещё используй', 'еще используй', 'обычно использую', 'я использую',
  'смягчи', 'сократи', 'удлини', 'исправь', 'поправь'
];

function isPureApproval(text) {
  const raw = (text || '').trim().toLowerCase();
  if (!raw) return false;

  // Токенизация — чтобы "но" ловилось только как отдельное слово, а не как
  // часть другого слова (например "давно").
  const tokens = raw.split(/[^a-zа-яё0-9]+/i).filter(Boolean);
  if (tokens.some(t => REVISION_SIGNAL_WORDS.has(t))) return false;
  if (REVISION_SIGNAL_PHRASES.some(p => raw.includes(p))) return false;

  const clauses = raw
    .split(/[.,!;:\-—]+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!clauses.length) return false;
  return clauses.every(clause => PURE_APPROVAL_PHRASES.has(clause));
}

function formatAgentReplyForChat(state, output) {
  switch (state) {
    case 'SOPRANO_INTERVIEW': {
      const qs = output?.diagnostic_output?.clarification_needed?.questions
        || output?.planner_output?.clarification_needed?.questions || [];
      return qs.length ? qs.join('\n') : 'Уточните, пожалуйста, недостающие детали по сделке.';
    }
    case 'DIAGNOSING': {
      const diag = output?.diagnostic_output || output;
      const c = diag?.criteria_assessment || diag?.scores;
      if (!c) return JSON.stringify(diag, null, 2);
      const lines = Object.entries(c).map(([k, v]) => {
        const status = v?.status || v;
        const comment = v?.comment || v?.explanation || '';
        return `${k}: ${status}${comment ? ' — ' + comment : ''}`;
      });
      const conflicts = diag?.conflicts_explained || diag?.conflicts_with_manager || [];
      const conflictText = conflicts.length
        ? '\n\nРасхождения:\n' + conflicts.map(c => `${c.criterion}: ${getConflictExplanation(c)}`).join('\n')
        : '';
      return `Оценка по критериям СОПРАНО:\n${lines.join('\n')}${conflictText}`;
    }
    case 'CONFLICT_RESOLUTION': {
      const conflicts = output?.diagnostic_output?.conflicts_explained || [];
      return conflicts.map((c) => `${c.criterion}: ${getConflictExplanation(c)}\n${getConflictQuestion(c)}`).join('\n\n')
        || 'Есть расхождение между вашей оценкой и оценкой агента — уточните детали.';
    }
    case 'STRATEGY_SELECTION': {
      const s = output?.strategy_output;
      if (!s) return JSON.stringify(output, null, 2);
      const mainBlocker = getMainBlocker(s);
      const lines = [
        'Стратегия:\n' + renderKeyValueBlock(s.primary_strategy, STRATEGY_LABELS),
        mainBlocker ? `Блокер: ${mainBlocker}` : null,
        s.recommended_next_step ? `Следующий шаг: ${s.recommended_next_step}` : null,
        s.rationale ? `Обоснование: ${s.rationale}` : null,
      ].filter(Boolean);
      return lines.join('\n\n');
    }
    case 'COMPOSING': {
      const msgs = getComposerMessages(output?.composer_output);
      if (!msgs.length) {
        // Раньше здесь молча показывалась заглушка "ожидается проверка", даже если
        // на самом деле парсинг просто не смог найти messages в ответе composer-агента.
        // Показываем сырой ответ, чтобы увидеть реальную структуру и поправить парсинг.
        return `⚠️ Не удалось прочитать касания из ответа composer-агента.\n\nСырой ответ:\n${JSON.stringify(output?.composer_output, null, 2)}`;
      }
      return msgs.map((m, i) =>
        `Касание ${i + 1} — ${m.channel || ''}:\n${m.subject ? 'Тема: ' + m.subject + '\n' : ''}${m.body || ''}`
      ).join('\n\n---\n\n');
    }
    case 'REVIEWING': {
      const r = output?.reviewer_output;
      if (!r) return JSON.stringify(output, null, 2);
      const verdict = r.verdict || r?.reviewer_output?.verdict;

      if (!verdict) {
        // Раньше здесь показывалось "Результат проверки: —" без объяснений, если
        // r.verdict не находился. Показываем сырой ответ для диагностики.
        return `⚠️ Не удалось прочитать вердикт reviewer-агента.\n\nСырой ответ:\n${JSON.stringify(r, null, 2)}`;
      }

      if (verdict === 'ОДОБРЕНО') {
        const msgs = getComposerMessages(output?.composer_output);
        if (msgs.length) {
          const touchpoints = msgs.map((m, i) =>
            `Касание ${i + 1} — ${m.channel || ''}:\n${m.subject ? 'Тема: ' + m.subject + '\n' : ''}${m.body || ''}`
          ).join('\n\n---\n\n');
          return `✅ Касания одобрены:\n\n${touchpoints}`;
        }
      }

      const details = (r.messages_reviewed || r?.reviewer_output?.messages_reviewed || []).map(m =>
        `Касание ${m.touchpoint_number}: ${m.verdict}${m.failed_criteria?.length ? ' | Проблемы: ' + m.failed_criteria.join(', ') : ''}${m.fix_instructions ? '\nПравки: ' + m.fix_instructions : ''}`
      ).join('\n');
      return `Результат проверки: ${verdict}\n${details}`;
    }
    case 'ESCALATION':
      return 'После нескольких попыток автоматическая проверка не одобрила сообщение. Рекомендую составить касание вручную — последняя версия и причины показаны выше.';
    case 'LOST_DEAL':
      return output?._lostText || 'Сделка отмечена как потерянная.';
    case 'DISQUALIFICATION':
      return output?.diagnostic_output?.disqualification_reason || 'Сделка не квалифицирована.';
    case 'FINAL_OUTPUT':
      return output?._finalText || 'Сессия завершена.';
    case 'MEMORY_UPDATE':
      // Промежуточное состояние — до фикса сюда попадали "вхолостую" и показывали сырой JSON.
      // Теперь сюда практически не должны попадать (см. runMemoryUpdate), но на всякий случай
      // держим осмысленный текст, а не default-ветку с JSON.stringify.
      return output?._finalText || 'Формирую итог сессии...';
    default:
      return JSON.stringify(output, null, 2) || 'Обрабатываю...';
  }
}

// Если agentRunner не смог распарсить ответ модели (например, потому что модель
// обернула JSON в markdown-разметку ```json ... ```), он возвращает
// { raw_output: '...', parse_error: true } вместо нормального объекта.
// Раньше это тихо "протекало" дальше по цепочке: сломанный reviewer_output без
// verdict читался как "не одобрено", composer получал этот мусор как фидбэк и сам
// съезжал в свободный текст вместо JSON. Пытаемся восстановить JSON здесь же —
// снимаем обёртку ```json / ``` и парсим второй раз.
function tryRecoverFromRawOutput(result) {
  if (!result || typeof result !== 'object') return result;
  if (!result.parse_error || typeof result.raw_output !== 'string') return result;

  const cleaned = result.raw_output
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '');

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Не получилось (например, ответ действительно оборван) — возвращаем как было,
    // чтобы сработали существующие диагностические заглушки с сырым текстом.
    return result;
  }
}
// Запускает memory-агента и сразу собирает читаемый итог сессии.
// Используется во всех точках, где диалог завершается (одобрение, эскалация,
// потерянная сделка, дисквалификация) — чтобы не было промежуточного "пустого" хода,
// на котором раньше показывался сырой JSON.
async function runMemoryUpdate(dealId, baseInput, deal, extra = {}) {
  const strategyOutput = extra.strategy_output || deal.last_strategy_output;
  const composerOutput = extra.composer_output || deal.last_composer_output;
  const reviewerOutput = extra.reviewer_output || deal.last_reviewer_output;

  const memoryInput = {
    ...baseInput,
    strategy_output: strategyOutput,
    composer_output: composerOutput,
    reviewer_output: reviewerOutput
  };

  const memoryResult = tryRecoverFromRawOutput(await callAgent('memory', memoryInput, 6000));
  await db.saveMemory(dealId, memoryResult?.memory_output);

  return formatFinalSummary(memoryResult?.memory_output, strategyOutput, composerOutput, extra.statusNote);
}

// Логика приёма новой информации по сделке: planner → diagnostic → определение
// следующего состояния. Вынесена в отдельную функцию, чтобы её можно было
// вызвать не только из INIT/COLLECTING/SOPRANO_INTERVIEW, но и сразу же
// при старте новой сессии из FINAL_OUTPUT — без лишнего "пустого" хода.
async function runIntakeStep(baseInput) {
  const output = {};

  const plannerResult = tryRecoverFromRawOutput(await callAgent('planner', baseInput));
  output.planner_output = plannerResult?.planner_output;

  if (plannerResult?.planner_output?.clarification_needed?.required) {
    return { output, nextState: 'SOPRANO_INTERVIEW' };
  }

  const diagnosticResult = tryRecoverFromRawOutput(await callAgent('diagnostic', { ...baseInput, planner_output: output.planner_output }));
  output.diagnostic_output = diagnosticResult?.diagnostic_output || diagnosticResult;

  if (output.diagnostic_output?.clarification_needed?.required) {
    return { output, nextState: 'SOPRANO_INTERVIEW' };
  }
  if (output.diagnostic_output?.conflicts_require_confirmation) {
    return { output, nextState: 'CONFLICT_RESOLUTION' };
  }
  return { output, nextState: 'DIAGNOSING' };
}

// Один шаг машины состояний. managerInput — текст, который менеджер только что отправил.
async function advance(dealId, managerInput) {
  const deal = await db.getDeal(dealId);
  const memory = (await db.loadMemory(dealId)) || {
    session_number: 1, previous_touchpoints: [], confirmed_facts: [], open_questions: []
  };

  const allMessages = await db.getMessages(dealId);
  const dialogHistory = allMessages
    .filter(m => m.role === 'user' || m.role === 'agent')
    .map(m => `[${m.role === 'user' ? 'Менеджер' : 'Агент'}]: ${m.content}`)
    .join('\n\n');

  const baseInput = {
    deal: {
      client: deal.client,
      product: deal.product,
      deal_size: deal.deal_size,
      industry: deal.industry,
      last_contact: deal.last_contact,
      days_silent: deal.days_silent
    },
    materials: {
      correspondence: managerInput,
      dialog_history: dialogHistory,
      user_assessment: deal.criteria
    },
    memory
  };

  let nextState = deal.current_state;
  let output = {};

  switch (deal.current_state) {
    case 'INIT':
    case 'COLLECTING':
    case 'SOPRANO_INTERVIEW': {
      const result = await runIntakeStep(baseInput);
      output = result.output;
      nextState = result.nextState;
      break;
    }

    case 'DIAGNOSING': {
      const strategyInput = { ...baseInput, diagnostic_output: deal.last_diagnostic_output };
      const strategyResult = tryRecoverFromRawOutput(await callAgent('strategy', strategyInput));
      output.strategy_output = strategyResult?.strategy_output || strategyResult;

      if (output.strategy_output?.deal_health === 'потеряна') {
        output._finalText = await runMemoryUpdate(dealId, baseInput, deal, {
          strategy_output: output.strategy_output,
          statusNote: 'Статус: сделка отмечена как потерянная.'
        });
        nextState = 'FINAL_OUTPUT';
        break;
      }
      if (getStrategyName(output.strategy_output) === 'Disqualification') {
        output._finalText = await runMemoryUpdate(dealId, baseInput, deal, {
          strategy_output: output.strategy_output,
          statusNote: 'Статус: сделка не квалифицирована.'
        });
        nextState = 'FINAL_OUTPUT';
        break;
      }
      nextState = 'STRATEGY_SELECTION';
      break;
    }

    case 'CONFLICT_RESOLUTION': {
      const diagnosticResult = tryRecoverFromRawOutput(await callAgent('diagnostic', {
        ...baseInput,
        manager_conflict_response: { new_facts: managerInput }
      }));
      output.diagnostic_output = diagnosticResult?.diagnostic_output || diagnosticResult;
      nextState = 'DIAGNOSING';
      break;
    }

    case 'STRATEGY_SELECTION': {
      const composerInput = {
        ...baseInput,
        strategy_output: deal.last_strategy_output,
        channel_history: memory?.do_not_repeat?.channels_last_used?.slice(0, CONFIG.CHANNEL_HISTORY_SIZE) || [],
        message_length_limits: CONFIG.MAX_MESSAGE_LENGTH,
        iteration: 1
      };
      const composerResult = tryRecoverFromRawOutput(await callAgent('composer', composerInput, 5000));
      output.composer_output = composerResult?.composer_output || composerResult;
      nextState = 'COMPOSING';
      break;
    }

    case 'COMPOSING': {
      const composerOutput = { composer_output: deal.last_composer_output };
      const lengthCheck = validateMessageLength(composerOutput);
      const managerGaveFeedback = !isPureApproval(managerInput);

      if (!lengthCheck.valid) {
        // Техническое нарушение длины (channel_fit) — это отдельный источник
        // правок, независимый от того, что написал менеджер. Раньше эта проверка
        // стояла ПЕРЕД проверкой "согласие / фидбэк менеджера" и всегда обрывала
        // выполнение через break — из-за этого содержательный комментарий
        // менеджера ("используйте ещё сравнение по качеству сборки...") терялся,
        // даже если formatAgentReplyForChat потом красиво показывал "НА ДОРАБОТКУ".
        // Теперь оба источника фидбэка (длина + менеджер) объединяются в один
        // вызов composer, вместо того чтобы конкурировать за то, кто сработает первым.
        const iterations = (deal.composer_iterations || 1);
        const lengthFeedback = {
          verdict: 'НА ДОРАБОТКУ',
          messages_reviewed: lengthCheck.violations.map((v) => ({
            touchpoint_number: v.touchpoint,
            verdict: 'НА ДОРАБОТКУ',
            failed_criteria: ['channel_fit'],
            fix_instructions: `Сообщение для ${v.channel} слишком длинное: ${v.current}/${v.max} символов.`
          }))
        };

        if (iterations >= CONFIG.MAX_COMPOSER_ITERATIONS) {
          output.reviewer_output = lengthFeedback;
          nextState = 'ESCALATION';
          break;
        }

        const composerInput = {
          ...baseInput,
          strategy_output: deal.last_strategy_output,
          previous_composer_feedback: managerGaveFeedback
            ? { ...lengthFeedback, source: 'manager', manager_feedback: managerInput }
            : lengthFeedback,
          message_length_limits: CONFIG.MAX_MESSAGE_LENGTH,
          iteration: iterations + 1
        };
        const composerResult = tryRecoverFromRawOutput(await callAgent('composer', composerInput, 5000));
        output.composer_output = composerResult?.composer_output || composerResult;
        // Нарушение длины — техническая причина, поэтому итерацию считаем как обычно
        // (в отличие от чисто вкусового фидбэка менеджера ниже).
        output._composer_iterations = iterations + 1;
        nextState = 'COMPOSING';
        break;
      }

      // Если менеджер написал не просто "ок", а содержательный комментарий — это
      // правка, а не согласие. Возвращаем на доработку в composer с этим фидбэком,
      // вместо того чтобы молча отправлять неизменённый вариант на проверку reviewer'ом.
      if (managerGaveFeedback) {
        const iterations = (deal.composer_iterations || 1);
        const composerInput = {
          ...baseInput,
          strategy_output: deal.last_strategy_output,
          previous_composer_feedback: {
            source: 'manager',
            manager_feedback: managerInput
          },
          message_length_limits: CONFIG.MAX_MESSAGE_LENGTH,
          iteration: iterations
        };
        const composerResult = tryRecoverFromRawOutput(await callAgent('composer', composerInput, 5000));
        output.composer_output = composerResult?.composer_output || composerResult;
        // composer_iterations намеренно НЕ увеличиваем здесь — этот счётчик считает
        // автоматические доработки по вердикту reviewer'а (лимит MAX_COMPOSER_ITERATIONS).
        // Правки по инициативе менеджера не должны приближать эскалацию.
        nextState = 'COMPOSING';
        break;
      }

      // Ответ reviewer-агента — самый объёмный (чек-лист по ~10 пунктам на каждое
      // касание + подробные заметки). Без явного лимита он обрезался на дефолтном
      // значении agentRunner'а, JSON не закрывался и парсинг падал с parse_error —
      // отсюда "не удалось прочитать вердикт" при полностью корректном ответе агента.
      const reviewerResult = tryRecoverFromRawOutput(await callAgent('reviewer', {
        ...baseInput,
        strategy_output: deal.last_strategy_output,
        composer_output: deal.last_composer_output
      }, 8000));
      output.reviewer_output = reviewerResult?.reviewer_output || reviewerResult;
      nextState = 'REVIEWING';
      break;
    }

    case 'REVIEWING': {
      const approved = deal.last_reviewer_output?.verdict === 'ОДОБРЕНО';
      const iterations = (deal.composer_iterations || 1);

      if (approved) {
        // Раньше здесь просто ставился nextState = 'MEMORY_UPDATE' без выполнения
        // самой логики — из-за этого на следующем сообщении менеджера показывался
        // сырой "{}" (для 'MEMORY_UPDATE' не было своего case в formatAgentReplyForChat).
        // Теперь финализируем сессию сразу в этом же шаге.
        output._finalText = await runMemoryUpdate(dealId, baseInput, deal);
        nextState = 'FINAL_OUTPUT';
      } else if (iterations >= CONFIG.MAX_COMPOSER_ITERATIONS) {
        nextState = 'ESCALATION';
      } else {
        const composerInput = {
          ...baseInput,
          strategy_output: deal.last_strategy_output,
          previous_composer_feedback: deal.last_reviewer_output,
          message_length_limits: CONFIG.MAX_MESSAGE_LENGTH,
          iteration: iterations + 1
        };
        const composerResult = tryRecoverFromRawOutput(await callAgent('composer', composerInput, 5000));
        output.composer_output = composerResult?.composer_output || composerResult;
        output._composer_iterations = iterations + 1;
        nextState = 'COMPOSING';
      }
      break;
    }

    case 'ESCALATION':
    case 'MEMORY_UPDATE':
    case 'LOST_DEAL':
    case 'DISQUALIFICATION': {
      // Точка входа "на всякий случай" — если сделка когда-либо попала в одно из этих
      // состояний и ждёт следующего сообщения менеджера, финализируем сессию тут же.
      output._finalText = await runMemoryUpdate(dealId, baseInput, deal);
      nextState = 'FINAL_OUTPUT';
      break;
    }

    case 'FINAL_OUTPUT': {
      // Новая сессия по той же сделке. Раньше здесь просто сбрасывали state в INIT
      // и ничего не делали — первое сообщение менеджера уходило "вхолостую", и
      // реальная обработка (planner/diagnostic) начиналась только со следующего
      // сообщения. Теперь обрабатываем его сразу же.
      const result = await runIntakeStep(baseInput);
      output = result.output;
      nextState = result.nextState;
      break;
    }

    default:
      nextState = 'INIT';
  }

  // Сохранить промежуточные выходы агентов на сделке для следующего шага
  const statePatch = { current_state: nextState };
  if (output.diagnostic_output) statePatch.last_diagnostic_output = output.diagnostic_output;
  if (output.strategy_output) statePatch.last_strategy_output = output.strategy_output;
  if (output.composer_output) statePatch.last_composer_output = output.composer_output;
  if (output.reviewer_output) statePatch.last_reviewer_output = output.reviewer_output;
  if (output._composer_iterations) statePatch.composer_iterations = output._composer_iterations;

  if (output.diagnostic_output?.criteria_assessment) {
    const c = output.diagnostic_output.criteria_assessment;
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
  const chatText = formatAgentReplyForChat(nextState, output)
    || formatAgentReplyForChat(deal.current_state, output);

  return { nextState, chatText, raw: output };
}

function formatFinalSummary(memoryOutput, strategyOutput, composerOutput, statusNote) {
  if (!memoryOutput) return 'Сессия завершена.';
  const msgs = getComposerMessages(composerOutput);
  const mainBlocker = getMainBlocker(strategyOutput);

  const lines = [
    'ИТОГ СЕССИИ',
    statusNote || null,
    msgs.length ? 'КАСАНИЯ:\n' + msgs.map((m, i) =>
      `Касание ${i + 1} — ${m.channel}:\n${m.body}`
    ).join('\n\n---\n\n') : null,
    mainBlocker ? `Блокер: ${mainBlocker}` : null,
    strategyOutput?.primary_strategy ? 'Стратегия:\n' + renderKeyValueBlock(strategyOutput.primary_strategy, STRATEGY_LABELS) : null,
    msgs.length ? `Одобренные касания: ${msgs.length}` : null,
    memoryOutput.session_summary ? 'Резюме:\n' + renderKeyValueBlock(memoryOutput.session_summary, SESSION_SUMMARY_LABELS) : null
  ].filter(Boolean);
  return lines.join('\n\n');
}

module.exports = { advance };

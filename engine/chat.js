/**
 * engine/chat.js — как ответы агентов превращаются в текст для менеджера:
 * переводы названий и критериев, касания, вложения, итог сессии.
 * Только форматирование, без вызовов агентов и базы.
 */

// Достаёт массив касаний независимо от того, есть ли лишний уровень вложенности
// composer_output.composer_output.messages или нет.
function getComposerMessages(composerOutput) {
  return composerOutput?.messages || composerOutput?.composer_output?.messages || [];
}

// Баг №14: composer с версии с Правилом 11 генерирует поле attachment
// (полный текст документа, который упоминается в касании), но нигде в чате
// это поле не показывалось менеджеру — ни в самих касаниях, ни в финальном
// резюме сессии. Менеджеру приходилось самому писать текст документа,
// хотя он уже был сгенерирован агентом. Единая функция форматирования
// вложения используется во всех местах, где рендерится касание.
//
// После находки на реальном тесте (медиаплан с выдуманным трафиком и
// ложными ссылками на источники) Правило 11 в composer_agent.md изменено:
// Composer больше не обязан генерировать content любой ценой — если нужных
// данных нет во входных данных, он оставляет content = null и объясняет в
// manager_action_needed, что менеджеру нужно подготовить самому. Функция
// обрабатывает оба случая.
function formatAttachmentBlock(attachment) {
  if (!attachment) return '';
  const title = attachment.title || 'Документ';
  if (attachment.content) {
    const todo = attachment.manager_action_needed
      ? `\n\n⚠️ **Нужно дополнить перед отправкой:** ${attachment.manager_action_needed}`
      : '';
    return `\n\n📎 **${title}**\n${attachment.content}${todo}`;
  }
  if (attachment.manager_action_needed) {
    return `\n\n📎 **${title}** — черновик не сгенерирован, подготовьте самостоятельно:\n${attachment.manager_action_needed}`;
  }
  return '';
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

// rationale здесь намеренно не указан: это подробное многосоставное
// рассуждение агента для внутренней логики, не задумывалось как цельный
// текст для чтения менеджером (сплошной абзац без структуры). Вместо него
// показывается strategy_summary — отдельное поле, специально описанное в
// схеме strategy_agent.md как "краткое резюме на русском", но раньше нигде
// не рендерившееся. rationale исключается из объекта в withTranslatedStrategyName.
// То же, что renderKeyValueBlock, но пунктами с выделенными подписями:
// «- **Цель:** …». Разметку показывает фронтенд (агентские сообщения).
function renderKeyValueList(obj, labels = {}) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return String(obj);
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `- **${labels[k] || k}:** ${humanizeValue(v)}`)
    .join('\n');
}

// «Что важно клиенту» — триггеры из диагностики (24_client_triggers.md).
function formatClientTriggers(triggers) {
  if (!Array.isArray(triggers) || !triggers.length) return '';
  const items = triggers
    .filter((t) => t && t.trigger)
    .map((t) => {
      const evidence = t.evidence ? ` ${t.evidence}` : '';
      // «Марина (контактное лицо)» → «(Марина, контактное лицо)», без двойных скобок.
      const who = t.who ? ` (${String(t.who).replace(/\s*\(\s*/g, ', ').replace(/\)/g, '').trim()})` : '';
      return `- **${t.trigger}:**${evidence}${who}`;
    });
  return items.length ? `\n\n## Что важно клиенту\n\n${items.join('\n')}` : '';
}

// Ценность следующего шага из стратегии (value_focus).
function formatValueFocus(v) {
  if (!v || typeof v !== 'object') return null;
  const rows = [
    v.trigger && v.trigger !== 'не определён' ? `- **Через что подаём ценность:** ${v.trigger}` : null,
    v.for_contact ? `- **Контактному лицу:** ${v.for_contact}` : null,
    v.for_decision_maker ? `- **ЛПР:** ${v.for_decision_maker}` : null
  ].filter(Boolean);
  return rows.length ? `### Ценность для клиента\n\n${rows.join('\n')}` : null;
}

// Название канала для заголовка касания: агент пишет и «whatsapp», и «WhatsApp».
const CHANNEL_LABELS = {
  whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'Email', 'e-mail': 'Email',
  voice: 'Голосовое', 'кружок': 'Кружок (видео)', call_script: 'Звонок', call: 'Звонок', phone: 'Звонок', sms: 'SMS'
};
function channelLabel(channel) {
  if (!channel) return '';
  return CHANNEL_LABELS[String(channel).trim().toLowerCase()] || channel;
}

// Одно касание: заголовок с номером и каналом, тема, текст, вложение.
function formatTouchpoint(m, i) {
  const channel = m.channel ? ` · ${channelLabel(m.channel)}` : '';
  const subject = m.subject ? `**Тема:** ${m.subject}\n\n` : '';
  // Когда и при каком условии отправлять (например, «только если Марина дала
  // контакт Андрея»). Раньше менеджер этого не видел — живой тест 2026-11-13.
  const timing = m.timing ? `_Когда: ${String(m.timing).replace(/_/g, ' ').trim()}_\n\n` : '';
  return `### Касание ${i + 1}${channel}\n${timing}${subject}${m.body || ''}${formatAttachmentBlock(m.attachment)}`;
}

const STRATEGY_LABELS = { name: 'Название', goal: 'Цель' };

// Критерии ФОРМУЛЫ ЗАКРЫТИЯ (diagnostic_output.scores). До 2026-11-13 в чате
// это называлось «Оценка по СОПРАНО» — неверно: СОПРАНО — методика вопросов
// клиенту, а пять критериев — формула закрытия владельца (ФВ, ОП, ЛПР, Д, ЗС).
// Ключи в данных прежние (financial/need/…) — без миграции живых сделок.
const SOPRANO_CRITERIA_KEY_LABELS = {
  financial: 'ФВ — финансовая возможность',
  need: 'ОП — осознанная потребность',
  authority: 'ЛПР — определён',
  trust: 'Д — доверие',
  urgency: 'ЗС — здесь и сейчас'
};
const FORMULA_ORDER = ['financial', 'need', 'authority', 'trust', 'urgency'];

// СОПРАНО — только что не собрано и рекомендации менеджеру (не влияет на касания).
const SOPRANO_LETTERS = { 'С': 'Ситуация', 'О1': 'Опыт', 'П': 'Проблемы', 'Р': 'Решение', 'А': 'Аналоги', 'Н': 'Нюансы', 'О2': 'Ограничения' };
function formatSoprano(diag) {
  const s = diag?.soprano;
  const recs = Array.isArray(diag?.soprano_recommendations) ? diag.soprano_recommendations.filter(Boolean).slice(0, 3) : [];
  if ((!s || typeof s !== 'object') && !recs.length) return '';
  const gaps = s && typeof s === 'object'
    ? Object.entries(SOPRANO_LETTERS)
      .filter(([k]) => s[k] && !/^собран/i.test(String(s[k].status || '')))
      .map(([k, name]) => `${name}${s[k].status ? ` (${String(s[k].status).toLowerCase()})` : ''}`)
    : [];
  if (!gaps.length && !recs.length) return '\n\n**СОПРАНО:** сведения собраны.';
  const gapLine = gaps.length ? `\n\nНе собрано: ${gaps.join(', ')}.` : '';
  const recLines = recs.length ? `\n\nРекомендую уточнить у клиента:\n${recs.map((r) => `- ${r}`).join('\n')}` : '';
  return `\n\n### СОПРАНО — что уточнить${gapLine}${recLines}`;
}

function translateCriterionKey(key) {
  return SOPRANO_CRITERIA_KEY_LABELS[key] || key;
}

// Стратегический агент называет primary_strategy.name внутренним английским
// кодовым именем (традиция методологии продаж — RiskReduction,
// StakeholderExpansion и т.п.) — это утекало менеджеру в чат как есть.
// Правильное решение — поправить сам strategy_agent.md (промпт агента),
// но его нет в этом пакете передачи. Это защитный слой на уровне рендеринга:
// известные названия переводим сразу, неизвестные — логируем, чтобы словарь
// пополнялся, а не переводим "на глаз" то, чего не видели на реальных выводах.
const STRATEGY_NAME_RU = {
  Diagnostic: 'Диагностика потребности',
  StakeholderExpansion: 'Охват всех участников решения',
  EconomicValue: 'Экономическое обоснование',
  RiskReduction: 'Снижение риска',
  Activation: 'Активация срочности',
  Escalation: 'Эскалация',
  DirectConversation: 'Прямой разговор',
  Disqualification: 'Дисквалификация',
  // Встречались в реальных выводах агента до унификации словаря — оставлены
  // для обратной совместимости с уже сохранёнными в БД сделками.
  SoftNurture: 'Мягкое сопровождение',
  'Soft Nurture': 'Мягкое сопровождение',
  TrustBuilding: 'Построение доверия',
  'Trust Building': 'Построение доверия'
};

function translateStrategyName(name) {
  if (typeof name !== 'string' || !name) return name;
  if (/[а-яА-ЯёЁ]/.test(name)) return name; // уже по-русски — не трогаем
  if (STRATEGY_NAME_RU[name]) return STRATEGY_NAME_RU[name];
  console.warn(
    `[strategy] Неизвестное английское название стратегии "${name}" — нет перевода в STRATEGY_NAME_RU. ` +
    `Показано менеджеру без перевода, добавьте перевод в словарь.`
  );
  return name;
}

function withTranslatedStrategyName(primaryStrategy) {
  if (!primaryStrategy || typeof primaryStrategy !== 'object') return primaryStrategy;
  // rationale исключён из показа менеджеру намеренно (см. комментарий у
  // STRATEGY_LABELS) — здесь его явно убираем из объекта, а не полагаемся
  // на отсутствие в STRATEGY_LABELS: renderKeyValueBlock рендерит ВСЕ ключи
  // объекта, labels влияют только на подпись найденного ключа, а не на то,
  // показывать поле или нет.
  const { rationale, ...rest } = primaryStrategy;
  return { ...rest, name: translateStrategyName(primaryStrategy.name) };
}

// Технические коды критериев reviewer'а (используются во внутренних полях
// checklist / failed_criteria) — не предназначены для показа человеку как есть.
// Раньше failed_criteria выводился в чат сырыми английскими идентификаторами
// (например "no_pressure, tone_fit"), что было непонятно менеджеру. Теперь
// переводим каждый код на русский перед показом.
const CRITERIA_LABELS = {
  new_value: 'нет новой ценности',
  single_goal: 'несколько целей в одном сообщении',
  strategy_alignment: 'не соответствует выбранной стратегии',
  blocker_addressed: 'не работает на главный блокер',
  no_pressure: 'создаёт давление на клиента',
  no_stop_words: 'содержит запрещённую фразу',
  personalization: 'недостаточно персонализировано',
  clear_next_step: 'нет чёткого следующего шага',
  channel_fit: 'не соответствует формату канала',
  not_repetitive: 'повторяет предыдущее касание',
  tone_fit: 'тон не соответствует типу клиента',
  attachment_honesty: 'вложение содержит недостоверные данные или создаёт риск завышенного ожидания',
  broken_trust_protocol: 'не соблюдён протокол при сломанном доверии клиента (нет независимого подтверждения или явного права на отказ)',
  client_value: 'не показана ценность для клиента (что даёт следующий шаг адресату)',
  must_include: 'не выполнен обязательный пункт сделки',
  schedule: 'касание уходит позже срока, который в нём назван',
  alternation: 'два экспертных или два эмпатичных касания подряд'
};

// Переводит список технических кодов в читаемую строку через запятую.
// Код, отсутствующий в словаре (например, если промпт вернёт что-то новое),
// показываем как есть — лучше показать сырой код, чем молча его скрыть.
function translateCriteria(codes) {
  if (!Array.isArray(codes) || !codes.length) return '';
  return codes.map((c) => CRITERIA_LABELS[c] || c).join(', ');
}

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

// После правки strategy_agent.md (перевод primary_strategy.name на русский)
// агент теперь отдаёт "Дисквалификация" вместо "Disqualification". Раньше
// код сравнивал getStrategyName(...) === 'Disqualification' напрямую — при
// обновлении промпта это сравнение молча перестало бы срабатывать, и
// дисквалификация сделок сломалась бы без единой ошибки в логах. Проверяем
// оба варианта — и новый русский (основной, актуальный), и старый английский
// (на случай, если где-то в БД/памяти остался last_strategy_output,
// сохранённый до деплоя этого фикса).
function isDisqualificationStrategy(strategyOutput) {
  const name = getStrategyName(strategyOutput);
  return name === 'Дисквалификация' || name === 'Disqualification';
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


function formatAgentReplyForChat(state, output) {
  switch (state) {
    case 'SOPRANO_INTERVIEW': {
      const qs = output?.diagnostic_output?.clarification_needed?.questions
        || output?.planner_output?.clarification_needed?.questions || [];
      return qs.length
        ? `## Нужно уточнить\n\n${qs.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
        : 'Уточните, пожалуйста, недостающие детали по сделке.';
    }
    case 'DIAGNOSING': {
      const diag = output?.diagnostic_output || output;
      const c = diag?.criteria_assessment || diag?.scores;
      if (!c) return JSON.stringify(diag, null, 2);
      const ordered = [...FORMULA_ORDER.filter((k) => k in c), ...Object.keys(c).filter((k) => !FORMULA_ORDER.includes(k))];
      const lines = ordered.map((k) => [k, c[k]]).map(([k, v]) => {
        const status = v?.status || v;
        const comment = v?.comment || v?.explanation || '';
        return `- **${translateCriterionKey(k)}:** ${status}${comment ? ' — ' + comment : ''}`;
      });
      const conflicts = diag?.conflicts_explained || diag?.conflicts_with_manager || [];
      const conflictText = conflicts.length
        ? '\n\n## Расхождения с вашей оценкой\n\n' + conflicts.map(c => `- **${translateCriterionKey(c.criterion)}:** ${getConflictExplanation(c)}`).join('\n')
        : '';
      const summary = typeof diag?.diagnostic_summary === 'string' && diag.diagnostic_summary.trim()
        ? `\n\n**Вывод:** ${diag.diagnostic_summary.trim()}`
        : '';
      return `## Формула закрытия\n\n${lines.join('\n')}${formatClientTriggers(diag?.client_triggers)}${summary}${formatSoprano(diag)}${conflictText}`;
    }
    case 'CONFLICT_RESOLUTION': {
      // Баг №32: раньше здесь читалось только conflicts_explained — поля с
      // таким именем нет в схеме diagnostic_agent.md, есть только
      // conflicts_with_manager (тот же фоллбэк уже стоит в кейсе DIAGNOSING
      // чуть выше). Из-за бага №31 (CONFLICT_RESOLUTION была недостижима)
      // это оставалось незамеченным — конфликты сразу проваливались в
      // безликий дефолтный текст, вместо реальных criterion/reason из
      // диагностики.
      const conflicts = output?.diagnostic_output?.conflicts_explained || output?.diagnostic_output?.conflicts_with_manager || [];
      const items = conflicts.map((c) => `- **${translateCriterionKey(c.criterion)}:** ${getConflictExplanation(c)}\n\n**Вопрос:** ${getConflictQuestion(c)}`);
      return items.length
        ? `## Ваша оценка расходится с оценкой агента\n\n${items.join('\n\n')}`
        : 'Есть расхождение между вашей оценкой и оценкой агента — уточните детали.';
    }
    case 'STRATEGY_SELECTION': {
      const s = output?.strategy_output;
      if (!s) return JSON.stringify(output, null, 2);
      const mainBlocker = getMainBlocker(s);
      const lines = [
        '## Стратегия\n\n' + renderKeyValueList(withTranslatedStrategyName(s.primary_strategy), STRATEGY_LABELS),
        formatValueFocus(s.value_focus),
        Array.isArray(s.must_include) && s.must_include.length
          ? `### Обязательно в касаниях\n\n${s.must_include.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
          : null,
        mainBlocker ? `**Главный блокер:** ${mainBlocker}` : null,
        // Баг №30: раньше здесь читалось s.recommended_next_step, а схема
        // strategy_agent.md отдаёт поле "recommended_next_action" — из-за
        // рассогласования имени поле никогда не рендерилось менеджеру,
        // хотя агент каждый раз генерирует конкретный следующий шаг.
        s.recommended_next_action ? `**Следующий шаг:** ${s.recommended_next_action}` : null,
        // Баг №29: раньше здесь стояло "s.rationale ? ... : s.strategy_summary",
        // что выглядело как предпочтение rationale — но по схеме rationale
        // лежит ВНУТРИ primary_strategy, а не на верхнем уровне strategy_output,
        // так что ветка была мёртвой (и вводящей в заблуждение). Показываем
        // только strategy_summary явно, как и было решено в сессии 3 для
        // formatFinalSummary().
        s.strategy_summary ? `**Обоснование:** ${s.strategy_summary}` : null,
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
      const touches = msgs.map(formatTouchpoint).join('\n\n---\n\n');
      const check = output?.composer_output?._check;
      if (!check) {
        // Касания составлены до автоцикла (старые сделки).
        return touches + '\n\n---\n\n_Напишите «ок» — проверю и при необходимости доработаю касания. Или пришлите правку._';
      }
      if (check.approved) {
        return `## ✅ Касания проверены\n\n${touches}\n\n---\n\n_«ок» — сохранить итог сессии. Если что-то поправить — напишите, доработаю и проверю снова._`;
      }
      // Не все касания прошли проверку за отведённые круги — показываем, что осталось.
      const r = output?.reviewer_output?.messages_reviewed ? output.reviewer_output : output?.reviewer_output?.reviewer_output;
      const left = (r?.messages_reviewed || []).filter((m) => m?.verdict && m.verdict !== 'ОДОБРЕНО');
      const notes = left.length
        ? left.map((m) => `- **Касание ${m.touchpoint_number}:** ${m.fix_instructions || translateCriteria(m.failed_criteria) || 'не принято проверкой'}`).join('\n')
        : '- проверка не дала вердикт';
      return `${touches}\n\n---\n\n### Проверка приняла не всё\n\n${notes}\n\n_Клоузер сделал ${check.rounds} ${check.rounds === 1 ? 'вариант' : check.rounds < 5 ? 'варианта' : 'вариантов'} и проверил каждый. Напишите, как поправить, — доработаю и проверю снова. Или «ок», чтобы принять как есть._`;
    }
    case 'REVIEWING': {
      const r = output?.reviewer_output;
      if (!r) return JSON.stringify(output, null, 2);
      const verdict = r.verdict || r?.reviewer_output?.verdict;
      if (!verdict) {
        // Вердикт не прочитан (чаще всего ответ обрезан по длине). Сырой
        // ответ менеджеру не показываем — он есть в логах. Замечания reviewer'а
        // всё равно уйдут в composer: следующий ход запускает доработку
        // с last_reviewer_output (там и сырой текст замечаний).
        return '⚠️ Проверка не смогла выдать вердикт (ответ проверяющего не прочитан). ' +
          'Касания не отправлены.\n\n_Напишите любое сообщение — касания будут доработаны по замечаниям проверки._';
      }
      if (verdict === 'ОДОБРЕНО') {
        const msgs = getComposerMessages(output?.composer_output);
        if (msgs.length) {
          const touchpoints = msgs.map(formatTouchpoint).join('\n\n---\n\n');
          return `## ✅ Касания одобрены\n\n${touchpoints}`;
        }
      }
      const details = (r.messages_reviewed || r?.reviewer_output?.messages_reviewed || []).map(m => {
        const problems = m.failed_criteria?.length ? `\n  Проблемы: ${translateCriteria(m.failed_criteria)}` : '';
        const fixes = m.fix_instructions ? `\n  Правки: ${m.fix_instructions}` : '';
        return `- **Касание ${m.touchpoint_number}:** ${m.verdict}${problems}${fixes}`;
      }).join('\n');
      const next = verdict === 'ОДОБРЕНО' ? '' : '\n\n_Следующее сообщение запустит доработку касаний._';
      return `## Проверка: ${verdict}\n\n${details}${next}`;
    }
    case 'ESCALATION':
      return 'После нескольких попыток автоматическая проверка не одобрила касания — последняя версия и причины показаны выше.\n\n_Напишите, что поправить (или «по замечаниям проверки»), — доработаю ещё раз. Или «закрыть», чтобы оставить как есть._';
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

function formatFinalSummary(memoryOutput, strategyOutput, composerOutput, statusNote) {
  if (!memoryOutput) return 'Сессия завершена.';
  const msgs = getComposerMessages(composerOutput);
  const mainBlocker = getMainBlocker(strategyOutput);
  const lines = [
    '## Итог сессии',
    statusNote || null,
    memoryOutput.session_summary ? '### Резюме\n\n' + renderKeyValueList(memoryOutput.session_summary, SESSION_SUMMARY_LABELS) : null,
    mainBlocker ? `**Главный блокер:** ${mainBlocker}` : null,
    strategyOutput?.primary_strategy ? '### Стратегия\n\n' + renderKeyValueList(withTranslatedStrategyName(strategyOutput.primary_strategy), STRATEGY_LABELS) : null,
    strategyOutput?.strategy_summary ? `**Обоснование:** ${strategyOutput.strategy_summary}` : null,
    msgs.length ? `## Касания (${msgs.length})\n\n` + msgs.map(formatTouchpoint).join('\n\n---\n\n') : null
  ].filter(Boolean);
  return lines.join('\n\n');
}

// Блок «Сроки» под диагностикой: расчёт кодом (engine/timeline.js), а не моделью.
const TIMELINE_STATUS_LABEL = { 'с запасом': 'УСПЕВАЕМ', 'впритык': 'ВПРИТЫК', 'не успеваем': 'НЕ УСПЕВАЕМ', 'дата прошла': 'ПРОВЕРЬТЕ ДАТУ' };
function formatTimeline(timeline) {
  if (!timeline) {
    return '\n\n_Сроки не посчитаны: в сделке не указаны дата, к которой нужно клиенту, и срок производства. Нажмите «Сроки» в шапке сделки, заполните и сохраните — расчёт появится в чате._';
  }
  const label = TIMELINE_STATUS_LABEL[timeline.status] || timeline.status;
  return `\n\n## Сроки — ${label}\n\n${timeline.summary}\n\n_${timeline.rules.split('.')[0]}._`;
}

module.exports = {
  formatTimeline,
  getComposerMessages,
  isDisqualificationStrategy,
  formatAgentReplyForChat,
  formatFinalSummary,
};

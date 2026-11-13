/**
 * tests/scenarios.js — сценарии для снимков (tests/snapshots.test.js).
 *
 * Каждый сценарий проходит по реальным веткам stateMachine.js: стартовая
 * сделка → сообщения менеджера → заранее заданные ответы агентов.
 * Содержание ответов агентов условное, но форма — как в схемах agents/*.md,
 * чтобы проверялось и то, как ответы превращаются в текст для менеджера.
 *
 * Покрыто: полный цикл до итога и новая сессия, уточняющие вопросы и их
 * лимит, расхождение с менеджером, потерянная сделка, дисквалификация,
 * правка и вопрос менеджера по касаниям, доработки reviewer'а до эскалации,
 * ручные попытки после эскалации и их лимит, превышение длины, команда
 * «заверши сессию», восстановление ответа в обёртке ```json.
 */

const BASE_DEAL = {
  client: 'СтройДвор',
  product: 'вывеска на фасад',
  deal_size: 420000,
  industry: 'signage',
  last_contact: '2026-07-15',
  days_silent: 4,
  criteria: { financial: '', need: '', trust: '', authority: '', urgency: '' },
};

// ---------- типовые ответы агентов ----------
const planner = (clarify = false) => ({
  planner_output: {
    data_quality: { level: 'средний' },
    deal_context: { stage: 'после КП' },
    diagnostic_priorities: ['authority', 'urgency'],
    flags: [],
    agent_chain: ['diagnostic', 'strategy', 'composer', 'reviewer'],
    clarification_needed: clarify
      ? { required: true, questions: ['Кто принимает решение о покупке?', 'Есть ли срок открытия магазина?'] }
      : { required: false, questions: [] },
    planner_notes: 'тест',
  },
});

// Форма — как в разделе «ВЫХОДНЫЕ ДАННЫЕ» agents/diagnostic_agent.md.
const scores = {
  financial: { status: 'Подтверждено', evidence: ['бюджет 420 тыс согласован'], confidence: 'high' },
  need: { status: 'Подтверждено', evidence: ['открытие магазина'], confidence: 'high' },
  trust: { status: 'Вероятно', evidence: ['одна встреча'], confidence: 'medium' },
  authority: { status: 'Неизвестно', evidence: [], confidence: 'low' },
  urgency: { status: 'Вероятно', evidence: ['срок размыт'], confidence: 'medium' },
};

const diagnostic = ({ clarify = false, conflicts = [] } = {}) => ({
  diagnostic_output: {
    scores,
    primary_blocker: { criterion: 'authority', reason: 'ЛПР не выявлен', evidence: [] },
    patterns_detected: [],
    conflicts_with_manager: conflicts,
    clarification_needed: clarify
      ? { required: true, questions: ['Кто подписывает договор?'] }
      : { required: false, questions: [] },
    diagnostic_summary: 'бюджет есть, ЛПР не выявлен',
  },
});

const strategy = (overrides = {}) => ({
  strategy_output: {
    deal_health: 'под риском',
    primary_strategy: { name: 'Охват всех участников решения', goal: 'выйти на ЛПР' },
    main_blocker: 'ЛПР не участвует в переговорах',
    recommended_next_action: 'предложить встречу с собственником',
    strategy_summary: 'без ЛПР сделка не двинется',
    ...overrides,
  },
});

const composer = (label, body) => ({
  composer_output: {
    messages: [
      { touchpoint_number: 1, kind: 'эмпатичное', channel: 'whatsapp', body: body || `Касание ${label}: Иван, добрый день! Предлагаю созвониться с собственником в четверг.` },
      { touchpoint_number: 2, kind: 'экспертное', channel: 'email', subject: `Тема ${label}`, body: `Письмо ${label}: материалы по монтажу во вложении.`, attachment: { title: 'График монтажа', content: 'неделя 1 — замер, неделя 2 — монтаж' } },
    ],
  },
});

const reviewer = (verdict) => ({
  reviewer_output: {
    verdict,
    messages_reviewed: [
      verdict === 'ОДОБРЕНО'
        ? { touchpoint_number: 1, verdict: 'ОДОБРЕНО', failed_criteria: [] }
        : { touchpoint_number: 1, verdict: 'НА ДОРАБОТКУ', failed_criteria: ['personalization'], fix_instructions: 'добавить имя и факт из переписки' },
    ],
  },
});

const memory = (n = 1) => ({
  memory_output: {
    session_number: n,
    previous_touchpoints: [],
    confirmed_facts: ['бюджет согласован'],
    open_questions: ['кто ЛПР'],
    session_summary: {
      session_number: n,
      session_date: '2026-07-19',
      what_we_know: 'бюджет есть, ЛПР неизвестен',
      what_blocks: 'нет выхода на собственника',
      what_was_done: 'подготовлены касания',
      what_is_next: 'встреча с собственником',
      key_insight: 'решает собственник',
    },
  },
});

const advisor = { advisor_output: { answer: 'Ответьте, что цена включает монтаж и гарантию 3 года.' } };

// Состояние сделки «касания уже показаны менеджеру».
const AT_COMPOSING = {
  ...BASE_DEAL,
  current_state: 'COMPOSING',
  last_diagnostic_output: diagnostic().diagnostic_output,
  last_strategy_output: strategy().strategy_output,
  last_composer_output: composer('A').composer_output,
  composer_iterations: 1,
};

const AT_COMPOSING_CHECKED = {
  ...AT_COMPOSING,
  last_composer_output: { ...composer('A').composer_output, _check: { approved: true, rounds: 1, reviews: 1 } },
  last_reviewer_output: reviewer('ОДОБРЕНО').reviewer_output,
};

module.exports = [
  {
    name: 'full_cycle_and_new_session',
    description: 'INIT → диагностика → стратегия → касания → одобрение → итог; затем новая сессия с уточняющими вопросами',
    deal: { ...BASE_DEAL, current_state: 'INIT' },
    agents: {
      planner: [planner(false), planner(true)],
      diagnostic: [diagnostic()],
      strategy: [strategy()],
      composer: [composer('A')],
      reviewer: [reviewer('ОДОБРЕНО')],
      memory: [memory(1)],
    },
    messages: [
      'Переписка: клиент просит КП на вывеску, бюджет 420 тыс согласован, решение за собственником.',
      'дальше',
      'дальше',
      'ок',
      'Клиент вернулся: хочет обсудить сроки.',
    ],
  },
  {
    name: 'soprano_interview_round_limit',
    description: 'Уточняющие вопросы: planner, затем diagnostic просят уточнить; на 3-м раунде лимит — переход в DIAGNOSING с пометкой',
    deal: { ...BASE_DEAL, current_state: 'INIT' },
    agents: {
      planner: [planner(true), planner(false), planner(false)],
      diagnostic: [diagnostic({ clarify: true }), diagnostic({ clarify: true })],
    },
    messages: [
      'Клиент интересуется вывеской.',
      'Решение принимает директор.',
      'Срок — к открытию в сентябре.',
    ],
  },
  {
    name: 'conflict_resolution',
    description: 'Диагностика расходится с самооценкой менеджера → CONFLICT_RESOLUTION → уточнение → DIAGNOSING',
    deal: { ...BASE_DEAL, current_state: 'INIT', manager_criteria: { financial: 'Подтверждено', need: '', trust: '', authority: 'Подтверждено', urgency: '' } },
    agents: {
      planner: [planner(false)],
      diagnostic: [
        diagnostic({ conflicts: [{ criterion: 'authority', manager_assessment: 'Подтверждено', agent_assessment: 'Неизвестно', reason: 'в переписке нет подтверждения, что собеседник — ЛПР' }] }),
        diagnostic(),
      ],
    },
    messages: [
      'Переписка с менеджером закупок, говорит что всё согласовано.',
      'Подписывает генеральный, закупщик только собирает КП.',
    ],
  },
  {
    name: 'no_manager_assessment_is_not_conflict',
    description: 'Новая сделка без самооценки менеджера: запись «менеджер не указал оценку» в conflicts_with_manager не уводит в CONFLICT_RESOLUTION и не показывается как расхождение',
    deal: { ...BASE_DEAL, current_state: 'INIT' },
    agents: {
      planner: [planner(false)],
      diagnostic: [
        diagnostic({ conflicts: [{ criterion: 'Все критерии', manager_assessment: 'Не указана', agent_assessment: 'Восстановлено из переписки', reason: 'Менеджер не указал свою оценку ни по одному из пяти критериев. Сравнить позиции не получилось.' }] }),
      ],
    },
    messages: ['Переписка: клиент просит КП на вывеску, бюджет согласован, решение за собственником.'],
  },
  {
    name: 'agent_is_not_compared_with_itself',
    description: 'Вторая диагностика: в deals.criteria уже оценка агента, самооценки менеджера нет — агенту уходит пустая самооценка, записи «расхождение»/«совпадают» не показываются',
    deal: { ...BASE_DEAL, current_state: 'CONFLICT_RESOLUTION', criteria: { financial: 'Вероятно', need: 'Подтверждено', trust: 'Вероятно', authority: 'Риск', urgency: 'Риск' } },
    agents: {
      diagnostic: [
        diagnostic({ conflicts: [
          { criterion: 'Срочность', manager_assessment: 'Риск', agent_assessment: 'Подтверждено', reason: 'клиент назвал дату открытия' },
          { criterion: 'Потребность', manager_assessment: 'Подтверждено', agent_assessment: 'Подтверждено', reason: 'Оценки совпадают. Расхождений нет.' },
        ] }),
      ],
    },
    messages: ['Свою оценку не давал, ориентируйся на переписку'],
  },
  {
    name: 'real_conflict_keeps_only_disagreements',
    description: 'Менеджер дал самооценку: настоящее расхождение остаётся, запись «оценки совпадают» убирается',
    deal: { ...BASE_DEAL, current_state: 'INIT', manager_criteria: { financial: 'Подтверждено', need: 'Подтверждено', trust: '', authority: 'Подтверждено', urgency: '' } },
    agents: {
      planner: [planner(false)],
      diagnostic: [
        diagnostic({ conflicts: [
          { criterion: 'ЛПР', manager_assessment: 'Подтверждено', agent_assessment: 'Неизвестно', reason: 'в переписке нет подтверждения, что собеседник — ЛПР' },
          { criterion: 'Потребность', manager_assessment: 'Подтверждено', agent_assessment: 'Подтверждено', reason: 'Оценки совпадают.' },
        ] }),
      ],
    },
    messages: ['Переписка с менеджером закупок, говорит что всё согласовано.'],
  },
  {
    name: 'client_triggers_and_value_focus',
    description: 'Диагностика показывает «Что важно клиенту» (триггеры с цитатой), стратегия — «Ценность для клиента» (value_focus)',
    deal: { ...BASE_DEAL, current_state: 'INIT' },
    agents: {
      planner: [planner(false)],
      diagnostic: [{
        diagnostic_output: {
          ...diagnostic().diagnostic_output,
          client_triggers: [
            { trigger: 'Надёжность', who: 'Марина', evidence: '«успеете ли к 1 декабря?»' },
            { trigger: 'Тщеславие', who: 'Марина', evidence: '«нужна вывеска как на первой точке»' },
          ],
        },
      }],
      strategy: [strategy({
        value_focus: {
          trigger: 'Надёжность',
          for_contact: 'не пересказывать КП собственнику и не отвечать за неточности',
          for_decision_maker: 'вторая точка открывается в срок уже с вывеской, гости узнают бренд',
          facts_to_use: ['своё производство → срок зависит только от нас'],
        },
      })],
    },
    messages: ['Переписка: клиент просит вывеску к открытию 1 декабря, как на первой точке.', 'дальше'],
  },
  {
    name: 'lost_deal',
    description: 'Стратегия признаёт сделку потерянной → итог сессии',
    deal: { ...BASE_DEAL, current_state: 'DIAGNOSING', last_diagnostic_output: diagnostic().diagnostic_output },
    agents: {
      strategy: [strategy({ deal_health: 'потеряна', primary_strategy: { name: 'Закрытие', goal: 'зафиксировать причину' } })],
      memory: [memory(1)],
    },
    messages: ['дальше'],
  },
  {
    name: 'disqualification',
    description: 'Стратегия «Дисквалификация» → итог сессии',
    deal: { ...BASE_DEAL, current_state: 'DIAGNOSING', last_diagnostic_output: diagnostic().diagnostic_output },
    agents: {
      strategy: [strategy({ primary_strategy: { name: 'Дисквалификация', goal: 'не тратить время' } })],
      memory: [memory(1)],
    },
    messages: ['дальше'],
  },
  {
    name: 'composing_manager_edit_and_question',
    description: 'Касания проверены. Правка → composer + проверка в том же ходе; вопрос → advisor и «скорректировать?»; непонятный ответ → переспрос; «да» → composer + проверка; «нет» на второй вопрос',
    deal: AT_COMPOSING_CHECKED,
    agents: {
      composer: [composer('B'), composer('C')],
      reviewer: [reviewer('ОДОБРЕНО'), reviewer('ОДОБРЕНО')],
      advisor: [advisor, advisor],
    },
    messages: [
      'слишком в лоб, смягчи первое касание',
      'что ответить, если скажут что дорого?',
      'подумаю',
      'да',
      'может предложить скидку?',
      'нет',
    ],
  },
  {
    name: 'auto_rework_until_approved',
    description: 'Автоцикл: «ок» на стратегию → composer → reviewer НА ДОРАБОТКУ → composer → reviewer ОДОБРЕНО — всё в одном ходе; «ок» → итог',
    deal: { ...BASE_DEAL, current_state: 'STRATEGY_SELECTION', last_diagnostic_output: diagnostic().diagnostic_output, last_strategy_output: strategy().strategy_output },
    agents: {
      composer: [composer('A'), composer('B')],
      reviewer: [reviewer('НА ДОРАБОТКУ'), reviewer('ОДОБРЕНО')],
      memory: [memory(1)],
    },
    messages: ['ок', 'ок'],
  },
  {
    name: 'auto_loop_shows_notes_when_not_approved',
    description: 'Автоцикл: проверка трижды не приняла → менеджер видит касания и что осталось; «ок» → итог с пометкой',
    deal: { ...BASE_DEAL, current_state: 'STRATEGY_SELECTION', last_diagnostic_output: diagnostic().diagnostic_output, last_strategy_output: strategy().strategy_output },
    agents: {
      composer: [composer('A'), composer('B'), composer('C')],
      reviewer: [reviewer('НА ДОРАБОТКУ'), reviewer('НА ДОРАБОТКУ'), reviewer('НА ДОРАБОТКУ')],
      memory: [memory(1)],
    },
    messages: ['ок', 'ок'],
  },
  {
    name: 'rework_keeps_approved_touches',
    description: 'Автоцикл: reviewer одобрил касание 1 и вернул 2; composer на доработке переписал оба — код возвращает одобренное касание 1 дословно',
    deal: { ...BASE_DEAL, current_state: 'STRATEGY_SELECTION', last_diagnostic_output: diagnostic().diagnostic_output, last_strategy_output: strategy().strategy_output },
    agents: {
      composer: [composer('A'), composer('B')],
      reviewer: [{
        reviewer_output: {
          verdict: 'НА ДОРАБОТКУ',
          messages_reviewed: [
            { touchpoint_number: 1, verdict: 'ОДОБРЕНО', failed_criteria: [] },
            { touchpoint_number: 2, verdict: 'НА ДОРАБОТКУ', failed_criteria: ['client_value'], fix_instructions: 'добавить выгоду для ЛПР' },
          ],
        },
      }, reviewer('ОДОБРЕНО')],
    },
    messages: ['ок'],
  },
  {
    name: 'escalation_manual_retry_then_close',
    description: 'Старая сделка в ESCALATION: правка → «доработать?» → непонятный ответ → «да» → автоцикл (composer + проверка) → «ок» → итог',
    deal: {
      ...AT_COMPOSING,
      current_state: 'ESCALATION',
      composer_iterations: 3,
      last_reviewer_output: reviewer('НА ДОРАБОТКУ').reviewer_output,
      escalation_retries: 0,
    },
    agents: {
      composer: [composer('D')],
      reviewer: [reviewer('ОДОБРЕНО')],
      memory: [memory(1)],
    },
    messages: ['добавь цифры по срокам монтажа', 'хм', 'да', 'ок'],
  },
  {
    name: 'escalation_retry_limit',
    description: 'ESCALATION с исчерпанными ручными попытками: «да» → итог с пометкой о лимите',
    deal: {
      ...AT_COMPOSING,
      current_state: 'ESCALATION',
      composer_iterations: 5,
      escalation_retries: 2,
      awaiting_escalation_confirmation: true,
      pending_escalation_feedback: 'добавь цифры',
    },
    agents: { memory: [memory(1)] },
    messages: ['да'],
  },
  {
    name: 'message_length_violation',
    description: 'Автоцикл: касание длиннее лимита канала → проверка кода → composer сокращает БЕЗ вызова reviewer → reviewer одобряет',
    deal: { ...BASE_DEAL, current_state: 'STRATEGY_SELECTION', last_diagnostic_output: diagnostic().diagnostic_output, last_strategy_output: strategy().strategy_output },
    agents: {
      composer: [composer('LONG', 'Очень длинное сообщение. '.repeat(30)), composer('E')],
      reviewer: [reviewer('ОДОБРЕНО')],
    },
    messages: ['ок'],
  },
  {
    name: 'legacy_unchecked_touches_ok_runs_check',
    description: 'Старая сделка: касания составлены до автоцикла → «ок» сначала проверяет их (без переписывания), потом «ок» → итог',
    deal: AT_COMPOSING,
    agents: { reviewer: [reviewer('ОДОБРЕНО')], memory: [memory(1)] },
    messages: ['ок', 'ок'],
  },
  {
    name: 'end_session_command',
    description: '«заверши сессию» посреди уточняющих вопросов → итог',
    deal: { ...BASE_DEAL, current_state: 'SOPRANO_INTERVIEW', intake_rounds: 1 },
    agents: { memory: [memory(1)] },
    messages: ['заверши сессию'],
  },
  {
    name: 'raw_output_recovery',
    description: 'Ответ composer в обёртке ```json с parse_error восстанавливается',
    deal: { ...BASE_DEAL, current_state: 'STRATEGY_SELECTION', last_strategy_output: strategy().strategy_output },
    agents: {
      composer: [{ parse_error: true, raw_output: '```json\n' + JSON.stringify(composer('RAW')) + '\n```' }],
      reviewer: [reviewer('ОДОБРЕНО')],
    },
    messages: ['дальше'],
  },
  {
    name: 'manager_corrects_diagnosis_and_strategy',
    description: 'Правка после оценки пересобирает оценку, правка после стратегии — стратегию; «давай стратегию» / «пиши касания» идут дальше',
    deal: { ...BASE_DEAL, current_state: 'DIAGNOSING', last_diagnostic_output: diagnostic().diagnostic_output },
    agents: {
      diagnostic: [diagnostic()],
      strategy: [strategy(), strategy({ strategy_summary: 'учтено: собственник в отпуске до 20-го' })],
      composer: [composer('C')],
      reviewer: [reviewer('ОДОБРЕНО')],
    },
    messages: ['перепиши оценку с учётом сроков', 'давай стратегию', 'собственник в отпуске до 20-го', 'пиши касания'],
  },
  {
    name: 'legacy_reviewing_reworks_in_auto_loop',
    description: 'Старая сделка в REVIEWING: любое сообщение → доработка по замечаниям в автоцикле → проверено',
    deal: { ...AT_COMPOSING, current_state: 'REVIEWING', last_reviewer_output: reviewer('НА ДОРАБОТКУ').reviewer_output },
    agents: { composer: [composer('FIX')], reviewer: [reviewer('ОДОБРЕНО')] },
    messages: ['дальше'],
  },
  {
    name: 'escalation_close_word',
    description: 'После эскалации «закрыть» — итог без переспроса',
    deal: { ...AT_COMPOSING, current_state: 'ESCALATION', composer_iterations: 3 },
    agents: { memory: [memory(1)] },
    messages: ['закрыть'],
  },
];

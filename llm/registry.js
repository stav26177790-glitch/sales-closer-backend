/**
 * llm/registry.js — настройки каждого агента в одном месте:
 * модель, температура, файлы базы знаний, кейсы отрасли, кэширование промпта.
 *
 * Шапки промптов agents/*.md (строки «Модель:», «Температура:») не читаются
 * кодом и местами расходятся с этим файлом — источник правды здесь.
 */
const SONNET = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5-20251001';

// industryKnowledge — подключать ли knowledge/industry/<отрасль>.md (факты
// компании как результат для клиента; есть не для всех отраслей).
// cache — кэшировать ли системный промпт (prompt caching, TTL 5 минут).
// Запись в кэш стоит 1.25× обычного входа, чтение — 0.1×. Окупается, только
// если тот же агент с тем же промптом вызывается снова в течение 5 минут.
// Включено для агентов, которые в одной сессии вызываются повторно:
//   composer — доработки и правки менеджера; reviewer — каждое «ок»;
//   advisor — вопросы менеджера по касаниям.
// strategy и memory вызываются раз за сессию, planner и intent_classifier
// короче минимума для кэша — им кэш только добавил бы 25% к цене.
// Решение пересмотреть по логам «[agentRunner] ←» (поле cache) через 1–2 недели.
const AGENTS = {
  planner: {
    model: SONNET, temperature: 0.2, industryCases: false, cache: false,
    knowledge: []
  },
  diagnostic: {
    // cache: true (14.11) — промпт ~100 тыс. символов одинаков у всех сделок: при прогонах
    // набора и при нескольких менеджерах сразу повторный вызов в течение 5 минут — в 10 раз дешевле.
    model: SONNET, temperature: 0.2, industryCases: false, cache: true,
    knowledge: [
      '01_sales_methodology.md', '02_sales_formula.md', '03_signal_dictionary.md',
      '04_financial_capacity.md', '05_need.md', '06_trust.md', '07_decision_authority.md',
      '08_urgency.md', '13_examples.md', '16_soprano_qualification.md', '20_buying_psychology.md',
      '24_client_triggers.md'
    ]
  },
  strategy: {
    // cache: true (14.11) — самый большой промпт (~200 тыс. символов), одинаков у всех сделок отрасли.
    model: SONNET, temperature: 0.3, industryCases: true, industryKnowledge: true, cache: true,
    knowledge: [
      '02_sales_formula.md', '06_trust.md', '07_decision_authority.md', '08_urgency.md',
      '09_touchpoint_engine.md', '13_examples.md', '20_buying_psychology.md',
      '21_industry_specifics.md', '23_lpr_tactics.md', '24_client_triggers.md',
      '25_after_kp_playbook.md', '26_perepiska_metodika.md', '27_pravilo_7_kasaniy.md'
    ]
  },
  composer: {
    model: SONNET, temperature: 0.4, industryCases: true, industryKnowledge: true, cache: true,
    knowledge: [
      '09_touchpoint_engine.md', '10b_scripts_post_kp_meeting.md', '11_touchpoint_library.md',
      '14_style_guide.md', '15_objection_expensive.md', '15b_objection_library.md',
      '17_trust_building.md', '22_presentation.md', '23_lpr_tactics.md', '24_client_triggers.md',
      '25_after_kp_playbook.md'
    ]
  },
  reviewer: {
    model: SONNET, temperature: 0.1, industryCases: false, industryKnowledge: true, cache: true,
    knowledge: ['14_style_guide.md', '09_touchpoint_engine.md', '01_sales_methodology.md', '24_client_triggers.md', '25_after_kp_playbook.md']
  },
  // Пишет касания по плану, который посчитал код (engine/touchPlan.js).
  // Короткий промпт вместо composer'а (1300 строк + все кейсы) — 2026-11-13.
  writer: {
    model: SONNET, temperature: 0.4, industryCases: false, industryKnowledge: true, cache: true,
    // Методики владельца (рекомендации, 14.11): переписка и 7 касаний.
    knowledge: ['26_perepiska_metodika.md', '27_pravilo_7_kasaniy.md']
  },
  // Точечная правка касаний по замечаниям проверки (engine/autoCompose.js).
  // Короткий промпт вместо 300 КБ composer'а — правки не теряются (2026-11-13).
  editor: {
    // cache: true (14.11) — за путь вызывается до 2 раз подряд.
    model: SONNET, temperature: 0.3, industryCases: false, industryKnowledge: true, cache: true,
    knowledge: []
  },
  memory: {
    model: HAIKU, temperature: 0.1, industryCases: false, cache: false,
    knowledge: []
  },
  advisor: {
    model: HAIKU, temperature: 0.3, industryCases: true, industryKnowledge: true, cache: true,
    knowledge: [
      '15_objection_expensive.md', '15b_objection_library.md', '17_trust_building.md',
      '07_decision_authority.md', '23_lpr_tactics.md', '24_client_triggers.md',
      '26_perepiska_metodika.md'
    ]
  },
  intent_classifier: {
    model: HAIKU, temperature: 0.1, industryCases: false, cache: false,
    knowledge: []
  }
};

const DEFAULT_TEMPERATURE = 0.2;

function getAgentConfig(agentName) {
  return AGENTS[agentName] || { model: undefined, temperature: DEFAULT_TEMPERATURE, industryCases: false, industryKnowledge: false, cache: false, knowledge: [] };
}

module.exports = { AGENTS, getAgentConfig };

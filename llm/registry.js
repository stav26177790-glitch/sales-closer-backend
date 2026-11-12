/**
 * llm/registry.js — настройки каждого агента в одном месте:
 * модель, температура, файлы базы знаний, кейсы отрасли, кэширование промпта.
 *
 * Шапки промптов agents/*.md (строки «Модель:», «Температура:») не читаются
 * кодом и местами расходятся с этим файлом — источник правды здесь.
 */
const SONNET = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5-20251001';

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
    model: SONNET, temperature: 0.2, industryCases: false, cache: false,
    knowledge: [
      '01_sales_methodology.md', '02_sales_formula.md', '03_signal_dictionary.md',
      '04_financial_capacity.md', '05_need.md', '06_trust.md', '07_decision_authority.md',
      '08_urgency.md', '13_examples.md', '16_soprano_qualification.md', '20_buying_psychology.md'
    ]
  },
  strategy: {
    model: SONNET, temperature: 0.3, industryCases: true, cache: false,
    knowledge: [
      '02_sales_formula.md', '06_trust.md', '07_decision_authority.md', '08_urgency.md',
      '09_touchpoint_engine.md', '13_examples.md', '20_buying_psychology.md',
      '21_industry_specifics.md', '23_lpr_tactics.md'
    ]
  },
  composer: {
    model: SONNET, temperature: 0.4, industryCases: true, cache: true,
    knowledge: [
      '09_touchpoint_engine.md', '10b_scripts_post_kp_meeting.md', '11_touchpoint_library.md',
      '14_style_guide.md', '15_objection_expensive.md', '15b_objection_library.md',
      '17_trust_building.md', '22_presentation.md'
    ]
  },
  reviewer: {
    model: SONNET, temperature: 0.1, industryCases: false, cache: true,
    knowledge: ['14_style_guide.md', '09_touchpoint_engine.md', '01_sales_methodology.md']
  },
  memory: {
    model: HAIKU, temperature: 0.1, industryCases: false, cache: false,
    knowledge: []
  },
  advisor: {
    model: HAIKU, temperature: 0.3, industryCases: true, cache: true,
    knowledge: [
      '15_objection_expensive.md', '15b_objection_library.md', '17_trust_building.md',
      '07_decision_authority.md', '23_lpr_tactics.md'
    ]
  },
  intent_classifier: {
    model: HAIKU, temperature: 0.1, industryCases: false, cache: false,
    knowledge: []
  }
};

const DEFAULT_TEMPERATURE = 0.2;

function getAgentConfig(agentName) {
  return AGENTS[agentName] || { model: undefined, temperature: DEFAULT_TEMPERATURE, industryCases: false, cache: false, knowledge: [] };
}

module.exports = { AGENTS, getAgentConfig };

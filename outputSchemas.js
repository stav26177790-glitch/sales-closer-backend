/**
 * outputSchemas.js
 *
 * Лёгкие, без внешних зависимостей (нет npm-пакетов вроде ajv/zod —
 * окружение без сети, ставить нечего) схемы вывода каждого агента.
 * Взяты дословно из раздела "ВЫХОДНЫЕ ДАННЫЕ" каждого *_agent.md — это
 * контракт, который агент сам себе обещает соблюдать.
 *
 * НЕ проверяет соответствие коду stateMachine.js (это уже делает
 * regression/static-checks.js статическим анализом текста) — проверяет
 * соответствие ЖИВОГО ответа модели ЕЁ ЖЕ схеме. Разные классы проблем,
 * см. обсуждение в HANDOFF по блоку "схема-валидация".
 *
 * Формат схемы (упрощённый, самодельный — не JSON Schema):
 * {
 *   requiredKeys: ['keyA', 'keyB'],       // должны существовать (не undefined)
 *   keyTypes: { keyA: 'array', keyB: 'object', keyC: 'string', keyD: 'boolean' },
 *   // keyTypes проверяется только для ключей, которые присутствуют —
 *   // не дублирует requiredKeys, а описывает ожидаемый тип, ЕСЛИ ключ есть.
 * }
 */

const SCHEMAS = {
  planner: {
    requiredKeys: [
      'data_quality', 'deal_context', 'diagnostic_priorities',
      'flags', 'agent_chain', 'clarification_needed', 'planner_notes'
    ],
    keyTypes: {
      data_quality: 'object',
      deal_context: 'object',
      diagnostic_priorities: 'object',
      flags: 'array',
      agent_chain: 'array',
      clarification_needed: 'object',
      planner_notes: 'string'
    }
  },
  diagnostic: {
    requiredKeys: [
      'scores', 'primary_blocker', 'patterns_detected',
      'conflicts_with_manager', 'clarification_needed', 'diagnostic_summary'
      // secondary_blocker сознательно НЕ в required — по схеме и примерам
      // агента это опциональное поле (не в каждой сделке есть вторичный блокер).
    ],
    keyTypes: {
      scores: 'object',
      primary_blocker: 'object',
      secondary_blocker: 'object',
      patterns_detected: 'array',
      conflicts_with_manager: 'array', // именно это поле — источник фикса бага №31/№32
      clarification_needed: 'object',
      diagnostic_summary: 'string'
    }
  },
  strategy: {
    requiredKeys: [
      'primary_strategy', 'touchpoint_sequence', 'channel_rotation',
      'do_not_use', 'escalation_required', 'deal_health',
      'recommended_next_action', 'strategy_summary'
      // secondary_strategy сознательно НЕ в required (опционально по схеме).
    ],
    keyTypes: {
      primary_strategy: 'object',
      secondary_strategy: 'object',
      touchpoint_sequence: 'array',
      channel_rotation: 'array',
      do_not_use: 'array',
      escalation_required: 'boolean',
      recommended_next_action: 'string', // источник фикса бага №30
      strategy_summary: 'string'
    }
  },
  composer: {
    requiredKeys: ['messages', 'stop_words_check', 'value_check', 'composer_notes'],
    keyTypes: {
      messages: 'array',
      follow_up: 'object',
      stop_words_check: 'string',
      value_check: 'string',
      composer_notes: 'string'
    }
  },
  reviewer: {
    requiredKeys: ['verdict', 'messages_reviewed', 'overall_quality_score', 'reviewer_notes'],
    keyTypes: {
      verdict: 'string',
      iteration: 'number',
      messages_reviewed: 'array',
      overall_quality_score: 'number',
      reviewer_notes: 'string'
    }
  },
  memory: {
    requiredKeys: [
      'deal_profile', 'criteria_status', 'touchpoints_history', 'agreements',
      'blockers_history', 'do_not_repeat', 'client_insights', 'deal_status', 'session_summary'
    ],
    keyTypes: {
      deal_profile: 'object',
      criteria_status: 'object',
      touchpoints_history: 'array',
      agreements: 'array',
      blockers_history: 'array',
      do_not_repeat: 'object',
      client_insights: 'object',
      deal_status: 'object',
      session_summary: 'object'
    }
  },
  advisor: {
    requiredKeys: ['answer', 'suggest_correction'],
    keyTypes: {
      answer: 'string',
      suggest_correction: 'boolean'
    }
  }
};

/**
 * Проверяет тип значения простым способом, без внешних библиотек.
 * 'array' — Array.isArray, 'object' — typeof === 'object' И не массив
 * (и не null — null проходит отдельной веткой в validateAgentOutput).
 */
function checkType(value, expectedType) {
  if (expectedType === 'array') return Array.isArray(value);
  if (expectedType === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === expectedType;
}

/**
 * Валидирует распарсенный вывод агента против его схемы.
 * НЕ бросает исключение — возвращает { valid, problems } и позволяет
 * вызывающему коду решить, что делать (сейчас — громко залогировать).
 * Отсутствие агента в SCHEMAS не считается ошибкой (например, для агентов,
 * добавленных позже без схемы здесь) — просто valid: true, problems: [].
 */
function validateAgentOutput(agentName, output) {
  const schema = SCHEMAS[agentName];
  if (!schema) return { valid: true, problems: [] };

  const problems = [];
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return { valid: false, problems: [`ожидался объект верхнего уровня, получено: ${Array.isArray(output) ? 'массив' : typeof output}`] };
  }

  for (const key of schema.requiredKeys) {
    if (!(key in output) || output[key] === undefined) {
      problems.push(`отсутствует обязательное поле "${key}"`);
    }
  }
  for (const [key, expectedType] of Object.entries(schema.keyTypes || {})) {
    if (!(key in output) || output[key] === undefined || output[key] === null) continue; // отсутствие уже поймано выше, если поле обязательное
    if (!checkType(output[key], expectedType)) {
      const actualType = Array.isArray(output[key]) ? 'array' : typeof output[key];
      problems.push(`поле "${key}" имеет тип "${actualType}", ожидался "${expectedType}"`);
    }
  }

  return { valid: problems.length === 0, problems };
}

module.exports = { SCHEMAS, validateAgentOutput };

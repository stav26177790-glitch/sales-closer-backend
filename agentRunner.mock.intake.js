/**
 * agentRunner.mock.intake.js — заглушка для теста MAX_INTAKE_ROUNDS.
 * planner всегда пропускает без уточнений. diagnostic ВСЕГДА просит
 * уточнение (clarification_needed.required = true) — имитирует сценарий,
 * где менеджер отвечает уклончиво/неполно на каждой итерации и без
 * код-уровневого лимита интервью крутилось бы бесконечно.
 */
const ALWAYS_ASKS_QUESTION = 'Тестовый уточняющий вопрос, который агент готов задавать бесконечно.';

async function callAgent(agentName, inputData, maxTokens) {
  if (agentName === 'planner') {
    return {
      planner_output: {
        data_quality: { score: 'low', missing: ['бюджет'], sufficient_for_analysis: true },
        clarification_needed: { required: false, questions: [] }
      }
    };
  }
  if (agentName === 'diagnostic') {
    return {
      diagnostic_output: {
        scores: {
          financial: { status: 'Неизвестно', evidence: [], confidence: 'low' },
          need: { status: 'Вероятно', evidence: [], confidence: 'medium' },
          trust: { status: 'Неизвестно', evidence: [], confidence: 'low' },
          authority: { status: 'Риск', evidence: [], confidence: 'high' },
          urgency: { status: 'Риск', evidence: [], confidence: 'high' }
        },
        primary_blocker: { criterion: 'authority', reason: 'Тестовый блокер.', evidence: [] },
        secondary_blocker: { criterion: 'urgency', reason: 'Тестовый вторичный блокер.' },
        patterns_detected: [],
        conflicts_with_manager: [],
        // Ключевая часть мока: ВСЕГДА true, независимо от раунда — именно
        // это и должно быть перебито код-уровневым MAX_INTAKE_ROUNDS,
        // а не встроенной в промпт diagnostic'а инструкцией "после 2 раундов
        // остановись" (агент в этом тесте намеренно "не слушается").
        clarification_needed: { required: true, questions: [ALWAYS_ASKS_QUESTION] },
        diagnostic_summary: 'Тестовое резюме — интервью намеренно не завершается само.'
      }
    };
  }
  throw new Error(`agentRunner.mock.intake: вызов агента "${agentName}" не ожидался — если дошли сюда, значит лимит раундов не сработал и интервью должно было продолжиться, а не дойти до strategy/composer.`);
}

module.exports = { callAgent, ALWAYS_ASKS_QUESTION };

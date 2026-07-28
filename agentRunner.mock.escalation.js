/**
 * agentRunner.mock.escalation.js — заглушка для теста ручных попыток после
 * ESCALATION (баг №35, найден в HANDOFF_v7 §1.6, пофикшен в HANDOFF_v8).
 *
 * composer всегда возвращает валидный набор касаний (содержание не важно
 * для этого теста), reviewer ВСЕГДА возвращает "НА ДОРАБОТКУ" — имитация
 * реального случая из живого прогона, где composer и reviewer так и не
 * сошлись за MAX_COMPOSER_ITERATIONS попыток, даже после правок менеджера.
 * Это специально: тест проверяет, что менеджеру дают ограниченное число
 * РУЧНЫХ попыток (MAX_ESCALATION_RETRIES), а не что доработка в итоге
 * помогает — сходимость reviewer'а тестируется другими тестами/live-checks.
 */
let composerCallCount = 0;
let reviewerCallCount = 0;
let memoryCallCount = 0;

function reset() {
  composerCallCount = 0;
  reviewerCallCount = 0;
  memoryCallCount = 0;
}

async function callAgent(agentName, inputData, maxTokens) {
  if (agentName === 'intent_classifier') {
    // Фоновый теневой вызов (см. logIntentClassificationShadow в
    // stateMachine.js) — не влияет на исход этого теста, но без обработки
    // сыпет безобидные, но шумные ошибки в stderr на каждом шаге с "ок".
    return { intent_classifier_output: { intent: 'approval', confidence: 'high' } };
  }
  if (agentName === 'composer') {
    composerCallCount++;
    return {
      composer_output: {
        messages: [
          { touchpoint_number: 1, channel: 'whatsapp', body: `Тестовое касание, попытка №${composerCallCount}.` }
        ]
      }
    };
  }
  if (agentName === 'reviewer') {
    reviewerCallCount++;
    return {
      reviewer_output: {
        verdict: 'НА ДОРАБОТКУ',
        messages_reviewed: [
          {
            touchpoint_number: 1,
            verdict: 'НА ДОРАБОТКУ',
            failed_criteria: ['authenticity'],
            fix_instructions: 'Тестовая правка, которая намеренно никогда не устраивает reviewer — мок для проверки лимита ручных попыток, не сходимости.'
          }
        ]
      }
    };
  }
  if (agentName === 'memory') {
    memoryCallCount++;
    return {
      memory_output: {
        session_number: 1,
        previous_touchpoints: [],
        confirmed_facts: [],
        open_questions: []
      }
    };
  }
  throw new Error(`agentRunner.mock.escalation: вызов агента "${agentName}" не ожидался в этом тесте`);
}

module.exports = {
  callAgent,
  __reset: reset,
  __getComposerCallCount: () => composerCallCount,
  __getReviewerCallCount: () => reviewerCallCount,
  __getMemoryCallCount: () => memoryCallCount
};

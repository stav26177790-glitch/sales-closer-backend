/**
 * Этап ESCALATION — автоматическая проверка так и не одобрила касания.
 *
 * Баг №35: раньше это был тупик — любое сообщение закрывало сессию с
 * неодобренным текстом. Теперь:
 *   1. escalation()    — менеджер прислал правку → спрашиваем «доработать или закрыть?»;
 *   2. awaitingRetry   — ждём да/нет: «да» → ручная попытка composer, «нет» → итог;
 *   3. retriesExhausted — лимит MAX_ESCALATION_RETRIES исчерпан → итог.
 */
const { runComposer, runMemoryUpdate } = require('../pipeline');
const { CONFIG } = require('../config');
const { isAffirmativeResponse, isNegativeResponse } = require('../intent');

async function retriesExhausted({ dealId, deal, baseInput }, statusNote, resetFlags) {
  const output = {};
  output._finalText = await runMemoryUpdate(dealId, baseInput, deal, { statusNote });
  if (resetFlags) {
    output._awaitingEscalationConfirmation = false;
    output._pendingEscalationFeedback = null;
  }
  return { nextState: 'FINAL_OUTPUT', output };
}

async function awaitingRetry(ctx) {
  const { dealId, deal, baseInput, managerInput } = ctx;
  if (isAffirmativeResponse(managerInput)) {
    const retriesUsed = deal.escalation_retries || 0;
    if (retriesUsed >= CONFIG.MAX_ESCALATION_RETRIES) {
      return retriesExhausted(ctx,
        `Статус: лимит ручных попыток доработки (${CONFIG.MAX_ESCALATION_RETRIES}) после эскалации исчерпан — сессия завершена с последним вариантом текста, дальнейшие правки нужно вносить вручную.`,
        true);
    }
    const iterations = deal.composer_iterations || 1;
    const output = {};
    output.composer_output = await runComposer(baseInput, deal, {
      feedback: { source: 'manager', manager_feedback: deal.pending_escalation_feedback },
      iteration: iterations + 1
    });
    // composer_iterations двигаем как обычно (реальная новая попытка), а
    // escalation_retries отдельно считает именно ручные перезапуски, чтобы
    // не уйти в цикл эскалация → правка → эскалация.
    output._composer_iterations = iterations + 1;
    output._escalation_retries = retriesUsed + 1;
    output._awaitingEscalationConfirmation = false;
    output._pendingEscalationFeedback = null;
    return { nextState: 'COMPOSING', output };
  }
  if (isNegativeResponse(managerInput)) {
    const output = {};
    output._finalText = await runMemoryUpdate(dealId, baseInput, deal, {
      statusNote: 'Статус: сессия завершена вручную — после эскалации менеджер решил оставить текст как есть.'
    });
    output._awaitingEscalationConfirmation = false;
    output._pendingEscalationFeedback = null;
    return { nextState: 'FINAL_OUTPUT', output };
  }
  // Ответ не распознан — переспрашиваем, сохраняя фидбэк менеджера.
  return {
    nextState: 'ESCALATION',
    output: { _directText: 'Не понял ответ — доработать текст с учётом этого, или закрыть сессию как есть? Ответьте, пожалуйста, "да" или "нет".' }
  };
}

async function escalation(ctx) {
  const { deal, managerInput } = ctx;
  if (deal.awaiting_escalation_confirmation) return awaitingRetry(ctx);

  // Лимит исчерпан ещё до этого сообщения — закрываем сразу, не спрашивая.
  if ((deal.escalation_retries || 0) >= CONFIG.MAX_ESCALATION_RETRIES) {
    return retriesExhausted(ctx,
      `Статус: лимит ручных попыток доработки (${CONFIG.MAX_ESCALATION_RETRIES}) после эскалации уже исчерпан — сессия завершена с последним вариантом текста.`,
      false);
  }
  return {
    nextState: 'ESCALATION',
    output: {
      _directText: 'Доработать текст с учётом этого, или закрыть сессию как есть? (да/нет)',
      _awaitingEscalationConfirmation: true,
      _pendingEscalationFeedback: managerInput
    }
  };
}

module.exports = { escalation };

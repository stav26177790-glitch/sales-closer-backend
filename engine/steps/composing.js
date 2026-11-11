/**
 * Этап COMPOSING — касания показаны менеджеру, ждём его реакцию.
 *
 * Ответ менеджера разбирается в таком порядке (каждая ветка — своя функция):
 *   1. awaitingCorrection — мы задали вопрос «скорректировать касания?» и ждём да/нет;
 *   2. lengthViolation    — касание длиннее лимита канала (техническая правка);
 *   3. managerQuestion    — вопрос к агенту → отвечает advisor, спрашиваем «скорректировать?»;
 *   4. managerEdit        — содержательная правка → composer переписывает;
 *   5. sendToReview       — чистое одобрение («ок») → проверка reviewer'ом.
 */
const { callAgentSafe, runComposer, runMemoryUpdate } = require('../pipeline');
const { CONFIG } = require('../config');
const {
  isPureApproval, isManagerQuestion, isAffirmativeResponse, isNegativeResponse, logIntentClassificationShadow
} = require('../intent');

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

// 1. Ответ на наш вопрос «скорректировать текущие касания с учётом этого?».
async function awaitingCorrection({ deal, baseInput, managerInput }) {
  const output = {};
  if (isAffirmativeResponse(managerInput)) {
    output.composer_output = await runComposer(baseInput, deal, {
      feedback: { source: 'manager', manager_feedback: deal.pending_manager_feedback },
      iteration: deal.composer_iterations || 1
    });
    output._awaitingCorrectionConfirmation = false;
    output._pendingManagerFeedback = null;
    return { nextState: 'COMPOSING', output };
  }
  if (isNegativeResponse(managerInput)) {
    output._awaitingCorrectionConfirmation = false;
    output._pendingManagerFeedback = null;
    output.composer_output = deal.last_composer_output;
    output._directText = 'Хорошо, оставляю текущие касания без изменений. Когда будете готовы — напишите "ок", чтобы отправить их на финальную проверку.';
    return { nextState: 'COMPOSING', output };
  }
  // Ответ не распознан как явное да/нет — переспрашиваем, не теряя
  // исходный вопрос менеджера, чтобы не уйти в composer с мусором.
  output._directText = 'Не понял ответ — скорректировать текущие касания с учётом этого? Ответьте, пожалуйста, "да" или "нет".';
  return { nextState: 'COMPOSING', output };
}

// 2. Касание длиннее лимита канала. Если менеджер вместе с этим написал
// правку — оба фидбэка уходят в composer одним вызовом (раньше правка
// менеджера терялась, потому что проверка длины срабатывала первой).
async function lengthViolation({ deal, baseInput, managerInput }, violations, managerGaveFeedback) {
  const output = {};
  const iterations = deal.composer_iterations || 1;
  const lengthFeedback = {
    verdict: 'НА ДОРАБОТКУ',
    messages_reviewed: violations.map((v) => ({
      touchpoint_number: v.touchpoint,
      verdict: 'НА ДОРАБОТКУ',
      failed_criteria: ['channel_fit'],
      fix_instructions: `Сообщение для ${v.channel} слишком длинное: ${v.current}/${v.max} символов.`
    }))
  };
  if (iterations >= CONFIG.MAX_COMPOSER_ITERATIONS) {
    output.reviewer_output = lengthFeedback;
    return { nextState: 'ESCALATION', output };
  }
  output.composer_output = await runComposer(baseInput, deal, {
    feedback: managerGaveFeedback
      ? { ...lengthFeedback, source: 'manager', manager_feedback: managerInput }
      : lengthFeedback,
    iteration: iterations + 1
  });
  // Нарушение длины — техническая причина, поэтому итерацию считаем как обычно
  // (в отличие от вкусового фидбэка менеджера в managerEdit).
  output._composer_iterations = iterations + 1;
  return { nextState: 'COMPOSING', output };
}

// 3. Вопрос к агенту («что ответить на "дорого"?»). Composer умеет только
// переписывать касания, поэтому отвечает advisor, а затем спрашиваем,
// нужна ли правка.
async function managerQuestion({ deal, baseInput, managerInput }) {
  const output = {};
  const advisorResult = await callAgentSafe('advisor', {
    ...baseInput,
    strategy_output: deal.last_strategy_output,
    composer_output: deal.last_composer_output,
    manager_question: managerInput
  }, 2000);
  output.advisor_output = advisorResult?.advisor_output || advisorResult;
  const answer = output.advisor_output?.answer
    || '⚠️ Не удалось сформировать ответ на вопрос — уточните, пожалуйста, формулировку.';
  output._directText = `${answer}\n\nСкорректировать текущие касания с учётом этого? (да/нет)`;
  output._awaitingCorrectionConfirmation = true;
  output._pendingManagerFeedback = `Вопрос менеджера: ${managerInput}\n\nРекомендация: ${answer}`;
  return { nextState: 'COMPOSING', output };
}

// 4. Содержательная правка менеджера. composer_iterations намеренно НЕ
// увеличиваем: счётчик считает автоматические доработки по вердикту
// reviewer'а (лимит MAX_COMPOSER_ITERATIONS), правки менеджера не должны
// приближать эскалацию.
async function managerEdit({ deal, baseInput, managerInput }) {
  const output = {};
  output.composer_output = await runComposer(baseInput, deal, {
    feedback: { source: 'manager', manager_feedback: managerInput },
    iteration: deal.composer_iterations || 1
  });
  return { nextState: 'COMPOSING', output };
}

// 5. Менеджер одобрил — проверка reviewer'ом. При одобрении сессия
// завершается сразу в этом же ходе (баг №34: раньше между «одобрено» и
// итогом был лишний ход, и новое сообщение менеджера в нём терялось).
async function sendToReview({ dealId, deal, baseInput }) {
  const output = {};
  // Лимит 8000: ответ reviewer'а самый объёмный (чек-лист на каждое касание),
  // на дефолтном лимите JSON обрезался и вердикт не читался.
  const reviewerResult = await callAgentSafe('reviewer', {
    ...baseInput,
    strategy_output: deal.last_strategy_output,
    composer_output: deal.last_composer_output
  }, 8000);
  output.reviewer_output = reviewerResult?.reviewer_output || reviewerResult;
  const verdict = output.reviewer_output?.verdict || output.reviewer_output?.reviewer_output?.verdict;
  if (verdict === 'ОДОБРЕНО') {
    output._finalText = await runMemoryUpdate(dealId, baseInput, deal, {
      composer_output: deal.last_composer_output,
      strategy_output: deal.last_strategy_output,
      reviewer_output: output.reviewer_output
    });
    return { nextState: 'FINAL_OUTPUT', output };
  }
  return { nextState: 'REVIEWING', output };
}

async function composing(ctx) {
  const { deal, managerInput } = ctx;
  if (deal.awaiting_correction_confirmation) return awaitingCorrection(ctx);

  const lengthCheck = validateMessageLength({ composer_output: deal.last_composer_output });
  const managerGaveFeedback = !isPureApproval(managerInput);
  // Теневой режим: сравниваем решение списков фраз с LLM-классификатором и
  // логируем расхождения, не меняя поведение (асинхронно, не блокирует ответ).
  logIntentClassificationShadow(managerInput, isPureApproval(managerInput), isManagerQuestion(managerInput), deal.id);

  if (!lengthCheck.valid) return lengthViolation(ctx, lengthCheck.violations, managerGaveFeedback);
  if (managerGaveFeedback) {
    return isManagerQuestion(managerInput) ? managerQuestion(ctx) : managerEdit(ctx);
  }
  return sendToReview(ctx);
}

module.exports = { composing, validateMessageLength };

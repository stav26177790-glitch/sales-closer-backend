/**
 * Этап COMPOSING — касания показаны менеджеру (уже проверенные Клоузером:
 * см. engine/autoCompose.js), ждём его реакцию.
 *
 * Ответ менеджера:
 *   1. awaitingCorrection — мы спросили «скорректировать касания?» после ответа на вопрос;
 *   2. «ок» → accept: касания прошли автоцикл — итог сессии; старые
 *      (до автоцикла) — сначала проверить и доработать;
 *   3. вопрос → advisor отвечает, спрашиваем «скорректировать?»;
 *   4. правка → composer переписывает, автоцикл проверяет и дорабатывает.
 */
const { callAgentSafe, runMemoryUpdate } = require('../pipeline');
const { CONFIG } = require('../config');
const { composeUntilReady, channelKey } = require('../autoCompose');
const {
  isPureApproval, isManagerQuestion, isAffirmativeResponse, isNegativeResponse, logIntentClassificationShadow
} = require('../intent');

// Касание длиннее лимита канала (для старых тестов и внешних вызовов).
function validateMessageLength(composerOutput) {
  const messages = composerOutput?.composer_output?.messages || [];
  const violations = [];
  messages.forEach((msg, i) => {
    const maxLen = CONFIG.MAX_MESSAGE_LENGTH[channelKey(msg.channel)];
    if (maxLen && msg.body?.length > maxLen) {
      violations.push({ touchpoint: i + 1, channel: msg.channel, current: msg.body.length, max: maxLen });
    }
  });
  return { valid: violations.length === 0, violations };
}

// Результат автоцикла → поля хода (advance сохраняет их в сделку).
function composedOutput(res, extra = {}) {
  return {
    composer_output: res.composer_output,
    reviewer_output: res.reviewer_output || undefined,
    _composer_iterations: res.rounds || 1,
    ...extra
  };
}

// 1. Ответ на «скорректировать текущие касания с учётом этого?».
async function awaitingCorrection({ deal, baseInput, managerInput }) {
  if (isAffirmativeResponse(managerInput)) {
    const res = await composeUntilReady(baseInput, deal, {
      feedback: { source: 'manager', manager_feedback: deal.pending_manager_feedback }
    });
    return { nextState: 'COMPOSING', output: composedOutput(res, { _awaitingCorrectionConfirmation: false, _pendingManagerFeedback: null }) };
  }
  const output = {};
  if (isNegativeResponse(managerInput)) {
    output._awaitingCorrectionConfirmation = false;
    output._pendingManagerFeedback = null;
    output._directText = 'Хорошо, касания без изменений. Напишите «ок», чтобы сохранить итог сессии, или пришлите правку.';
    return { nextState: 'COMPOSING', output };
  }
  output._directText = 'Не понял ответ — скорректировать текущие касания с учётом этого? Ответьте, пожалуйста, "да" или "нет".';
  return { nextState: 'COMPOSING', output };
}

// 2. «ок».
async function accept({ dealId, deal, baseInput }) {
  const check = deal.last_composer_output?._check;
  if (!check) {
    // Касания составлены до автоцикла — проверить (и при нужде доработать) сейчас.
    const res = await composeUntilReady(baseInput, deal, { startWith: deal.last_composer_output });
    return { nextState: 'COMPOSING', output: composedOutput(res) };
  }
  const output = {};
  output._finalText = await runMemoryUpdate(dealId, baseInput, deal, {
    composer_output: deal.last_composer_output,
    strategy_output: deal.last_strategy_output,
    reviewer_output: deal.last_reviewer_output,
    statusNote: check.approved ? undefined
      : (check.fixedAfterReview?.length
        ? `Статус: касания ${check.fixedAfterReview.join(', ')} исправлены по замечаниям второй проверки без повторной проверки; менеджер принял.`
        : 'Статус: касания приняты менеджером, хотя проверка не приняла часть из них (замечания были показаны).')
  });
  return { nextState: 'FINAL_OUTPUT', output };
}

// 3. Вопрос к агенту («что ответить на "дорого"?») — отвечает advisor.
async function managerQuestion({ deal, baseInput, managerInput }) {
  const output = {};
  const advisorResult = await callAgentSafe('advisor', {
    ...baseInput,
    diagnostic_output: deal.last_diagnostic_output,
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

// 4. Правка менеджера → переписать, проверить, доработать.
async function managerEdit({ deal, baseInput, managerInput }) {
  const res = await composeUntilReady(baseInput, deal, {
    feedback: { source: 'manager', manager_feedback: managerInput, reviewer_feedback: deal.last_reviewer_output }
  });
  return { nextState: 'COMPOSING', output: composedOutput(res) };
}

async function composing(ctx) {
  const { deal, managerInput } = ctx;
  if (deal.awaiting_correction_confirmation) return awaitingCorrection(ctx);
  // Теневой режим: сравниваем решение списков фраз с LLM-классификатором.
  logIntentClassificationShadow(managerInput, isPureApproval(managerInput), isManagerQuestion(managerInput), deal.id);
  if (isPureApproval(managerInput)) return accept(ctx);
  return isManagerQuestion(managerInput) ? managerQuestion(ctx) : managerEdit(ctx);
}

module.exports = { channelKey, composing, validateMessageLength, composedOutput };

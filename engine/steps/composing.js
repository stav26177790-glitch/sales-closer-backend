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
const { modeCommand, rebuildMode, switchPathMode } = require('../pathMode');
const {
  isPureApproval, isManagerQuestion, isAffirmativeResponse, isNegativeResponse
} = require('../intent');

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

// 5. Режим пути (решение владельца 13.11): после касаний менеджер приносит НОВЫЕ ФАКТЫ —
// клиент ответил, прислал логотип, сдвинулось открытие. Клоузер перестраивает весь путь:
// оценка → стратегия → касания (дальше engine/autoFlow.js продолжает сам).
// Правкой текста считаем только явную команду («касание 2 короче», «убери баннер»).
const TEXT_EDIT_RE = /^\s*(в\s+)?(касани[еяию]\s*№?\s*\d|короче|покороче|длиннее|теплее|мягче|жёстче|жестче|убери|убрать|замени|заменить|перепиши|исправь|поправь|переформулируй|сократи|без\s)/i;
// Живой тест 20.11 («Хорошие парни»): «Отправил касание 1. Денис (20.11, WhatsApp): Руслан… говорит дорого…
// И спрашивает: вы вообще для барбершопов делали?» — из-за «?» в словах клиента ушло советнику вместо перестройки
// пути. «Имя (дата, канал):», «отправил касание», «говорит / спрашивает / пишет» — это ответ клиента = новые факты.
const CLIENT_REPLY_RE = /(ответил|ответила|написал|написала|сказал|сказала|перезвонил|перезвонила|позвонил|позвонила|прислал|прислала|клиент|говорит|спрашивает|пишет|отправил[аи]? касани|[А-ЯЁ][а-яё]+\s*\(\d{1,2}[.\/]\d{1,2}[^)\n]{0,40}\)\s*:)/;
function isNewFacts(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (TEXT_EDIT_RE.test(t) && !CLIENT_REPLY_RE.test(t)) return false;
  if (CLIENT_REPLY_RE.test(t) || t.length > 200) return true;
  return !isManagerQuestion(t);
}

const { sentHistoryAfter } = require('../sentHistory');
async function rebuildPath({ deal, baseInput, managerInput }) {
  const { runIntakeStep } = require('../pipeline');
  const { output, nextState } = await runIntakeStep(baseInput, 1, { noClarification: true, path: true, pathMode: rebuildMode(managerInput) });
  if (deal?.last_composer_output && typeof deal.last_composer_output === 'object') {
    output.composer_output = { ...deal.last_composer_output, _sent_history: sentHistoryAfter(deal.last_composer_output) };
  }
  delete output._intakeRoundLimitNote; // перестройка — не «не удалось уточнить», а обычный путь
  output._intake_rounds = 1;
  output._awaitingCorrectionConfirmation = false;
  output._pendingManagerFeedback = null;
  output._rebuildNote = '_Учёл новое — перестраиваю путь: оценка → стратегия → касания._';
  // Сроки считаются из шапки сделки — если менеджер пишет о новой дате, напомнить.
  if (/(перенес|сдвин|новая дат|теперь к|открыти[ея][^.]{0,30}\d)/i.test(String(managerInput || ''))) {
    output._rebuildNote += '\n\n_Если изменилась дата, к которой нужно клиенту, — обновите «Сроки» в шапке сделки: расчёт берётся оттуда._';
  }
  return { nextState, output };
}

async function composing(ctx) {
  const { deal, managerInput } = ctx;
  if (deal.awaiting_correction_confirmation) return awaitingCorrection(ctx);
  const modeCmd = modeCommand(managerInput);
  if (ctx.opts?.path && modeCmd && deal.last_strategy_output) return switchPathMode(ctx, modeCmd);
  if (ctx.opts?.path && !isPureApproval(managerInput) && isNewFacts(managerInput)) return rebuildPath(ctx);
  if (isPureApproval(managerInput)) return accept(ctx);
  return isManagerQuestion(managerInput) ? managerQuestion(ctx) : managerEdit(ctx);
}

module.exports = { channelKey, composing, composedOutput, isNewFacts };

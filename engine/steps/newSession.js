/**
 * Этап FINAL_OUTPUT — сессия завершена; следующее сообщение менеджера
 * сразу начинает новую сессию по той же сделке (без «пустого» хода).
 */
const { runIntakeStep } = require('../pipeline');

async function newSession({ baseInput }) {
  const { output, nextState } = await runIntakeStep(baseInput, 1);
  // Новая сессия — счётчики и флаги ожидания не наследуются от предыдущей
  // (в том числе исчерпанный лимит ручных попыток после эскалации, баг №35).
  output._intake_rounds = 1;
  output._escalation_retries = 0;
  output._awaitingEscalationConfirmation = false;
  output._pendingEscalationFeedback = null;
  return { nextState, output };
}

module.exports = { newSession };

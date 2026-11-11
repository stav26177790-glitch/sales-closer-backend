/**
 * Этапы INIT / COLLECTING / SOPRANO_INTERVIEW — приём материалов по сделке:
 * planner → diagnostic, при необходимости уточняющие вопросы менеджеру.
 */
const { runIntakeStep } = require('../pipeline');
const { formatAgentReplyForChat } = require('../chat');

async function intake({ deal, baseInput }) {
  // Раунд против MAX_INTAKE_ROUNDS считается только когда мы уже КРУТИЛИСЬ
  // в SOPRANO_INTERVIEW (менеджер отвечает на уточняющий вопрос заново) —
  // самый первый заход в уточнения из INIT/COLLECTING не расходует лимит.
  const isLoopingInterview = deal.current_state === 'SOPRANO_INTERVIEW';
  const intakeRounds = isLoopingInterview ? (deal.intake_rounds || 1) + 1 : 1;
  const { output, nextState } = await runIntakeStep(baseInput, intakeRounds);
  output._intake_rounds = intakeRounds;
  if (output._intakeRoundLimitNote) {
    output._directText = `${output._intakeRoundLimitNote}\n\n${formatAgentReplyForChat(nextState, output)}`;
  }
  return { nextState, output };
}

module.exports = { intake };

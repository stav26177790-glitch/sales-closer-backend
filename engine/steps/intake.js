/**
 * Этапы INIT / COLLECTING / SOPRANO_INTERVIEW — приём материалов по сделке:
 * planner → diagnostic, при необходимости уточняющие вопросы менеджеру.
 */
const { runIntakeStep } = require('../pipeline');
const { formatAgentReplyForChat } = require('../chat');

// Проверка фактов до старта пути (2026-11-13): без срока клиента и срока
// производства Клоузер не посчитает, успеваем ли, — а весь путь (оценка →
// стратегия → касания) строится на этом. Один короткий вопрос лучше трёх минут
// работы впустую. Спрашиваем один раз: следующий ответ менеджера («без срока»,
// «продолжи» или сохранённые «Сроки») — идём дальше с тем, что есть.
const ASK_TIMELINE = 'Чтобы построить путь, нужны сроки: **когда клиенту нужно** и **сколько рабочих дней производство**. ' +
  'Нажмите «Сроки» в шапке сделки и сохраните, затем напишите «продолжи». ' +
  'Если у клиента срока нет — напишите «без срока».';

async function intake({ deal, baseInput, opts }) {
  // Только в режиме пути (engine/autoFlow.js) — пошаговый режим и старые сценарии как были.
  if (opts?.path && deal.current_state === 'INIT' && (!deal.client_deadline || !deal.production_days)) {
    return { nextState: 'SOPRANO_INTERVIEW', output: { _directText: ASK_TIMELINE, _intake_rounds: 0 } };
  }
  // Раунд против MAX_INTAKE_ROUNDS считается только когда мы уже КРУТИЛИСЬ
  // в SOPRANO_INTERVIEW (менеджер отвечает на уточняющий вопрос заново) —
  // самый первый заход в уточнения из INIT/COLLECTING не расходует лимит.
  // intake_rounds = 0 — была только проверка сроков, уточнений ещё не было.
  const isLoopingInterview = deal.current_state === 'SOPRANO_INTERVIEW';
  const intakeRounds = isLoopingInterview ? (deal.intake_rounds ?? 1) + 1 : 1;
  const { output, nextState } = await runIntakeStep(baseInput, intakeRounds);
  output._intake_rounds = intakeRounds;
  if (output._intakeRoundLimitNote) {
    output._directText = `${output._intakeRoundLimitNote}\n\n${formatAgentReplyForChat(nextState, output)}`;
  }
  return { nextState, output };
}

module.exports = { intake };

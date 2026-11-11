/**
 * Какой обработчик отвечает за какой этап сделки (deals.current_state).
 * Каждый обработчик получает контекст хода и возвращает { nextState, output }.
 */
const { intake } = require('./intake');
const { diagnosing } = require('./diagnosing');
const { conflictResolution } = require('./conflict');
const { strategySelection } = require('./strategySelection');
const { composing } = require('./composing');
const { reviewing } = require('./reviewing');
const { escalation } = require('./escalation');
const { finalize } = require('./finalize');
const { newSession } = require('./newSession');

const STEP_HANDLERS = {
  INIT: intake,
  COLLECTING: intake,
  SOPRANO_INTERVIEW: intake,
  DIAGNOSING: diagnosing,
  CONFLICT_RESOLUTION: conflictResolution,
  STRATEGY_SELECTION: strategySelection,
  COMPOSING: composing,
  REVIEWING: reviewing,
  ESCALATION: escalation,
  MEMORY_UPDATE: finalize,
  LOST_DEAL: finalize,
  DISQUALIFICATION: finalize,
  FINAL_OUTPUT: newSession,
};

module.exports = { STEP_HANDLERS };

/**
 * Этап CONFLICT_RESOLUTION — оценка агента разошлась с самооценкой
 * менеджера; ответ менеджера уходит в diagnostic как новые факты.
 */
const { callAgentSafe, cleanManagerConflicts } = require('../pipeline');

async function conflictResolution({ baseInput, managerInput }) {
  const output = {};
  const diagnosticResult = await callAgentSafe('diagnostic', {
    ...baseInput,
    manager_conflict_response: { new_facts: managerInput }
  });
  output.diagnostic_output = diagnosticResult?.diagnostic_output || diagnosticResult;
  cleanManagerConflicts(output.diagnostic_output, baseInput);
  return { nextState: 'DIAGNOSING', output };
}

module.exports = { conflictResolution };

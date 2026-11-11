/**
 * Этап DIAGNOSING — диагностика показана менеджеру, выбираем стратегию.
 * Потерянная или неквалифицированная сделка сразу закрывает сессию итогом.
 */
const { callAgentSafe, runMemoryUpdate } = require('../pipeline');
const { isDisqualificationStrategy } = require('../chat');

async function diagnosing({ dealId, deal, baseInput }) {
  const output = {};
  const strategyResult = await callAgentSafe('strategy', { ...baseInput, diagnostic_output: deal.last_diagnostic_output });
  output.strategy_output = strategyResult?.strategy_output || strategyResult;

  if (output.strategy_output?.deal_health === 'потеряна') {
    output._finalText = await runMemoryUpdate(dealId, baseInput, deal, {
      strategy_output: output.strategy_output,
      statusNote: 'Статус: сделка отмечена как потерянная.'
    });
    return { nextState: 'FINAL_OUTPUT', output };
  }
  // primary_strategy бывает строкой или объектом, название — русским или
  // старым английским: всё это учитывает isDisqualificationStrategy().
  if (isDisqualificationStrategy(output.strategy_output)) {
    output._finalText = await runMemoryUpdate(dealId, baseInput, deal, {
      strategy_output: output.strategy_output,
      statusNote: 'Статус: сделка не квалифицирована.'
    });
    return { nextState: 'FINAL_OUTPUT', output };
  }
  return { nextState: 'STRATEGY_SELECTION', output };
}

module.exports = { diagnosing };

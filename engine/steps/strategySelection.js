/**
 * Этап STRATEGY_SELECTION — стратегия показана менеджеру, пишем касания.
 */
const { runComposer } = require('../pipeline');
const { CONFIG } = require('../config');

async function strategySelection({ deal, memory, baseInput }) {
  const output = {};
  output.composer_output = await runComposer(baseInput, deal, {
    channelHistory: memory?.do_not_repeat?.channels_last_used?.slice(0, CONFIG.CHANNEL_HISTORY_SIZE) || [],
    iteration: 1
  });
  return { nextState: 'COMPOSING', output };
}

module.exports = { strategySelection };

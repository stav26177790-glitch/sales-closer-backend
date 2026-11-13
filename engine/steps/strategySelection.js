/**
 * Этап STRATEGY_SELECTION — стратегия показана менеджеру.
 * «ок» / «пиши касания» → пишем касания. Иначе сообщение менеджера — правка
 * стратегии или новые факты: стратегия пересобирается с их учётом.
 */
const { runComposer } = require('../pipeline');
const { CONFIG } = require('../config');
const { isGoAhead } = require('../intent');
const { runStrategy } = require('./diagnosing');

async function strategySelection(ctx) {
  const { deal, memory, baseInput, managerInput } = ctx;
  if (!isGoAhead(managerInput)) return runStrategy(ctx, managerInput);
  const output = {};
  output.composer_output = await runComposer(baseInput, deal, {
    channelHistory: memory?.do_not_repeat?.channels_last_used?.slice(0, CONFIG.CHANNEL_HISTORY_SIZE) || [],
    iteration: 1
  });
  return { nextState: 'COMPOSING', output };
}

module.exports = { strategySelection };

/**
 * Этап STRATEGY_SELECTION — стратегия показана менеджеру.
 * «ок» / «пиши касания» → пишем касания. Иначе сообщение менеджера — правка
 * стратегии или новые факты: стратегия пересобирается с их учётом.
 */
const { CONFIG } = require('../config');
const { isGoAhead } = require('../intent');
const { runStrategy } = require('./diagnosing');
const { composeUntilReady } = require('../autoCompose');
const { composedOutput } = require('./composing');

async function strategySelection(ctx) {
  const { deal, memory, baseInput, managerInput } = ctx;
  if (!isGoAhead(managerInput)) return runStrategy(ctx, managerInput);
  // Касания составляются, проверяются и дорабатываются сами (engine/autoCompose.js).
  const res = await composeUntilReady(baseInput, deal, {
    channelHistory: memory?.do_not_repeat?.channels_last_used?.slice(0, CONFIG.CHANNEL_HISTORY_SIZE) || []
  });
  return { nextState: 'COMPOSING', output: composedOutput(res) };
}

module.exports = { strategySelection };

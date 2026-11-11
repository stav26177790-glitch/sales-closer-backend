/**
 * Этапы MEMORY_UPDATE / LOST_DEAL / DISQUALIFICATION — страховка: если
 * сделка когда-либо осталась в одном из них, следующее сообщение менеджера
 * сразу закрывает сессию итогом.
 */
const { runMemoryUpdate } = require('../pipeline');

async function finalize({ dealId, deal, baseInput }) {
  const output = {};
  output._finalText = await runMemoryUpdate(dealId, baseInput, deal);
  return { nextState: 'FINAL_OUTPUT', output };
}

module.exports = { finalize };

/**
 * Этап REVIEWING — остался от прежнего порядка (касания → «ок» → проверка →
 * «дальше» → доработка). Новые сделки сюда не попадают: касания
 * проверяются и дорабатываются сами (engine/autoCompose.js). Сделки, которые
 * застряли здесь до обновления: любое сообщение — доработка по замечаниям
 * проверки в автоцикле.
 */
const { runMemoryUpdate } = require('../pipeline');
const { composeUntilReady } = require('../autoCompose');
const { composedOutput } = require('./composing');

async function reviewing({ dealId, deal, baseInput }) {
  if (deal.last_reviewer_output?.verdict === 'ОДОБРЕНО') {
    return { nextState: 'FINAL_OUTPUT', output: { _finalText: await runMemoryUpdate(dealId, baseInput, deal) } };
  }
  const res = await composeUntilReady(baseInput, deal, { feedback: deal.last_reviewer_output });
  return { nextState: 'COMPOSING', output: composedOutput(res) };
}

module.exports = { reviewing };

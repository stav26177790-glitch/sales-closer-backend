/**
 * db.mock.js — минимальная in-memory заглушка для db.js, достаточная,
 * чтобы stateMachine.js можно было require() и вызвать advance() без
 * реальной базы. Используется ТОЛЬКО в этом unit-тесте.
 */
let deal = null; // выставляется тестом перед вызовом advance()
const savedStates = [];
const savedMemories = [];

function setDeal(d) {
  deal = { ...d };
}

module.exports = {
  __setDeal: setDeal,
  __getSavedStates: () => savedStates,
  __getSavedMemories: () => savedMemories,
  async getDeal(dealId) {
    if (!deal) throw new Error('db.mock: сделка не выставлена, вызови __setDeal() перед advance()');
    return deal;
  },
  async loadMemory(dealId) {
    return null; // первая сессия — memory ещё нет
  },
  async getMessages(dealId) {
    return []; // история диалога пуста для этого теста, не участвует в проверке
  },
  async updateDealState(dealId, statePatch) {
    savedStates.push(statePatch);
    deal = { ...deal, ...statePatch };
  },
  async saveMemory(dealId, memoryOutput) {
    savedMemories.push(memoryOutput);
  }
};

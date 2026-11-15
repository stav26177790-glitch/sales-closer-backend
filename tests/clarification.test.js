// Режим пути: planner/diagnostic не останавливают путь вопросами, если материал есть
// (прогон DeepSeek, 16 ситуаций, 15.11: «оцените клиента по 5 критериям» на полной переписке).
const assert = require('assert');
const { dropNeedlessClarification } = require('../engine/clarification');
let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }
const long = 'Марина (28.10): Добрый день! Открываем вторую кофейню на Покровке. '.repeat(6);
check('длинная переписка — вопросы снимаются, путь идёт дальше', () => {
  const p = { clarification_needed: { required: true, questions: ['Оцените клиента по 5 критериям'] } };
  dropNeedlessClarification(p, { materials: { source_materials: { text: long } } });
  assert.equal(p.clarification_needed.required, false);
  assert.deepEqual(p.clarification_needed.dropped_questions, ['Оцените клиента по 5 критериям']);
});
check('материала почти нет — вопросы остаются', () => {
  const p = { clarification_needed: { required: true, questions: ['Что за клиент?'] } };
  dropNeedlessClarification(p, { materials: { source_materials: { text: 'Клиент интересуется вывеской.' } } });
  assert.equal(p.clarification_needed.required, true);
});
console.log(`clarification: ${n} проверок пройдено`);

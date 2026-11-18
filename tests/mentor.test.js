'use strict';
const assert = require('assert');
const { mentorWhy } = require('../engine/mentor');
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
check('наставник: цель + критерий формулы + сценарий + тон; без плана — пусто', () => {
  const w = mentorWhy({ goal: 'Восстановить контакт с Алиной. Инструмент доверия: визуализация', criterion: 'Д — доверие', kind: 'эмпатичное', scenarios: ['negative'], how: '' });
  assert.ok(/^Цель: Восстановить контакт с Алиной — двигаем «Д \(доверие\)»/.test(w[0]), w[0]);
  assert.ok(/ВПР/.test(w[1]));
  assert.deepEqual(mentorWhy(null), []);
});
check('наставник: последний шанс, follow-up, условие; не больше 4 строк', () => {
  const w = mentorWhy({ last_chance: true, how: 'FOLLOW-UP после звонка', scenarios: ['torg', 'dorogo'], condition: 'Алина даст контакт' });
  assert.ok(/Последний шанс/.test(w[0]));
  assert.ok(w.length <= 4);
});
console.log(`mentor: ${n} проверок пройдено`);

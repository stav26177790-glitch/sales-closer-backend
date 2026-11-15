// Дата клиента в сроках: календарик и «как пишут люди» (живой «Зерно 9», 15.11).
const assert = require('assert');
const { parseClientDate } = require('../engine/clientDate');
let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }
const today = new Date(Date.UTC(2026, 10, 15));
check('календарик: 2026-12-01', () => assert.equal(parseClientDate('2026-12-01', today), '2026-12-01'));
check('01.12.2026, 1.12.2026, 1/12/2026, 1.12.26', () => {
  for (const v of ['01.12.2026', '1.12.2026', '1/12/2026', '1.12.26', ' 01.12.2026 ']) assert.equal(parseClientDate(v, today), '2026-12-01', v);
});
check('без года — ближайшее будущее: 1.12 → 2026, 10.01 → 2027', () => {
  assert.equal(parseClientDate('1.12', today), '2026-12-01');
  assert.equal(parseClientDate('10.01', today), '2027-01-10');
});
check('неверное — null: 31.02.2026, «1 декабря», пусто', () => {
  for (const v of ['31.02.2026', '1 декабря', '', null, '13.13.2026']) assert.equal(parseClientDate(v, today), null, String(v));
});
console.log(`clientDate: ${n} проверок пройдено`);

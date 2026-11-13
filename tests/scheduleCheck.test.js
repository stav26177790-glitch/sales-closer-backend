/**
 * Календарь касаний против сроков (engine/scheduleCheck.js).
 * Живой тест 2026-11-13: касания 4 и 5 уходили 20 и 25 ноября и говорили «до 19 ноября».
 */
const assert = require('assert');
const t = require('../engine/timeline');
const { findScheduleIssues, applyScheduleCheck, sendDate, workingDaysAhead } = require('../engine/scheduleCheck');

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }
const tl = t.computeTimeline({ today: '2026-11-13', clientDeadline: '2026-12-01', productionDays: 12 });
const live = [
  { touchpoint_number: 1, timing: 'Сегодня, 13 ноября', body: 'При старте до 19 ноября успеваем к открытию.' },
  { touchpoint_number: 2, timing: 'На следующий день после касания 1, если Марина не дала контакт', body: 'баннер при старте до 19 ноября будет готов к открытию' },
  { touchpoint_number: 3, timing: 'Только если Марина дала контакт', body: 'при старте до 19 ноября' },
  { touchpoint_number: 4, timing: 'Через 5 рабочих дней после касания 1, если нет ответа', body: 'времени до 19 ноября немного' },
  { touchpoint_number: 5, timing: 'Через 3 рабочих дня после касания 4, если нет ответа', body: '19 ноября — последний день' }
];

check('живой «Зерно»: касания 4 (20.11) и 5 (25.11) называют прошедшее 19 ноября', () => {
  assert.deepEqual(findScheduleIssues(live, tl).map((h) => h.touchpoint_number), [4, 5]);
});
check('дата в timing важнее «через N дней»; «после касания K» считается от K', () => {
  assert.equal(sendDate('Через 5 раб. дн. — 20 ноября (пт)', '2026-11-13'), '2026-11-20');
  assert.equal(sendDate('Через 3 рабочих дня после касания 4', '2026-11-13', { 4: '2026-11-20' }), '2026-11-25');
  assert.equal(sendDate('Только если согласится', '2026-11-13'), null);
});
check('касание до срока или без срока в тексте — не ошибка', () => {
  const ok = [{ touchpoint_number: 1, timing: 'Через 3 раб. дн. — 18 ноября (ср)', body: 'до 19 ноября успеваем' }, { touchpoint_number: 2, timing: 'Через 6 раб. дн. — 23 ноября', body: 'постоянная будет готова позже' }];
  assert.equal(findScheduleIssues(ok, tl).length, 0);
});
check('ошибка снимает одобрение касания', () => {
  const r = { verdict: 'ОДОБРЕНО', messages_reviewed: [4, 5].map((x) => ({ touchpoint_number: x, verdict: 'ОДОБРЕНО' })) };
  applyScheduleCheck(r, live, tl);
  assert.equal(r.verdict, 'НА ДОРАБОТКУ');
  assert.ok(r.messages_reviewed.every((m) => m.verdict === 'НА ДОРАБОТКУ' && m.failed_criteria.includes('schedule')));
});
check('календарь рабочих дней: 5-й рабочий день после 13.11 — 20 ноября (пт)', () => {
  assert.equal(workingDaysAhead('2026-11-13')[4], 'через 5 раб. дн. — 20 ноября (пт)');
});
console.log(`scheduleCheck: ${n} проверок пройдено`);

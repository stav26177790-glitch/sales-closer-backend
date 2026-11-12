/**
 * Проверки расчёта сроков (engine/timeline.js). Даты фиксированы —
 * результат не зависит от того, в какой день запускается тест.
 */
const assert = require('assert');
const t = require('../engine/timeline');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const base = { clientDeadline: '2026-12-01', productionDays: 12, installDaysMin: 2, installDaysMax: 3 };

check('выходные и праздник 4 ноября — нерабочие', () => {
  assert.equal(t.isWorkingDay('2026-11-14'), false); // суббота
  assert.equal(t.isWorkingDay('2026-11-04'), false); // праздник
  assert.equal(t.isWorkingDay('2026-11-12'), true);  // четверг
});

check('старт 12 ноября: к 1 декабря не успеваем', () => {
  const r = t.computeTimeline({ ...base, today: '2026-11-12' });
  assert.equal(r.ready_by, '2026-11-30');
  assert.equal(r.if_start_today.production_done, '2026-11-30');
  assert.equal(r.if_start_today.installed_earliest, '2026-12-02');
  assert.equal(r.if_start_today.installed_latest, '2026-12-03');
  assert.equal(r.latest_start_date, '2026-11-09');
  assert.equal(r.status, 'не успеваем');
});

check('старт 10 ноября: впритык, только при быстром монтаже', () => {
  const r = t.computeTimeline({ ...base, today: '2026-11-10' });
  assert.equal(r.status, 'впритык');
  assert.equal(r.if_start_today.installed_earliest, '2026-11-30');
});

check('старт 2 ноября: с запасом', () => {
  const r = t.computeTimeline({ ...base, today: '2026-11-02' });
  assert.equal(r.status, 'с запасом');
  assert.ok(r.buffer_working_days > 0);
});

check('новогодние праздники пропускаются', () => {
  assert.equal(t.addWorkingDays('2026-12-30', 1), '2027-01-11');
});

check('нет даты клиента или срока производства — null', () => {
  assert.equal(t.computeTimeline({ today: '2026-11-12', clientDeadline: null, productionDays: 12 }), null);
  assert.equal(t.computeTimeline({ today: '2026-11-12', clientDeadline: '2026-12-01', productionDays: null }), null);
});

check('дата клиента уже прошла — просим проверить, не считаем', () => {
  const r = t.computeTimeline({ ...base, clientDeadline: '2026-11-01', today: '2026-11-12' });
  assert.equal(r.status, 'дата прошла');
  assert.equal(r.ready_by, undefined);
});

console.log(`timeline: ${passed} проверок пройдено`);

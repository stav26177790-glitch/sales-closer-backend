'use strict';
// Аудит 18.11: «не Москва» было в двух вариантах — проверки требовали московских запретов в Мытищах.
const assert = require('assert');
const geo = require('../engine/geo');
const { findPlanIssues } = require('../engine/planChecks');
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
check('Москва / Подмосковье / не ясно', () => {
  assert.ok(geo.isMoscow('Москва, ул. Бауманская, 11 (м. Бауманская)'));
  assert.ok(!geo.isMoscow('Мытищи, Олимпийский проспект, 29') && geo.clearlyNotMoscow('Мытищи, Олимпийский проспект, 29'));
  assert.ok(geo.moscowOrUnknown('нужна вывеска на кафе') && !geo.clearlyNotMoscow('нужна вывеска на кафе'));
});
check('Мытищи: световой короб — без московского запрета; Москва — с ним', () => {
  const msg = [{ touchpoint_number: 1, channel: 'Звонок', body: 'Сергей Петрович, если по бюджету не сходится — можно световой короб вместо букв, выйдет дешевле.' }];
  const plan = [{ touchpoint_number: 1, channel: 'Звонок', kind: 'экспертное' }];
  const fixes = (src) => findPlanIssues(msg, plan, src).flatMap((x) => x.fixes || x.issues || [x]).map(String).join(' | ');
  assert.ok(!/инкрустац/i.test(fixes('Автосервис, Мытищи, Олимпийский проспект, 29')), fixes('Мытищи'));
  assert.ok(/инкрустац/i.test(fixes('Москва, м. Бауманская')), 'Москва: запрет короба должен остаться');
});
console.log(`geo: ${n} проверок пройдено`);

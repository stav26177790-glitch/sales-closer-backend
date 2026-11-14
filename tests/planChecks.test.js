/**
 * engine/planChecks.js — владелец 14.11: «последний шанс» последним касанием;
 * альтернатива подешевле — с логикой компромисса («есть риск», отход от ТЗ).
 */
const assert = require('assert');
const { findPlanIssues } = require('../engine/planChecks');

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

const plan = [1, 2, 3, 4].map((i) => ({ touchpoint_number: i, last_chance: i === 4 }));

check('«есть ли у меня шанс» не в последнем касании — на доработку', () => {
  const r = findPlanIssues([{ touchpoint_number: 2, body: 'Марина, есть ли у меня реальный шанс на этот проект?' }], plan);
  assert.equal(r.length, 1);
  assert.ok(/только в последнем касании \(4/.test(r[0].fixes[0]));
});
check('последний шанс без просьбы сказать как есть — на доработку; с ней — ок', () => {
  assert.equal(findPlanIssues([{ touchpoint_number: 4, body: 'Марина, напоминаю про вывеску.' }], plan).length, 1);
  assert.equal(findPlanIssues([{ touchpoint_number: 4, body: 'Марина, скажите как есть: проект ещё актуален? Если нет — не буду больше отвлекать, чтобы не тратить ваше время.' }], plan).length, 0);
  assert.equal(findPlanIssues([{ touchpoint_number: 4, body: 'Понимаю, что моё решение, возможно, не подошло. Подскажите, что я сделал не так?' }], plan).length, 0);
});
check('без плана с «последним шансом» вопрос о шансе не трогаем', () => {
  assert.equal(findPlanIssues([{ touchpoint_number: 1, body: 'Скажите как есть — проект актуален?' }], null).length, 0);
});
check('альтернатива подешевле без риска — на доработку (Зерно 7: «скорректировать размер или материал»)', () => {
  const r = findPlanIssues([{ touchpoint_number: 2, body: 'Андрей, подберу варианты под ваш бюджет — например, буквы поменьше или пластиковый борт. Посчитаю и пришлю.' }], plan);
  assert.equal(r.length, 1);
  assert.ok(/отход от ТЗ/.test(r[0].fixes[0]));
});
check('альтернатива с риском и отходом от ТЗ — ок', () => {
  const body = 'Андрей, чтобы вы не переплачивали, подберу варианты под ваш бюджет. Скажу честно: это отход от ТЗ. Если уменьшить буквы — вывеску хуже видно издалека; пластиковый борт вместо алюминиевого — есть риск, что прослужит меньше.';
  assert.equal(findPlanIssues([{ touchpoint_number: 2, body }], plan).length, 0);
});
check('Москва, 902-ПП: «буквы без подсветки» — нельзя; не Москва — можно', () => {
  const body = 'Андрей, чтобы вы не переплачивали, подберу варианты под ваш бюджет. Это отход от ТЗ: буквы без подсветки — вечером вывеску не видно.';
  assert.ok(findPlanIssues([{ touchpoint_number: 2, body }], plan, 'Открываем кофейню на Покровке').some((h) => /902-ПП/.test(h.fixes.join(' '))));
  assert.equal(findPlanIssues([{ touchpoint_number: 2, body }], plan, 'Предприятие в Тверской области').length, 0);
});
check('Москва, 902-ПП: короб вместо букв — только с инкрустацией', () => {
  const bad = 'Андрей, подберу варианты под ваш бюджет. Это отход от ТЗ: световой короб вместо букв выглядит проще.';
  const ok = 'Андрей, подберу варианты под ваш бюджет. Это отход от ТЗ: световой короб вместо букв по технологии псевдоинкрустации выглядит проще.';
  assert.ok(findPlanIssues([{ touchpoint_number: 2, body: bad }], plan, '').some((h) => /инкрустац/.test(h.fixes.join(' '))));
  assert.equal(findPlanIssues([{ touchpoint_number: 2, body: ok }], plan, '').length, 0);
});
console.log(`planChecks: ${n} проверок пройдено`);

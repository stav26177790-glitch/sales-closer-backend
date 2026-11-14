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
  const r = findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body: 'Андрей, подберу варианты под ваш бюджет — например, буквы поменьше или пластиковый борт. Посчитаю и пришлю.' }], plan);
  assert.equal(r.length, 1);
  assert.ok(/отход от ТЗ/.test(r[0].fixes[0]));
});
check('альтернатива с риском и отходом от ТЗ — ок', () => {
  const body = 'Андрей, чтобы вы не переплачивали, подберу варианты под ваш бюджет. Скажу честно: это отход от ТЗ. Если уменьшить буквы — вывеску хуже видно издалека; пластиковый борт вместо алюминиевого — есть риск, что прослужит меньше.';
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body }], plan).length, 0);
});
check('Москва, 902-ПП: «буквы без подсветки» — нельзя; не Москва — можно', () => {
  const body = 'Андрей, чтобы вы не переплачивали, подберу варианты под ваш бюджет. Это отход от ТЗ: буквы без подсветки — вечером вывеску не видно.';
  assert.ok(findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body }], plan, 'Открываем кофейню на Покровке').some((h) => /902-ПП/.test(h.fixes.join(' '))));
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body }], plan, 'Предприятие в Тверской области').length, 0);
});
check('Москва, 902-ПП: короб вместо букв — только с инкрустацией', () => {
  const bad = 'Андрей, подберу варианты под ваш бюджет. Это отход от ТЗ: световой короб вместо букв выглядит проще.';
  const ok = 'Андрей, подберу варианты под ваш бюджет. Это отход от ТЗ: световой короб вместо букв по технологии псевдоинкрустации выглядит проще.';
  assert.ok(findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body: bad }], plan, '').some((h) => /инкрустац/.test(h.fixes.join(' '))));
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body: ok }], plan, '').length, 0);
});
check('временная вывеска: в Москве — только «внутри»; не Москва — без требования', () => {
  const t = 'Марина, баннер успевает к открытию — гости найдут вас с первого дня.';
  assert.ok(findPlanIssues([{ touchpoint_number: 1, body: t }], plan, 'кофейня на Покровке').some((h) => /внутри помещения/.test(h.fixes.join(' '))));
  assert.equal(findPlanIssues([{ touchpoint_number: 1, body: 'Марина, временную вывеску поставим внутри, в витрине — успевает к открытию.' }], plan, 'Покровка').length, 0);
  assert.equal(findPlanIssues([{ touchpoint_number: 1, body: t }], plan, 'Магазин в Тверской области').length, 0);
});
check('«каждый день ожидания сдвигает дату» — только в одном касании', () => {
  const r = findPlanIssues([
    { touchpoint_number: 1, body: 'При старте сегодня готово 4 декабря. Каждый рабочий день ожидания сдвигает эту дату.' },
    { touchpoint_number: 3, body: 'Марина, напомню: каждый день задержки сдвигает готовность.' }
  ], plan, '');
  assert.deepEqual(r.map((h) => h.touchpoint_number), [3]);
});
// Владелец 14.11 (правило): всё, что касается денег, — только звонок или Zoom.
check('деньги в мессенджере — на доработку; звонок / Zoom — ок; предложение созвониться — ок; цена КП как факт — ок', () => {
  const t = 'Марина, по бюджету: подберу варианты, чтобы вы не переплачивали.';
  assert.ok(findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: t }], plan, 'Покровка').some((h) => /звонком или в Zoom/.test(h.fixes.join(' '))));
  assert.ok(!findPlanIssues([{ touchpoint_number: 1, channel: 'Zoom', body: t + ' Это отход от ТЗ, есть риск.' }], plan, '').length);
  assert.ok(!findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Марина, по стоимости баннера удобнее голосом — созвонимся сегодня на 5 минут?' }], plan, '').length);
  assert.ok(!findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Андрей, КП на вывеску — 185 000 ₽ с монтажом, цена фиксированная.' }], plan, '').length);
});
check('прогон 14.11: «в понедельник в 10:00 наберу вас» — давление; «удобно, если наберу?» — ок', () => {
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Кружок', body: 'Марина, в понедельник в 10:00 наберу вас.' }], plan, '').length, 1);
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Кружок', body: 'Марина, удобно, если наберу в понедельник утром?' }], plan, '').length, 0);
});
console.log(`planChecks: ${n} проверок пройдено`);

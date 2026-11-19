/**
 * Живой тест владельца 19.11 («Рёбра & Угли», Пятницкая): Зеркало при зелёной формуле, повтор приёма тому же
 * человеку, «фриза нет», бренд по КП в переписке, безымянный «похожий бизнес».
 */
const assert = require('assert');
const { attachScenarios } = require('../engine/scenarios');
const { findPlanIssues } = require('../engine/planChecks');
const { detectBrand } = require('../engine/brand');
const { findBannedPhrases } = require('../engine/phraseCheck');
let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }
const addHow = (x, t) => { x.how = [...(x.how || []), t]; };
const SRC = 'Армен: «Ольга, всё нравится. Сделаете 230 — подписываем завтра».';

check('Доверие закрыто + торг: звонок помечен mirror, без «на моём месте» — на правку', () => {
  const st = [{ touchpoint_number: 1, channel: 'Звонок', kind: 'экспертное' }];
  attachScenarios(st, SRC, addHow, { trustOk: true });
  assert.ok(st[0].mirror && /ПЕРВЫЙ ход в этом звонке «Зеркало»/.test(st[0].how.join(' ')));
  const bad = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Армен, 230 не смогу, у меня таких полномочий нет.' }], st);
  assert.ok(bad.some((r) => r.fixes.some((f) => /Зеркало/.test(f))));
  const ok = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Меньше цену я сделать не могу. А вы бы как поступили на моём месте?) Дали бы скидку?' }], st);
  assert.ok(!ok.some((r) => r.fixes.some((f) => /Зеркало/.test(f))));
});
check('без Доверия — Зеркала нет', () => {
  const st = [{ channel: 'Звонок', kind: 'экспертное' }];
  attachScenarios(st, SRC, addHow, { trustOk: false });
  assert.ok(!st[0].mirror);
});
check('приём отработки тому же человеку второй раз — на правку', () => {
  const plan = [1, 4].map((t) => ({ touchpoint_number: t, recipient: 'Армен Гарегинович (владелец)' }));
  const r = findPlanIssues([
    { touchpoint_number: 1, channel: 'Звонок', body: 'Вы хороший переговорщик. А в целом решение вам подходит?' },
    { touchpoint_number: 4, channel: 'Звонок', body: 'Слушайте, ну вы прям крутой переговорщик!) А что кроме цены?' }], plan);
  assert.ok(r.some((x) => x.touchpoint_number === 4 && x.fixes.some((f) => /переговорщик/.test(f))));
});
check('бренд — по КП в переписке, если продукт не заполнен', () => {
  assert.equal(detectBrand({ industry: 'signage' }, 'Я (12.11): отправила КП: 285 000 ₽ — световые буквы из нержавеющей стали'), 'Металл Буква Экспресс');
  assert.equal(detectBrand({ industry: 'signage' }, ''), null);
});
check('«похожий бизнес уже работает с нашей вывеской» — безымянный кейс', () => {
  const r = findBannedPhrases([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Кстати, похожий бизнес уже работает с нашей вывеской — пришлю фото.' }]);
  assert.ok(r.length);
});
console.log(`live1911: ${n} проверок пройдено`);

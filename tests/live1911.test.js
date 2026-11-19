/**
 * Живой тест владельца 19.11 («Рёбра & Угли», Пятницкая): Зеркало при зелёной формуле, повтор приёма тому же
 * человеку, «фриза нет», безымянный «похожий бизнес».
 */
const assert = require('assert');
const { attachScenarios } = require('../engine/scenarios');
const { findPlanIssues } = require('../engine/planChecks');
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
check('«похожий бизнес уже работает с нашей вывеской» — безымянный кейс', () => {
  const r = findBannedPhrases([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Кстати, похожий бизнес уже работает с нашей вывеской — пришлю фото.' }]);
  assert.ok(r.length);
});
check('итог письмом: «уступка 5%», предоплата 50% без отказа от 70/30, суббота, повторная просьба фото — на правку', () => {
  const src = 'Кристина прислала фото фасада. Армен: «Сделаете 230 — подписываем завтра».';
  const r = findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Резюмирую: 270 750 ₽ с учётом уступки 5% при оплате наличными, предоплата 50%. Созвонимся 21 ноября (сб) в 11:00. Вы присылаете фото фасада — и я фиксирую слот.' }], [{ touchpoint_number: 1 }], src);
  const f = r.flatMap((x) => x.fixes).join(' | ');
  assert.ok(/итоговая сумма/.test(f) && /лестнице/.test(f) && /выходной/.test(f) && /уже прислал/.test(f), f);
});
check('прогон 19.11: «барбершоп похожего формата, которому мы делали», «[фото работы «…»]», «каждый день ожидания его съедает»', () => {
  for (const b of ['Вот барбершоп похожего формата, которому мы делали вывеску', '[фото работы «барбершоп» — из портфолио]', 'Сейчас запас хороший, но каждый день ожидания его съедает.'])
    assert.ok(findBannedPhrases([{ touchpoint_number: 1, channel: 'WhatsApp', body: b }]).length, b);
  assert.ok(!findBannedPhrases([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Делали вывеску для кафе «Капи» — посмотрите.' }]).length);
});
check('деньги письменно: каждое предложение, а не только первое (прогон 19.11, день)', () => {
  const { moneySentences } = require('../engine/planChecks');
  for (const b of ['По цене — давайте обсудим голосом на Zoom. Скажу сразу: 20% так не получится, у меня таких полномочий нет.',
    'По цене без логотипа: посчитаю и пришлю сегодня.', 'КП глянул? По сумме 140 000 попали или не совсем?',
    'Сравнение: что входит в наши 260 000 ₽ и какие вопросы задать по второму предложению.'])
    assert.ok(moneySentences(b).length, b);
  for (const b of ['Цена: 118 000 ₽ с монтажом, без доплат по ходу.', 'По стоимости удобнее голосом: созвонимся сегодня на 5 минут?'])
    assert.ok(!moneySentences(b).length, b);
});
console.log(`live1911: ${n} проверок пройдено`);

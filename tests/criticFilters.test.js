const assert = require('assert');
const { keepCritical } = require('../engine/criticFilters');
let n = 0; const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
check('экзамен 17.11: ложные находки отсеиваются, настоящие остаются', () => {
  assert.equal(keepCritical({ error: '1. Цена клиента', quote: 'могу попробовать согласовать небольшую уступку, если подписываем договор' }), false);
  assert.equal(keepCritical({ error: '1. Цена клиента', quote: 'по цене мы договорились: 650 000 ₽' }), true);
  assert.equal(keepCritical({ error: '1. Цена клиента', quote: 'наши 650 — уже уступка, у меня таких полномочий нет' }), true);
  assert.equal(keepCritical({ error: '3. Упрёк клиенту', quote: 'Помните, мы проговаривали, что пришлёте его?' }), false);
  assert.equal(keepCritical({ error: '3. Упрёк клиенту', quote: 'Пятница прошла, от вас тишина' }), true);
  assert.equal(keepCritical({ error: '2. Обещание', quote: 'вывеска будет у вас к открытию' }, { status: 'впритык' }), false);
  assert.equal(keepCritical({ error: '2. Обещание', quote: 'вывеска будет у вас к открытию' }, { status: 'не успеваем' }), true);
  assert.equal(keepCritical({ error: '6. Деньги письменно', quote: '5%' }, { source: 'Вика: говорить не могу — пишите сюда.' }), false);
});
console.log(`criticFilters: ${n} проверок пройдено`);

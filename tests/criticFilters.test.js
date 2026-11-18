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
check('прогон 8: ложные упрёк / выезд / уступка без суммы отсеиваются', () => {
  assert.equal(keepCritical({ error: '1. Цена клиента', quote: 'Мы согласовали уступку через руководителя — подписываем договор сегодня, вносите 50% предоплаты.' }), false);
  assert.equal(keepCritical({ error: '3. Упрёк клиенту', quote: 'Я понимаю, почему вы осторожны — после того случая с баннером' }), false);
  assert.equal(keepCritical({ error: '7. Менеджер сам едет', quote: 'наш специалист приедет к вам на объект с образцами' }), false);
  assert.equal(keepCritical({ error: '7. Менеджер сам едет', quote: 'Я привезу образец прямо к вам' }), true);
  assert.equal(keepCritical({ error: '1. Цена клиента', quote: 'Вы называли 650 000 ₽, я пошла согласовывать с руководителем. Если получится — подписываем' }), true);
});
check('4 экзамена: «деньги письменно» в звонке — ложно', () => {
  assert.equal(keepCritical({ error: '6. Деньги письменно', quote: 'Какой ориентир по бюджету у вас был?' }, { channel: 'Звонок' }), false);
  assert.equal(keepCritical({ error: '6. Деньги письменно', quote: 'Скидка 5%' }, { channel: 'WhatsApp' }), true);
});
console.log(`criticFilters: ${n} проверок пройдено`);

{
  const { keepCritical, errNo } = require('../engine/criticFilters');
  const assert2 = require('assert');
  assert2.equal(errNo({ error: '10. Неживая речь' }), '10');
  assert2.equal(keepCritical({ error: '10. Неживая речь', quote: 'наберу с одной мыслью' }), true);
  assert2.equal(keepCritical({ error: '10. Неживая речь', quote: 'Скажите как есть: проект актуален?' }), false);
  console.log('  ✓ ошибка 10 (неживая речь): номер из двух цифр; живые формулировки владельца не отсекаются как ошибка');
}

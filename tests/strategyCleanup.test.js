/** Текст стратегии: ранний «спящий режим» и пропущенная просьба клиента — кодом (живые «Зерно 2/4/5»). */
const assert = require('assert');
const { cleanText, SLEEP_RULE } = require('../engine/strategyCleanup');
const { clientPromises, buildMustInclude } = require('../engine/mustInclude');
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
check('«Если после 5 касаний движения нет — перевести в спящий режим.» → правило владельца', () => {
  const r = cleanText('Цепочка: звонок → письмо → кружок. Если после 5 касаний движения нет — перевести в спящий режим.');
  assert.equal(r.fixed, 1);
  assert.ok(r.text.includes(SLEEP_RULE) && r.text.startsWith('Цепочка: звонок'));
});
check('«…честно зафиксировать как потерянную или перевести в спящий режим» после 5 касаний — тоже', () => {
  assert.equal(cleanText('Если после 5 касаний движения нет — честно зафиксировать сделку как потерянную или перевести в спящий режим.').fixed, 1);
});
check('правильное правило (после 7 касаний) не трогаем', () => {
  assert.equal(cleanText('После 7 касаний без ответа — спящий режим на 30–40 рабочих дней.').fixed, 0);
});
check('«Марина (29.10): На козырёк. Логотип пришлю.» → пункт «Обязательно», если стратегия не дала', () => {
  const src = 'Марина (28.10): Добрый день!\nЯ (28.10): Успеваем, если согласуем макет до 10 ноября.\nМарина (29.10): На козырёк. Логотип пришлю. Бюджет у нас примерно 150–200 тысяч.';
  const p = clientPromises(src);
  assert.equal(p.length, 1);
  assert.equal(p[0].quote, 'Логотип пришлю.');
  const list = buildMustInclude({ must_include: ['Касание 1: уточнить, показала ли КП'] }, null, src);
  assert.ok(list.some((x) => x.includes('«Логотип пришлю.»') && x.includes('Помните, мы проговаривали')));
  const list2 = buildMustInclude({ must_include: ['Касание 1 (Марине): попросить логотип — обещала 29.10 («Логотип пришлю»)'] }, null, src);
  assert.equal(list2.filter((x) => x.startsWith('Переписка: 29.10')).length, 0);
});
check('«Получил, передам клиенту» посредника — не обещание прислать нам', () => {
  assert.equal(clientPromises('Сергей (05.11): Получил, передам клиенту, клиент думает.').length, 0);
});
console.log(`strategyCleanup: ${n} проверок пройдено`);

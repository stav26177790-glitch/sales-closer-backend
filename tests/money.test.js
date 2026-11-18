'use strict';
// Полный прогон 18.11: «деньги письменно при доступном голосе» — 22 из 28 «нет».
const assert = require('assert');
const { findPlanIssues } = require('../engine/planChecks');
const { buildTouchPlan } = require('../engine/touchPlan');
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const SRC = 'Кафе «Зерно», КП 290 000 ₽ отправлено. Клиент: посмотрим, подумаем.';
const money = (body, channel = 'Email', src = SRC) => findPlanIssues([{ touchpoint_number: 1, channel, body }], [{ touchpoint_number: 1, channel, kind: 'экспертное' }], src)
  .flatMap((x) => x.fixes || []).some((f) => /о деньгах не писать|голосом: звонком/i.test(f));
check('письменно ловится: состав цены, разница в цене, «за 70 и за 115», «в какую сумму»', () => {
  assert.ok(money('Что входит в 620 000 ₽: буквы, монтаж, гарантия.'));
  assert.ok(money('Разница в цене 40–60 тыс. — это не наценка, а материалы.'));
  assert.ok(money('Разобрали состав цены: материалы, производство, монтаж.'));
  assert.ok(money('Как вам за 20 минут увидеть разницу между вывеской за 70 и за 115 тысяч?', 'WhatsApp'));
  assert.ok(money('Чтобы предложить реальное, в какую сумму хотели бы уложиться?', 'WhatsApp'));
});
check('не ошибка: цена КП фактом, звонок, голос недоступен', () => {
  assert.ok(!money('По КП 290 000 ₽ всё в силе — макет готов, созвонимся завтра в 11?'));
  assert.ok(!money('Что входит в 620 000 ₽: буквы, монтаж, гарантия.', 'Звонок'));
  assert.ok(!money('Что входит в 620 000 ₽: буквы, монтаж, гарантия.', 'WhatsApp', SRC + ' Говорить не могу — пишите сюда.'));
});
check('СОПРАНО: вопрос о бюджете — только в звонок, не в переписку (голос доступен)', () => {
  const strat = { touchpoint_sequence: [
    { number: 1, day: 0, kind: 'экспертное', channel: 'WhatsApp', recipient: 'Олег', goal: 'Визуализация', criterion: 'Д' },
    { number: 2, day: 2, kind: 'экспертное', channel: 'Звонок', recipient: 'Олег', goal: 'Разбор КП', criterion: 'ФВ' },
    { number: 3, day: 5, kind: 'экспертное', channel: 'WhatsApp', recipient: 'Олег', goal: 'Финально', criterion: 'ЗС' }
  ], must_include: [] };
  const log = console.log; console.log = () => {};
  const plan = buildTouchPlan(strat, null, '2026-11-19', null, { source: SRC, mode: 'full', soprano: { 'О2': { status: 'не собрано' }, 'А': { status: 'не собрано' } } });
  console.log = log;
  assert.ok(!/сумм|бюджет/.test(plan[0].how), plan[0].how);
  const call = plan.find((p) => p.channel === 'Звонок' && !p.last_chance);
  assert.ok(call && /в какую сумму|по бюджету/.test(call.how), JSON.stringify(plan.map((p) => [p.channel, p.how.slice(0, 80)])));
});
console.log(`money: ${n} проверок пройдено`);

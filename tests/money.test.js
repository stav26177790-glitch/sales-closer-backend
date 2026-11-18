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
check('торг: «Вы назвали условие — 650… Я готова его принять» — цена клиента принята (ловится); сопротивление — нет', () => {
  const src = 'Я (09.11): Отправила КП: 720 000 ₽ с монтажом. Арсен: «Сделаете 650 — подписываем».';
  const f = (b) => findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: b }], [{ touchpoint_number: 1, channel: 'Звонок', kind: 'экспертное' }], src).flatMap((x) => x.fixes || []).some((x) => /Цену клиента ниже КП/.test(x));
  assert.ok(f('Арсен, вы назвали условие — 650 и 50% предоплаты. Я готова его принять.'));
  assert.ok(!f('650 — точно не смогу, у меня таких полномочий нет. Попробую согласовать небольшую уступку.'));
});
check('прицельный прогон 18.11 («Зерно», Москва): «баннер к 1 декабря успеваем», «откроетесь с вывеской» при «не успеваем» — на правку; «временная внутри» — нет', () => {
  const plan = [{ touchpoint_number: 1, facts: { status_on_send_day: 'не успеваем', permanent_ready_if_start_that_day: '7–8 декабря', temp_banner: 'Временная вывеска к открытию ещё успевает: запустить не позже 20 ноября.' } }];
  const f = (body) => JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body }], plan, 'Кафе, Москва, Покровка 12. КП 290 000 ₽.'));
  assert.ok(/НЕ успевает/.test(f('По баннеру: к 1 декабря успеваем.')));
  assert.ok(/НЕ успевает/.test(f('Так вы откроетесь с вывеской, а постоянную повесим позже.')));
  assert.ok(!/НЕ успевает/.test(f('К 1 декабря постоянную уже не успеваем — готова 7–8 декабря. К открытию можем поставить временную внутри, у входа.')));
});
console.log(`money: ${n} проверок пройдено`);

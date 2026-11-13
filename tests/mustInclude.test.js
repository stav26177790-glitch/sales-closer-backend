/**
 * «Обязательно в касаниях» (engine/mustInclude.js): пункты по срокам из
 * расчёта, слияние со списком стратегии, проверка вердикта reviewer'а.
 */
const assert = require('assert');
const t = require('../engine/timeline');
const { buildMustInclude, applyMustIncludeCheck } = require('../engine/mustInclude');
// pipeline тянет db.js (Supabase) — подменяем пустышкой, как в harness.js.
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {}, children: [], paths: [] };
const { keepApprovedTouches } = require('../engine/pipeline');

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

const zerno = t.computeTimeline({ today: '2026-11-13', clientDeadline: '2026-12-01', productionDays: 12, installDaysMin: 2, installDaysMax: 3 });

check('«не успеваем»: сдвиг основной даты и дата баннера — только для баннера', () => {
  const list = buildMustInclude({ must_include: [] }, zerno);
  assert.equal(list.length, 2);
  assert.ok(list[0].includes('3 декабря (чт) – 4 декабря (пт)'));
  assert.ok(list[0].includes('каждый рабочий день ожидания'));
  assert.ok(list[1].includes('19 ноября (чт)') && list[1].includes('только для временной вывески'));
});

check('«с запасом» или нет сроков — пунктов по срокам нет', () => {
  const ok = t.computeTimeline({ today: '2026-11-02', clientDeadline: '2026-12-01', productionDays: 12 });
  assert.deepEqual(buildMustInclude({}, ok), []);
  assert.deepEqual(buildMustInclude({ must_include: ['Попросить логотип'] }, null), ['Попросить логотип']);
});

check('пункты стратегии идут первыми, повторы убираются', () => {
  const list = buildMustInclude({ must_include: ['Попросить логотип', 'Попросить логотип', { text: 'Сослаться на 28.10' }] }, zerno);
  assert.deepEqual(list.slice(0, 2), ['Попросить логотип', 'Сослаться на 28.10']);
  assert.equal(list.length, 4);
});

check('невыполненный пункт снимает одобрение касания и общего вердикта', () => {
  const r = {
    verdict: 'ОДОБРЕНО',
    messages_reviewed: [{ touchpoint_number: 1, verdict: 'ОДОБРЕНО' }, { touchpoint_number: 2, verdict: 'ОДОБРЕНО' }],
    must_include_check: [
      { item: 1, done: true, touchpoint_number: 2 },
      { item: 2, done: 'false', touchpoint_number: 1, fix: 'Добавить просьбу.' }
    ]
  };
  const { missed } = applyMustIncludeCheck(r, ['Сослаться на 28.10', 'Попросить логотип'], 2);
  assert.deepEqual(missed, [{ item: 2, touchpoint_number: 1 }]);
  assert.equal(r.verdict, 'НА ДОРАБОТКУ');
  assert.equal(r.messages_reviewed[0].verdict, 'НА ДОРАБОТКУ');
  assert.ok(r.messages_reviewed[0].fix_instructions.includes('Попросить логотип'));
  assert.equal(r.messages_reviewed[1].verdict, 'ОДОБРЕНО');
});

check('касание, снятое с одобрения, не замораживается при доработке', () => {
  const r = {
    verdict: 'НА ДОРАБОТКУ',
    messages_reviewed: [{ touchpoint_number: 1, verdict: 'ОДОБРЕНО' }, { touchpoint_number: 2, verdict: 'НА ДОРАБОТКУ' }],
    must_include_check: [{ item: 1, done: false, touchpoint_number: 1 }]
  };
  applyMustIncludeCheck(r, ['Попросить логотип'], 2);
  const prev = { messages: [{ touchpoint_number: 1, body: 'старое 1' }, { touchpoint_number: 2, body: 'старое 2' }] };
  const fresh = { messages: [{ touchpoint_number: 1, body: 'новое 1 с логотипом' }, { touchpoint_number: 2, body: 'новое 2' }] };
  const { output, kept } = keepApprovedTouches(fresh, prev, r);
  assert.deepEqual(kept, []);
  assert.equal(output.messages[0].body, 'новое 1 с логотипом');
});

check('номер касания вне набора → касание 1; нет must_include_check → ничего не меняем', () => {
  const r = { verdict: 'ОДОБРЕНО', messages_reviewed: [], must_include_check: [{ item: 1, done: false, touchpoint_number: 9 }] };
  applyMustIncludeCheck(r, ['X'], 3);
  assert.equal(r.messages_reviewed[0].touchpoint_number, 1);
  const r2 = { verdict: 'ОДОБРЕНО', messages_reviewed: [] };
  const { missed } = applyMustIncludeCheck(r2, ['X'], 3);
  assert.equal(missed.length, 0);
  assert.equal(r2.verdict, 'ОДОБРЕНО');
});

check('пункт стратегии с датами готовности убирается, остальные остаются', () => {
  const live = [
    'Касание 1 (Марине): попросить прислать логотип — обещала 29.10 («Логотип пришлю»)',
    'Касание 1 (Марине): честно сообщить, что постоянная вывеска к 1 декабря не успевает — менеджер 28.10 писал «успеваем, если согласуем макет до 10 ноября»',
    'Во всех касаниях про сроки: постоянная вывеска готова 3–4 декабря (из timeline), баннер при старте до 19 ноября готов 20–24 ноября (из timeline) — других дат не называть.'
  ];
  const list = buildMustInclude({ must_include: live }, zerno);
  assert.ok(list.includes(live[0]) && list.includes(live[1]));
  assert.ok(!list.includes(live[2]));
  assert.equal(list.length, 4);
});

check('прошедшее условие менеджера из переписки добавляется кодом (живой «Зерно 4»)', () => {
  const { managerPromises } = require('../engine/mustInclude');
  const src = 'Марина (28.10): успеете ли к 1 декабря?\nЯ (28.10): Марина, добрый день! Успеваем, если согласуем макет до 10 ноября. Уточните, пожалуйста: буквы на фасад?\nЯ (31.10): Отправил КП: 185 000 ₽, срок 12 рабочих дней.';
  const p = managerPromises(src, '2026-11-13');
  assert.equal(p.length, 1);
  assert.equal(p[0].said, '28.10');
  assert.ok(p[0].quote.startsWith('Успеваем, если согласуем макет до 10 ноября'));
  const list = buildMustInclude({ must_include: ['Попросить логотип'] }, zerno, src);
  assert.ok(list[1].startsWith('Переписка: 28.10 менеджер писал клиенту «Успеваем, если согласуем макет до 10 ноября.»'));
  // стратегия уже включила этот пункт — не дублируем
  const list2 = buildMustInclude({ must_include: ['Касание 1: сослаться на «успеваем, если согласуем макет до 10 ноября»'] }, zerno, src);
  assert.equal(list2.filter((x) => x.startsWith('Переписка')).length, 0);
  // дата ещё не наступила — не пункт
  assert.equal(managerPromises('Я (12.11): Успеем, если согласуем до 20 ноября.', '2026-11-13').length, 0);
});

console.log(`mustInclude: ${n} проверок пройдено`);

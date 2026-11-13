/**
 * Проверки кода в автоцикле касаний (engine/autoCompose.js → codeChecks):
 * длина канала и чередование экспертное / эмпатичное (воронка владельца).
 */
const assert = require('assert');
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {}, children: [], paths: [] };
const { codeChecks, applySeverity, applyCodeOwnership } = require('../engine/autoCompose');

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }
const bad = (r) => r.messages_reviewed.filter((m) => m.verdict !== 'ОДОБРЕНО').map((m) => m.touchpoint_number);

check('два экспертных подряд — второе на доработку', () => {
  const r = codeChecks({ messages: [
    { touchpoint_number: 1, kind: 'экспертное', channel: 'WhatsApp', timing: 'Сегодня', body: 'a' },
    { touchpoint_number: 2, kind: 'экспертное', channel: 'WhatsApp', timing: '16 ноября', body: 'b' }] }, null);
  assert.deepEqual(bad(r), [2]);
  assert.ok(r.messages_reviewed[1].failed_criteria.includes('alternation'));
});
check('условное касание («только если…») цепочку не ломает', () => {
  const r = codeChecks({ messages: [
    { touchpoint_number: 1, kind: 'экспертное', channel: 'WhatsApp', timing: 'Сегодня', body: 'a' },
    { touchpoint_number: 2, kind: 'эмпатичное', channel: 'Кружок', timing: '16 ноября', body: 'b' },
    { touchpoint_number: 3, kind: 'экспертное', channel: 'Звонок', timing: 'Только если Марина даст контакт', body: 'c' },
    { touchpoint_number: 4, kind: 'экспертное', channel: 'WhatsApp', timing: '17 ноября', body: 'd' }] }, null);
  assert.deepEqual(bad(r), []);
});
check('без поля kind: текст/звонок — экспертное, кружок — эмпатичное (живой «Зерно 3»)', () => {
  const r = codeChecks({ messages: [
    { touchpoint_number: 1, channel: 'Звонок', timing: 'Сегодня', body: 'a' },
    { touchpoint_number: 2, channel: 'WhatsApp', timing: '16 ноября', body: 'b' },
    { touchpoint_number: 3, channel: 'WhatsApp', timing: 'только если Марина дала контакт', body: 'c' },
    { touchpoint_number: 4, channel: 'WhatsApp', timing: '20 ноября', body: 'd' },
    { touchpoint_number: 5, channel: 'WhatsApp (Кружок)', timing: '24 ноября', body: 'e' }] }, null);
  assert.deepEqual(bad(r), [2, 4]);
  const ok = codeChecks({ messages: [{ touchpoint_number: 1, channel: 'WhatsApp', body: 'a' }, { touchpoint_number: 2, channel: 'Кружок', body: 'b' }, { touchpoint_number: 3, channel: 'Email', body: 'c' }] }, null);
  assert.equal(ok.verdict, 'ОДОБРЕНО');
});
check('кружок длиннее 600 символов — на сокращение', () => {
  const r = codeChecks({ messages: [{ touchpoint_number: 1, kind: 'эмпатичное', channel: 'Кружок', body: 'x'.repeat(700) }] }, null);
  assert.deepEqual(bad(r), [1]);
});
check('текст «сразу после звонка» — продолжение того же касания, не новый шаг', () => {
  const r = codeChecks({ messages: [
    { touchpoint_number: 1, channel: 'Звонок', timing: 'Сегодня', body: 'a' },
    { touchpoint_number: 2, channel: 'WhatsApp', timing: 'Сразу после звонка', body: 'b' },
    { touchpoint_number: 3, channel: 'Кружок', timing: '17 ноября', body: 'c' }] }, null);
  assert.equal(r.verdict, 'ОДОБРЕНО');
});
check('«совет» проверки не возвращает касание; «ошибка» — возвращает (живой «Зерно 4»)', () => {
  const r = { verdict: 'НА ДОРАБОТКУ', messages_reviewed: [
    { touchpoint_number: 2, verdict: 'НА ДОРАБОТКУ', severity: 'совет', fix_instructions: 'Дата ещё актуальна, это не проблема, но можно мягче.' },
    { touchpoint_number: 4, verdict: 'НА ДОРАБОТКУ', severity: 'совет', fix_instructions: 'Чуть теплее.' }] };
  applySeverity(r);
  assert.equal(r.verdict, 'ОДОБРЕНО');
  assert.equal(r.messages_reviewed[0].advice, 'Дата ещё актуальна, это не проблема, но можно мягче.');
  const r2 = { verdict: 'НА ДОРАБОТКУ', messages_reviewed: [
    { touchpoint_number: 3, verdict: 'НА ДОРАБОТКУ', severity: 'ошибка', fix_instructions: 'Угроза «слот уйдёт».' },
    { touchpoint_number: 4, verdict: 'НА ДОРАБОТКУ', severity: 'совет', fix_instructions: 'Чуть теплее.' }] };
  applySeverity(r2);
  assert.equal(r2.verdict, 'НА ДОРАБОТКУ');
  assert.deepEqual(r2.messages_reviewed.filter((m) => m.verdict !== 'ОДОБРЕНО').map((m) => m.touchpoint_number), [3]);
});
check('Зерно 5: материал для пересылки Андрею — лимит письма (1500), а не мессенджера', () => {
  const plan = [{ touchpoint_number: 1, recipient: 'Марина (управляющая) — материал для пересылки Андрею', channel: 'WhatsApp' }];
  const body = 'Марина, вот текст для Андрея, можно просто переслать.\n' + 'Андрей, добрый день. Для открытия 1 декабря есть два варианта. '.repeat(12);
  assert.ok(body.length > 600 && body.length < 1500);
  const r = codeChecks({ messages: [{ touchpoint_number: 1, channel: 'WhatsApp', kind: 'экспертное', timing: 'Сегодня', body }] }, null, plan);
  assert.equal(r.messages_reviewed[0].verdict, 'ОДОБРЕНО');
  const r2 = codeChecks({ messages: [{ touchpoint_number: 1, channel: 'WhatsApp', kind: 'экспертное', timing: 'Сегодня', body }] }, null, [{ touchpoint_number: 1, recipient: 'Марина' }]);
  assert.equal(r2.messages_reviewed[0].verdict, 'НА ДОРАБОТКУ');
});
check('Зерно 5: кружок с «[фото похожей работы]» — на доработку как речь в камеру', () => {
  const r = codeChecks({ messages: [{ touchpoint_number: 1, channel: 'Кружок (WhatsApp/Telegram)', kind: 'эмпатичное', timing: '19 ноября', body: 'Марина, добрый день. Нашёл объект. [фото похожей работы — если есть] Покажите Андрею?' }] }, null, null);
  assert.equal(r.messages_reviewed[0].verdict, 'НА ДОРАБОТКУ');
  assert.ok(r.messages_reviewed[0].failed_criteria.includes('circle_format'));
});
check('Зерно 5 (вечер): по плану «звонок эмп → сообщение эксп сразу после → кружок эмп» — чередование не ломано, кружок не на доработку', () => {
  const plan = [
    { touchpoint_number: 1, channel: 'Звонок', kind: 'эмпатичное' },
    { touchpoint_number: 2, channel: 'Мессенджер', kind: 'экспертное', recipient: 'Марина' },
    { touchpoint_number: 3, channel: 'Звонок', kind: 'экспертное', condition: 'только если' },
    { touchpoint_number: 4, channel: 'Кружок', kind: 'эмпатичное' },
    { touchpoint_number: 5, channel: 'Мессенджер', kind: 'экспертное' }
  ];
  const msgs = [
    { touchpoint_number: 1, channel: 'Звонок', kind: 'эмпатичное', timing: 'Сегодня', body: 'Марина, добрый день.' },
    { touchpoint_number: 2, channel: 'Мессенджер', kind: 'экспертное', timing: '13 ноября (пт), сразу после предыдущего касания', body: 'Текст.' },
    { touchpoint_number: 3, channel: 'Звонок', kind: 'экспертное', timing: 'Только если Марина даст контакт', body: 'Андрей, добрый день.' },
    { touchpoint_number: 4, channel: 'Кружок', kind: 'эмпатичное', timing: '19 ноября (чт)', body: 'Марина, привет из мастерской.' },
    { touchpoint_number: 5, channel: 'Мессенджер', kind: 'экспертное', timing: '23 ноября (пн)', body: 'Марина, честно спрошу.' }
  ];
  const r = codeChecks({ messages: msgs }, null, plan);
  assert.equal(r.verdict, 'ОДОБРЕНО');
  // без плана — то же: «сразу после» задаёт тип
  assert.equal(codeChecks({ messages: msgs }, null, null).verdict, 'ОДОБРЕНО');
});
check('Зерно 5 (вечер): reviewer спорит с кодом — дата на день отправки по расчёту, формат кружка, длина пересылки → совет', () => {
  const plan = [
    { touchpoint_number: 2, recipient: 'Марина — материал для пересылки Андрею', facts: {} },
    { touchpoint_number: 4, channel: 'Кружок', facts: {} },
    { touchpoint_number: 5, facts: { permanent_ready_if_start_that_day: '11 декабря (пт) – 14 декабря (пн)' } }
  ];
  const msgs = [
    { touchpoint_number: 2, channel: 'Мессенджер', body: 'Текст для Андрея' },
    { touchpoint_number: 4, channel: 'Кружок (WhatsApp/Telegram)', body: 'Марина, добрый день' },
    { touchpoint_number: 5, channel: 'Мессенджер', body: 'постоянная вывеска при старте сегодня готова к 11–14 декабря' }
  ];
  const rv = { reviewer_output: { verdict: 'НА ДОРАБОТКУ', messages_reviewed: [
    { touchpoint_number: 2, verdict: 'НА ДОРАБОТКУ', severity: 'ошибка', failed_criteria: ['channel_fit'], fix_instructions: 'длинно' },
    { touchpoint_number: 4, verdict: 'НА ДОРАБОТКУ', severity: 'ошибка', failed_criteria: ['channel_fit'], fix_instructions: 'не похоже на речь' },
    { touchpoint_number: 5, verdict: 'НА ДОРАБОТКУ', severity: 'ошибка', failed_criteria: ['data_honesty'], fix_instructions: 'при старте сегодня — касание уходит 23 ноября' }
  ] } };
  applyCodeOwnership(rv, msgs, plan);
  applySeverity(rv);
  assert.equal(rv.reviewer_output.verdict, 'ОДОБРЕНО');
  // настоящая ошибка (давление) остаётся ошибкой
  const rv2 = { reviewer_output: { verdict: 'НА ДОРАБОТКУ', messages_reviewed: [
    { touchpoint_number: 4, verdict: 'НА ДОРАБОТКУ', severity: 'ошибка', failed_criteria: ['channel_fit', 'no_pressure'], fix_instructions: 'давление' } ] } };
  applyCodeOwnership(rv2, msgs, plan); applySeverity(rv2);
  assert.equal(rv2.reviewer_output.verdict, 'НА ДОРАБОТКУ');
});
console.log(`autoCompose: ${n} проверок пройдено`);

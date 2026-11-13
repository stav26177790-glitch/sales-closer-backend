/**
 * Проверки кода в автоцикле касаний (engine/autoCompose.js → codeChecks):
 * длина канала и чередование экспертное / эмпатичное (воронка владельца).
 */
const assert = require('assert');
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {}, children: [], paths: [] };
const { codeChecks, applySeverity } = require('../engine/autoCompose');

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
console.log(`autoCompose: ${n} проверок пройдено`);

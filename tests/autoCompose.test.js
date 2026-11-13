/**
 * Проверки кода в автоцикле касаний (engine/autoCompose.js → codeChecks):
 * длина канала и чередование экспертное / эмпатичное (воронка владельца).
 */
const assert = require('assert');
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {}, children: [], paths: [] };
const { codeChecks } = require('../engine/autoCompose');

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
check('без поля kind — не проверяем', () => {
  const r = codeChecks({ messages: [{ touchpoint_number: 1, channel: 'WhatsApp', body: 'a' }, { touchpoint_number: 2, channel: 'WhatsApp', body: 'b' }] }, null);
  assert.equal(r.verdict, 'ОДОБРЕНО');
});
check('кружок длиннее 600 символов — на сокращение', () => {
  const r = codeChecks({ messages: [{ touchpoint_number: 1, kind: 'эмпатичное', channel: 'Кружок', body: 'x'.repeat(700) }] }, null);
  assert.deepEqual(bad(r), [1]);
});
console.log(`autoCompose: ${n} проверок пройдено`);

const assert = require('assert');
const { friendlyError, classifyError } = require('../engine/errors');

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

check('нет денег на счёте API → «закончился баланс»', () => {
  const e = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'), { status: 400 });
  assert.equal(classifyError(e), 'balance');
  assert.ok(friendlyError(e).startsWith('Закончился баланс'));
});
check('неверный ключ → сообщить руководителю', () => {
  assert.equal(classifyError(Object.assign(new Error('401 invalid x-api-key'), { status: 401 })), 'auth');
});
check('перегрузка / лимит → подождать минуту', () => {
  assert.equal(classifyError(Object.assign(new Error('529 Overloaded'), { status: 529 })), 'busy');
  assert.equal(classifyError(Object.assign(new Error('429 rate_limit_error'), { status: 429 })), 'busy');
});
check('обрыв связи / 5xx → временно недоступен', () => {
  assert.equal(classifyError(new Error('Connection error.')), 'unavailable');
  assert.equal(classifyError(Object.assign(new Error('500'), { status: 500 })), 'unavailable');
});
check('прочее → общее сообщение без английского текста', () => {
  const msg = friendlyError(new Error('Cannot read properties of undefined'));
  assert.ok(!/[a-z]{4,}/i.test(msg));
});
console.log(`errors: ${n} проверок пройдено`);

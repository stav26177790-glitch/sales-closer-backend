// Разбор JSON из ответов моделей с починкой (живой «Зерно 5», 13.11 вечер).
const assert = require('assert');
const { parseModelJson } = require('../engine/jsonRepair');
let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

check('обычный JSON в ```json — как есть', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
});
check('прямые кавычки внутри строки: «первую точку "Зерна". Хочу…» — чинится', () => {
  const t = '```json\n{"reviewer_output":{"verdict":"НА ДОРАБОТКУ","messages_reviewed":[{"touchpoint_number":4,"verdict":"НА ДОРАБОТКУ","fix_instructions":"Скажите: «Нашёл объект, похожий на первую точку "Зерна". Хочу показать»"}]}}\n```';
  const o = parseModelJson(t);
  assert.equal(o.reviewer_output.verdict, 'НА ДОРАБОТКУ');
  assert.ok(o.reviewer_output.messages_reviewed[0].fix_instructions.includes('"Зерна"'));
});
check('кавычки с запятой после: «точку "Зерна", объёмные буквы» — чинится', () => {
  const t = '{"x":"похожий на первую точку "Зерна", объёмные буквы","y":2}';
  assert.deepEqual(parseModelJson(t), { x: 'похожий на первую точку "Зерна", объёмные буквы', y: 2 });
});
check('совсем не JSON — null', () => {
  assert.equal(parseModelJson('Извините, не могу'), null);
});
console.log(`jsonRepair: ${n} проверок пройдено`);

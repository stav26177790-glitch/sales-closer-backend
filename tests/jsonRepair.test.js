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
check('DeepSeek 15.11: лишняя «}» после каждого касания в messages — чинится, касания целы', () => {
  const raw = '{"composer_output":{"messages":[{"touchpoint_number":1,"hook":{"quote":"q"},"body":"текст {не трогать}"}},{"touchpoint_number":2,"body":"б"}}]}}';
  const r = parseModelJson(raw);
  assert.equal(r.composer_output.messages.length, 2);
  assert.equal(r.composer_output.messages[0].body, 'текст {не трогать}');
  assert.equal(r.composer_output.messages[1].touchpoint_number, 2);
});
check('DeepSeek 15.11: каждое касание в своём массиве [ {…} ], [ {…} ] ] — склеивается', () => {
  const raw = '{\n "composer_output": {\n "messages": [\n {"touchpoint_number": 1, "body": "а ], [ {не трогать}"}\n ],\n [\n {"touchpoint_number": 2, "hook": {"q": "x"}, "body": "б"}\n ],\n [\n {"touchpoint_number": 3, "body": "в"}\n ]\n ]\n }\n}';
  const r = parseModelJson(raw);
  assert.deepEqual(r.composer_output.messages.map((m) => m.touchpoint_number), [1, 2, 3]);
  assert.equal(r.composer_output.messages[0].body, 'а ], [ {не трогать}');
});
check('совсем не JSON — null', () => {
  assert.equal(parseModelJson('Извините, не могу'), null);
});
console.log(`jsonRepair: ${n} проверок пройдено`);

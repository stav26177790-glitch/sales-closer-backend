/**
 * Повод касания (engine/hookCheck.js) — владелец 14.11, «Зерно 7»:
 * экспертное / эмпатичное — не метка, а повод, с которого касание начинается.
 */
const assert = require('assert');
const { findHookIssues, applyHookCheck, quoteInSource } = require('../engine/hookCheck');

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

const SRC = `Марина (28.10): Добрый день! Открываем вторую кофейню на Покровке, нужна вывеска как на первой точке — объёмные буквы с подсветкой, логотип зерна. Ширина фасада около 4 метров.
Марина (29.10): На козырёк. Логотип пришлю.`;

const good = {
  touchpoint_number: 1, kind: 'экспертное', timing: 'Сегодня, 16 ноября (пн)',
  hook: { quote: 'На козырёк', prep: 'Перед касанием: позвоните технологу — какая высота букв войдёт в козырёк при ширине 4 м.', opening: 'Говорил сейчас с технологом по вашему козырьку' },
  body: 'Марина, добрый день! Говорил сейчас с технологом по вашему козырьку — есть вопрос по высоте букв, хочу, чтобы зерно читалось с улицы.'
};

check('цитата ищется в переписке: дословно и по 4 словам подряд; выдуманная — нет', () => {
  assert.ok(quoteInSource('«На козырёк»', SRC));
  assert.ok(quoteInSource('нужна вывеска как на первой точке, объёмные', SRC));
  assert.ok(!quoteInSource('хотим неоновую вывеску', SRC));
});
check('хороший повод — замечаний нет', () => {
  assert.deepEqual(findHookIssues([good], SRC), []);
});
check('нет повода — на доработку с подсказкой по типу касания', () => {
  const r = findHookIssues([{ ...good, hook: undefined, kind: 'эмпатичное' }], SRC);
  assert.equal(r.length, 1);
  assert.ok(/вспомнил про вас/.test(r[0].fixes[0]));
});
check('цитаты нет в переписке — на доработку', () => {
  const r = findHookIssues([{ ...good, hook: { ...good.hook, quote: 'хотим неоновую вывеску' } }], SRC);
  assert.ok(r[0].fixes.some((f) => /нет в переписке/.test(f)));
});
check('касание не начинается с повода — на доработку', () => {
  const body = 'Марина, добрый день! ' + 'Хочу обсудить сроки по вывеске и пару деталей. '.repeat(16) + 'Говорил сейчас с технологом по вашему козырьку.';
  const r = findHookIssues([{ ...good, body }], SRC);
  assert.ok(r[0].fixes.some((f) => /начинаться с повода/.test(f)));
});
check('звонок: ремарки «[Марина берёт трубку]» не мешают найти повод', () => {
  const body = '[Марина берёт трубку]\nМарина, добрый день, это [имя]. Удобно пара минут? [пауза]\n[Да]\nГоворил сейчас с технологом по вашему козырьку — есть вопрос.';
  assert.deepEqual(findHookIssues([{ ...good, body }], SRC), []);
});
check('подготовка «заехать» — менеджеры удалённо, на доработку', () => {
  const r = findHookIssues([{ ...good, hook: { ...good.hook, prep: 'Заехал на производство посмотреть буквы' } }], SRC);
  assert.ok(r[0].fixes.some((f) => /удалённо/.test(f)));
});
check('текст вдогонку «сразу после звонка» — повод не нужен', () => {
  assert.deepEqual(findHookIssues([{ touchpoint_number: 2, timing: '16 ноября (пн), сразу после предыдущего касания', body: 'Марина, как договорились — вот текст для Андрея.' }], SRC), []);
});
check('вердикт: касание с замечанием по поводу — НА ДОРАБОТКУ, критерий hook', () => {
  const v = { verdict: 'ОДОБРЕНО', messages_reviewed: [{ touchpoint_number: 1, verdict: 'ОДОБРЕНО' }] };
  applyHookCheck(v, [{ ...good, hook: null }], SRC);
  assert.equal(v.verdict, 'НА ДОРАБОТКУ');
  assert.equal(v.messages_reviewed[0].verdict, 'НА ДОРАБОТКУ');
  assert.ok(v.messages_reviewed[0].failed_criteria.includes('hook'));
});
console.log(`hookCheck: ${n} проверок пройдено`);

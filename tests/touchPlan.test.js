/**
 * План касаний кодом (engine/touchPlan.js): даты, факты на день отправки,
 * чередование, раскладка обязательных пунктов, закрепление после writer.
 */
const assert = require('assert');
const t = require('../engine/timeline');
const { buildTouchPlan, pinToPlan } = require('../engine/touchPlan');

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }
const tl = t.computeTimeline({ today: '2026-11-13', clientDeadline: '2026-12-01', productionDays: 12 });
const seq = [
  { number: 1, kind: 'экспертное', channel: 'Звонок', recipient: 'Марине', day: 0, goal: 'логотип' },
  { number: 2, kind: 'экспертное', channel: 'WhatsApp', recipient: 'Марине', same_contact_as: 1, goal: 'текст для Андрея' },
  { number: 3, kind: 'экспертное', channel: 'Звонок', recipient: 'Андрею', condition: 'только если Марина даст контакт', goal: 'решение' },
  { number: 4, kind: 'экспертное', channel: 'WhatsApp', recipient: 'Марине', day: 4, goal: 'кейс' },
  { number: 5, kind: 'экспертное', channel: 'WhatsApp', recipient: 'Марине', day: 8, goal: 'дата постоянной' }
];
const plan = buildTouchPlan({ touchpoint_sequence: seq, must_include: ['Касание 2: начинается с выгоды', 'Переписка: 28.10 … эта дата прошла'] }, tl, '2026-11-13');

check('даты отправки по рабочему календарю; «сразу после» — тот же день; условное — без даты', () => {
  assert.equal(plan[0].send_date, '2026-11-13');
  assert.equal(plan[1].send_date, '2026-11-13');
  assert.equal(plan[2].send_date, null);
  assert.ok(plan[2].condition.includes('Марина даст контакт'));
});
check('два экспертных подряд (1 → 4) — код вставил кружок между ними', () => {
  const kinds = plan.filter((p) => !p.condition && !/сразу после/.test(p.timing)).map((p) => p.kind);
  for (let i = 1; i < kinds.length; i++) assert.notEqual(kinds[i], kinds[i - 1]);
  assert.ok(plan.some((p) => p.inserted && p.channel === 'Кружок'));
});
check('факты на день отправки: 13.11 — готово 3–4 декабря, баннер ещё можно; 25.11 — 15–16 декабря, баннер не упоминать', () => {
  assert.equal(plan[0].facts.permanent_ready_if_start_that_day, '3 декабря (чт) – 4 декабря (пт)');
  assert.ok(/ещё успевает/.test(plan[0].facts.temp_banner));
  const last = plan[plan.length - 1];
  assert.equal(last.send_date, '2026-11-25');
  assert.equal(last.facts.permanent_ready_if_start_that_day, '15 декабря (вт) – 16 декабря (ср)');
  assert.ok(/не упоминать/.test(last.facts.temp_banner));
});
check('обязательные пункты разложены: «Касание 2» → 2, прочее → первое касание', () => {
  assert.deepEqual(plan[1].must_include, ['Касание 2: начинается с выгоды']);
  assert.ok(plan[0].must_include[0].startsWith('Переписка'));
});
check('после writer канал, дата и тип — из плана', () => {
  const out = pinToPlan({ messages: [{ touchpoint_number: 1, channel: 'Email', timing: 'когда-нибудь', kind: 'эмпатичное', body: 'x' }] }, plan);
  assert.equal(out.messages[0].channel, 'Звонок');
  assert.equal(out.messages[0].kind, 'экспертное');
  assert.ok(out.messages[0].timing.includes('13 ноября'));
});
check('без шагов стратегии — плана нет (старый путь composer)', () => {
  assert.equal(buildTouchPlan({}, tl, '2026-11-13'), null);
});
console.log(`touchPlan: ${n} проверок пройдено`);

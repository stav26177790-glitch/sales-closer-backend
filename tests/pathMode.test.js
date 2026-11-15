// Режим пути: «весь путь» / «следующий шаг» (владелец 15.11).
const assert = require('assert');
const { autoMode, modeCommand, modeOf } = require('../engine/pathMode');
const t = require('../engine/timeline');
const { buildTouchPlan } = require('../engine/touchPlan');
let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

check('авто: последняя реплика клиента, молчание не названо → следующий шаг', () => {
  assert.equal(autoMode('Наталья (15.11): Мне всё нравится. Сделаете 10% — подпишем сегодня.'), 'step');
  assert.equal(autoMode('Я (10.11): Отправил КП.\nКарина (13.11): Дороговато. А если без подсветки?'), 'step');
});
check('авто: молчание названо или последняя реплика наша → весь путь', () => {
  assert.equal(autoMode('Марина (31.10): Спасибо, покажу Андрею.\n\nПосле этого ответа нет.'), 'full');
  assert.equal(autoMode('Ольга (05.11): Ок.\nЯ (06.11): Пришлю макет.\nС 07.11 тишина.'), 'full');
  assert.equal(autoMode('Я (06.11): Пришлю макет.'), 'full');
  assert.equal(autoMode(''), 'full');
});
check('команды менеджера: «весь путь», «клиент молчит» → full; «следующий шаг» → step; прочее — нет', () => {
  assert.equal(modeCommand('весь путь'), 'full');
  assert.equal(modeCommand('Клиент молчит'), 'full');
  assert.equal(modeCommand('следующий шаг'), 'step');
  assert.equal(modeCommand('Марина (17.11): Логотип во вложении'), null);
  assert.equal(modeCommand('касание 1 короче'), null);
});
check('modeOf: из last_diagnostic_output._path_mode, по умолчанию full', () => {
  assert.equal(modeOf({ last_diagnostic_output: { _path_mode: 'step' } }), 'step');
  assert.equal(modeOf({}), 'full');
});
check('план в режиме «следующий шаг»: первое касание + условное до следующего, без «последнего шанса»', () => {
  const tl = t.computeTimeline({ today: '2026-11-17', clientDeadline: '2026-12-01', productionDays: 12 });
  const seq = [
    { number: 1, kind: 'экспертное', channel: 'Звонок', day: 0, goal: 'ответить на вопрос', criterion: 'ФВ' },
    { number: 2, kind: 'экспертное', channel: 'Email', timing: 'только если Марина согласится передать', goal: 'материал для Андрея' },
    { number: 3, kind: 'эмпатичное', channel: 'Кружок', day: 3, goal: 'интрига' },
    { number: 4, kind: 'экспертное', channel: 'Звонок', day: 6, goal: 'кейс' },
    { number: 5, kind: 'экспертное', channel: 'WhatsApp', day: 9, goal: 'последний' }
  ];
  const step = buildTouchPlan({ touchpoint_sequence: seq }, tl, '2026-11-17', null, { mode: 'step' });
  assert.deepEqual(step.map((p) => p.channel), ['Звонок', 'Email']);
  assert.ok(step.every((p) => !p.last_chance && p.path_mode === 'step'));
  const full = buildTouchPlan({ touchpoint_sequence: seq }, tl, '2026-11-17', null, {});
  assert.ok(full.length >= 5 && full[full.length - 1].last_chance);
});
check('«клиент молчит»: план пересобирается кодом в весь путь, без вызова модели → дальше касания', () => {
  const { switchPathMode } = require('../engine/pathMode');
  const tl = t.computeTimeline({ today: '2026-11-17', clientDeadline: '2026-12-15', productionDays: 10 });
  const seq = [
    { number: 1, kind: 'экспертное', channel: 'WhatsApp', day: 0, goal: 'ответить' },
    { number: 2, kind: 'эмпатичное', channel: 'Кружок', day: 2, goal: 'интрига' },
    { number: 3, kind: 'экспертное', channel: 'Звонок', day: 4, goal: 'кейс' }
  ];
  const deal = { last_diagnostic_output: { _path_mode: 'step', scores: {} }, last_strategy_output: { touchpoint_sequence: seq } };
  const r = switchPathMode({ deal, baseInput: { timeline: tl, today: '2026-11-17', materials: {} } }, 'full');
  assert.equal(r.nextState, 'STRATEGY_SELECTION');
  assert.equal(r.output.diagnostic_output._path_mode, 'full');
  assert.ok(r.output.strategy_output.touch_plan.length >= 3 && r.output.strategy_output.touch_plan.at(-1).last_chance);
  const back = switchPathMode({ deal: { ...deal, last_diagnostic_output: { _path_mode: 'full' } }, baseInput: { timeline: tl, today: '2026-11-17', materials: {} } }, 'step');
  assert.equal(back.output.strategy_output.touch_plan.length, 1);
});
check('кружок — одному: «Андрей + Марина» → Марина (контакт); фраза «какой ориентир комфортен» и обращение к двоим — на правку', () => {
  const tl = t.computeTimeline({ today: '2026-11-17', clientDeadline: '2026-12-15', productionDays: 10 });
  const p = buildTouchPlan({ touchpoint_sequence: [
    { number: 1, kind: 'экспертное', channel: 'WhatsApp', day: 0, recipient: 'Марина (управляющая)' },
    { number: 2, kind: 'эмпатичное', channel: 'Кружок', day: 3, recipient: 'Андрей (собственник, ЛПР) + Марина (управляющая)' },
    { number: 3, kind: 'экспертное', channel: 'Звонок', day: 6, recipient: 'Марина (управляющая)' }
  ] }, tl, '2026-11-17', null, {});
  assert.equal(p.find((x) => x.channel === 'Кружок').recipient, 'Марина (управляющая)');
  const { findBannedPhrases } = require('../engine/phraseCheck');
  assert.equal(findBannedPhrases([{ touchpoint_number: 1, body: 'Какой ориентир для вас комфортен? Вся сумма показалась высокой или что-то в составе?' }]).length, 1);
  const { findPlanIssues } = require('../engine/planChecks');
  const krug = (b) => findPlanIssues([{ touchpoint_number: 5, channel: 'Кружок', body: b }], [{ touchpoint_number: 5, channel: 'Кружок' }]);
  assert.ok(krug('Андрей, Марина, как вы? Появилась идея — можем коротко набраться?').some((x) => x.fixes.some((f) => /одному/.test(f))));
  assert.ok(!krug('Марина, как вы? Появилась идея — можем коротко набраться?').some((x) => x.fixes.some((f) => /одному/.test(f))));
});
console.log(`pathMode: ${n} проверок пройдено`);

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
check('Зерно 5: звонок эмп → сообщение эксп «сразу после» → кружок эмп → сообщение эксп — ничего не ломать и не вставлять', () => {
  const p5 = buildTouchPlan({ touchpoint_sequence: [
    { number: 1, channel: 'Звонок', kind: 'эмпатичное', day: 0, timing: 'Сегодня' },
    { number: 2, channel: 'Мессенджер', kind: 'экспертное', day: 0, same_contact_as: 1, timing: 'В тот же день, сразу после звонка' },
    { number: 3, channel: 'Звонок', kind: 'экспертное', day: 2, condition: 'Только если Марина даст контакт' },
    { number: 4, channel: 'Кружок (WhatsApp/Telegram)', kind: 'эмпатичное', day: 4 },
    { number: 5, channel: 'Мессенджер', kind: 'экспертное', day: 6 }
  ] }, tl, '2026-11-13');
  assert.equal(p5.length, 5);
  assert.ok(!p5.some((x) => x.inserted));
  assert.equal(p5[3].channel, 'Кружок (WhatsApp/Telegram)');
  assert.equal(p5[3].kind, 'эмпатичное');
});
check('Зерно 6: условие «не ответила» — без «после согласия», с датой «не раньше»', () => {
  const p = buildTouchPlan({ touchpoint_sequence: [
    { number: 1, channel: 'Звонок', kind: 'эмпатичное', day: 0 },
    { number: 2, channel: 'Кружок', kind: 'эмпатичное', day: 1, condition: 'Только если Марина не ответила на касания 1–2' },
    { number: 3, channel: 'Звонок', kind: 'экспертное', day: 0, condition: 'Только если Марина даст контакт Андрея' }
  ] }, tl, '2026-11-13');
  assert.ok(!/после согласия/.test(p[1].timing));
  assert.ok(/не раньше 16 ноября/.test(p[1].timing), p[1].timing);
  assert.ok(/после согласия/.test(p[2].timing));
});
check('Зерно 6 (ответ клиента): «Если после касания 1 Марина не организовала звонок» — не согласие, без «после согласия»', () => {
  const p = buildTouchPlan({ touchpoint_sequence: [
    { number: 1, channel: 'Мессенджер', kind: 'экспертное', day: 0 },
    { number: 2, channel: 'Мессенджер', kind: 'экспертное', condition: 'Если после касания 1 Марина не организовала звонок с Андреем' }
  ] }, tl, '2026-11-13');
  assert.ok(!/после согласия/.test(p[1].timing), p[1].timing);
});
// Владелец 14.11 («Зерно 7»): «Клоузер бьёт только по ЛПР» — каждый неподтверждённый
// критерий формулы закрытия двигает хотя бы одно касание.
const { criteriaToMove, criterionOf } = require('../engine/touchPlan');
const zernoScores = {
  financial: { status: 'Вероятно' }, need: { status: 'Подтверждено' }, authority: { status: 'Риск' },
  trust: { status: 'Вероятно' }, urgency: { status: 'Риск' }
};
check('критерии к закрытию — всё, что не «Подтверждено»; названия разбираются', () => {
  assert.deepEqual(criteriaToMove(zernoScores), ['ЛПР', 'ЗС', 'ФВ', 'Д']);
  assert.equal(criterionOf('ФВ — финансовая возможность'), 'ФВ');
  assert.equal(criterionOf('Д'), 'Д');
  assert.equal(criterionOf('ЛПР'), 'ЛПР');
  assert.equal(criterionOf('trust'), 'Д');
  assert.equal(criterionOf(''), null);
});
check('Зерно 7: стратегия вся про ЛПР → код добавляет касания на ЗС, ФВ, Д (не больше 7)', () => {
  const p = buildTouchPlan({ touchpoint_sequence: [
    { number: 1, channel: 'Звонок', kind: 'эмпатичное', day: 0, criterion: 'ЛПР', recipient: 'Марине' },
    { number: 2, channel: 'WhatsApp', kind: 'экспертное', day: 0, same_contact_as: 1, criterion: 'ЛПР', recipient: 'Марине' },
    { number: 3, channel: 'Звонок', kind: 'экспертное', condition: 'только если Марина даст контакт', criterion: 'ЛПР' },
    { number: 4, channel: 'Кружок', kind: 'эмпатичное', day: 2, criterion: 'ЛПР', recipient: 'Марине' }
  ] }, tl, '2026-11-13', zernoScores);
  const regular = p.filter((x) => !x.condition);
  const covered = new Set(regular.flatMap((x) => [x.criterion, ...x.also_criteria]).filter(Boolean).map((c) => c.split(' —')[0]));
  for (const c of ['ЛПР', 'ЗС', 'ФВ', 'Д']) assert.ok(covered.has(c), `не покрыт ${c}`);
  assert.ok(regular.length <= 7);
  const kinds = regular.map((x) => x.kind);
  for (let i = 1; i < kinds.length; i++) assert.notEqual(kinds[i], kinds[i - 1], kinds.join(','));
  // Деньги, доверие, сроки — экспертные касания, не кружок.
  for (const x of regular) if (/^(ФВ|Д|ЗС)/.test(x.criterion || '')) assert.equal(x.kind, 'экспертное', x.criterion);
});
check('шаг без критерия получает непокрытый критерий (сроки — экспертному, не кружку), новых касаний не добавляем', () => {
  const p = buildTouchPlan({ touchpoint_sequence: [
    { number: 1, channel: 'Звонок', kind: 'экспертное', day: 0, criterion: 'ЛПР' },
    { number: 2, channel: 'Кружок', kind: 'эмпатичное', day: 2 },
    { number: 3, channel: 'WhatsApp', kind: 'экспертное', day: 4 }
  ] }, tl, '2026-11-13', { authority: { status: 'Риск' }, urgency: { status: 'Риск' }, financial: { status: 'Подтверждено' } });
  assert.equal(p.length, 3);
  assert.equal(p[1].criterion, null);
  assert.equal(p[2].criterion, 'ЗС — здесь и сейчас');
});
check('план уже из 7 касаний — непокрытый критерий добавляется целью к последнему, касаний не больше 7', () => {
  const seq7 = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ number: i + 1, channel: i % 2 ? 'Кружок' : 'WhatsApp', kind: i % 2 ? 'эмпатичное' : 'экспертное', day: i * 2, criterion: 'ЛПР' }));
  const p = buildTouchPlan({ touchpoint_sequence: seq7 }, tl, '2026-11-13', { authority: { status: 'Риск' }, financial: { status: 'Неизвестно' } });
  assert.equal(p.length, 7);
  assert.ok(p.some((x) => x.also_criteria.includes('ФВ — финансовая возможность')));
});
check('критерий не указан — угадывается по цели касания', () => {
  const p = buildTouchPlan({ touchpoint_sequence: [
    { number: 1, channel: 'WhatsApp', kind: 'экспертное', day: 0, goal: 'Текст для пересылки Андрею' },
    { number: 2, channel: 'Кружок', kind: 'эмпатичное', day: 2, goal: 'Последний день для временной вывески — без давления' },
    { number: 3, channel: 'WhatsApp', kind: 'экспертное', day: 4, goal: 'Что стоит за «дороговато»' }
  ] }, tl, '2026-11-13');
  assert.deepEqual(p.map((x) => (x.criterion || '').split(' —')[0]), ['ЛПР', 'ЗС', 'ФВ']);
});
check('без оценки — план как раньше (старые сделки)', () => {
  const p = buildTouchPlan({ touchpoint_sequence: [{ number: 1, channel: 'Звонок', kind: 'экспертное', day: 0 }] }, tl, '2026-11-13');
  assert.equal(p.length, 1);
});
console.log(`touchPlan: ${n} проверок пройдено`);

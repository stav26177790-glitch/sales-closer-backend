'use strict';
// Разбор 18.11, причина 5 — перегрузка писателя: подсказки на касание без служебных пометок, дублей, противоречий,
// в лимите; «Почему мы» поглощает «Дорого»; второй сценарий в касании — коротко; СОПРАНО не поверх сценария.
const assert = require('assert');
const { compactNotes, stripProvenance, MAX_HOW } = require('../engine/notes');
const { buildTouchPlan } = require('../engine/touchPlan');
const { detectScenarios } = require('../engine/scenarios');
const { mentorWhy } = require('../engine/mentor');
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const log = console.log;

check('служебные пометки убираются, ссылка на файл методики остаётся', () => {
  assert.equal(stripProvenance('ЛДПР (владелец 17.11, файл 28): вопрос'), 'ЛДПР (файл 28): вопрос');
  assert.equal(stripProvenance('FOLLOW-UP после звонка (файл 26, п. 8; владелец 18.11: «менеджер просто копирует и отправляет»): итог'), 'FOLLOW-UP после звонка (файл 26, п. 8): итог');
  assert.equal(stripProvenance('ИДЕЯ ИЗ КРУЖКА (владелец 18.11): звонок'), 'ИДЕЯ ИЗ КРУЖКА: звонок');
  // содержательные скобки не трогаем
  assert.equal(stripProvenance('на производство (акрил — Мытищи, металл — Щёлково)'), 'на производство (акрил — Мытищи, металл — Щёлково)');
});

check('дубли и противоречия: «кто проводит» при карточке с заведующим, инструмент доверия в отстройке — сняты', () => {
  const { notes, dropped } = compactNotes([
    'Инструмент доверия этого касания: визуализация на фото фасада. Доводы других касаний не повторять.',
    'Встречу на производстве проводит заведующий производством — ориентировать на него.',
    'СЦЕНАРИЙ «ПОЧЕМУ МЫ» (владелец, файл 32): … пригласить на производство (проводит заведующий производством) …',
    'СЦЕНАРИЙ «ПОЧЕМУ МЫ» (владелец, файл 32): … пригласить на производство (проводит заведующий производством) …'
  ], { scenarios: ['why_us'] });
  assert.deepEqual(dropped.sort(), ['production_who', 'trust_tool']);
  assert.equal(notes.length, 1);
  assert.ok(/^СЦЕНАРИЙ «ПОЧЕМУ МЫ» \(файл 32\)/.test(notes[0]), notes[0]);
});

check('лимит: сверх него уходят необязательные (предвосхищение, СОПРАНО), сценарий и follow-up остаются; главное — первым', () => {
  const card = `СЦЕНАРИЙ «ТОРГ» (файл 28): ${'ход '.repeat(400)}`;
  const { notes, dropped } = compactNotes([
    'ПРЕДВОСХИЩЕНИЕ (файл 33): вопрос-«да».', `СОПРАНО: вплести один вопрос ${'х'.repeat(300)}`,
    `FOLLOW-UP после звонка (файл 26): ${'итог '.repeat(150)}`, card
  ], {});
  assert.ok(dropped.includes('pre') && dropped.includes('soprano'), dropped.join());
  assert.ok(/^СЦЕНАРИЙ «ТОРГ»/.test(notes[0]) && notes.some((x) => /^FOLLOW-UP/.test(x)));
  assert.ok(notes.join(' ').length <= MAX_HOW + 2000); // обязательные не режутся, даже если длиннее лимита
});

check('«у всех одинаково, другие дешевле, за 70 предложили» — один сценарий «Почему мы» с вопросом о цене конкурента', () => {
  const src = 'КП 115 000.\n[Сообщение менеджера 2] Перезвонил раздражённо: у всех всё одинаково. Другие делают то же самое, только дешевле — мне за 70 предложили. А вы мне очки втираете со своим ОТК, гарантиями и визуализациями.';
  const ids = detectScenarios(src).map((s) => s.id);
  assert.deepEqual(ids, ['why_us']);
  assert.ok(/Цена конкурента/.test(detectScenarios(src)[0].card(src)));
});

const STRATEGY = { touchpoint_sequence: [
  { number: 1, timing: 'сегодня', channel: 'Звонок', type: 'экспертное', recipient: 'Сергей Петрович', goal: 'Закрыть недоверие: пригласить на производство в Мытищи', criterion: 'Д' },
  { number: 2, timing: 'через 3 рабочих дня', channel: 'Звонок', type: 'экспертное', recipient: 'Сергей Петрович', goal: 'Слот под дату', criterion: 'ЗС' },
  { number: 3, timing: 'через 6 рабочих дней', channel: 'WhatsApp', type: 'экспертное', recipient: 'Сергей Петрович', goal: 'Финально', criterion: 'ЗС' }
], must_include: [] };
const SCORES = { trust: { status: 'Риск' }, financial: { status: 'Вероятно' }, need: { status: 'Подтверждено' }, authority: { status: 'Подтверждено' }, urgency: { status: 'Вероятно' } };
const SRC = 'Автосервис Гараж 77, Мытищи. КП 115 000.\n[Сообщение менеджера 2] Перезвонил раздражённо: у всех всё одинаково, другие дешевле — за 70 предложили. А вы мне очки втираете со своим ОТК, гарантиями и визуализациями.';

check('план «Гараж 77»: в первом звонке один полный сценарий, без визуализации, без пометок «владелец»; цель без инструмента доверия', () => {
  console.log = () => {};
  const plan = buildTouchPlan(STRATEGY, null, '2026-11-19', SCORES, { source: SRC, client: 'Гараж 77', mode: 'full', dealSize: 115000,
    soprano: { 'П': { status: 'не собрано' }, 'О1': { status: 'не собрано' } } });
  console.log = log;
  const first = plan[0];
  assert.deepEqual(first.scenarios, ['why_us']);
  assert.equal((first.how.match(/СЦЕНАРИЙ «/g) || []).length, 1, first.how);
  assert.ok(!/визуализация на фото фасада/.test(first.how), first.how);
  assert.ok(!/Инструмент доверия/.test(first.goal), first.goal);
  assert.ok(!/владел/i.test(plan.map((p) => p.how).join(' ')));
  // СОПРАНО — не поверх сценария раздражённому клиенту; вопрос уходит в следующий звонок
  assert.ok(!/вплести/.test(first.how));
  assert.ok(plan.slice(1).some((p) => /вплести/.test(p.how)));
  // было 3 700 символов (замер 18.11); остаются только обязательные — сценарий и итог звонка
  assert.ok(first.how.length < 2500, String(first.how.length));
});

check('наставник узнаёт вопрос СОПРАНО без служебной пометки', () => {
  const w = mentorWhy({ goal: 'Слот', criterion: 'ЗС — здесь и сейчас', kind: 'экспертное', how: 'СОПРАНО: вплести один вопрос по несобранным блокам' });
  assert.ok(w.some((x) => /СОПРАНО/.test(x)), w.join(' | '));
});

console.log(`notes: ${n} проверок пройдено`);

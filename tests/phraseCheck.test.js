const assert = require('assert');
// pipeline тянет db.js, который создаёт клиента Supabase при загрузке — в тесте сети нет.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';
const { findBannedPhrases, applyPhraseCheck } = require('../engine/phraseCheck');
const { keepApprovedTouches } = require('../engine/pipeline');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const msgs = [
  { touchpoint_number: 1, body: 'Производство своё, от поставщиков не зависим — дату держим.' },
  { touchpoint_number: 2, body: 'Производство у нас своё, поэтому сроки зависят только от нас.' }
];

check('находит «зависят только от нас», не трогает нормальный текст', () => {
  const hits = findBannedPhrases(msgs);
  assert.deepEqual(hits.map((h) => h.touchpoint_number), [2]);
});

check('одобрение reviewer\'а снимается, если есть запрещённая фраза', () => {
  const r = { verdict: 'ОДОБРЕНО', messages_reviewed: [
    { touchpoint_number: 1, verdict: 'ОДОБРЕНО' }, { touchpoint_number: 2, verdict: 'ОДОБРЕНО' }] };
  applyPhraseCheck(r, msgs);
  assert.equal(r.verdict, 'НА ДОРАБОТКУ');
  assert.equal(r.messages_reviewed[0].verdict, 'ОДОБРЕНО');
  assert.equal(r.messages_reviewed[1].verdict, 'НА ДОРАБОТКУ');
  assert.ok(r.messages_reviewed[1].fix_instructions.includes('поставщиков'));
});

check('одобренное касание с запрещённой фразой не замораживается при доработке', () => {
  const reviewer = { messages_reviewed: [
    { touchpoint_number: 1, verdict: 'ОДОБРЕНО' }, { touchpoint_number: 2, verdict: 'ОДОБРЕНО' }] };
  const fresh = { messages: [{ touchpoint_number: 1, body: 'новый 1' }, { touchpoint_number: 2, body: 'новый 2' }] };
  const { output, kept } = keepApprovedTouches(fresh, { messages: msgs }, reviewer);
  assert.deepEqual(kept, [1]);
  assert.equal(output.messages[1].body, 'новый 2');
});

check('упрёк «вы говорили, что пришлёте» ловится, шаблон владельца — нет', () => {
  const bad = [{ touchpoint_number: 1, body: 'Марина, добрый день.\nВы говорили, что пришлёте логотип — он нужен для макета.' }];
  const good = [{ touchpoint_number: 1, body: 'Помните, мы проговаривали, что пришлёте логотип? Скинете сейчас — сразу отдам дизайнеру, и вы получите готовую визуализацию.' }];
  assert.deepEqual(findBannedPhrases(bad).map((h) => h.touchpoint_number), [1]);
  assert.equal(findBannedPhrases(good).length, 0);
  assert.ok(findBannedPhrases(bad)[0].fixes[0].includes('Помните, мы проговаривали'));
});

check('выдуманный кейс «пока ждал ответа — смонтировали…» ловится', () => {
  const bad = [{ touchpoint_number: 4, body: 'Пока ждал ответа — смонтировали кофейню очень похожего формата: объёмные буквы на козырьке.' }];
  const ok = [{ touchpoint_number: 4, body: 'В КП я приложил фото похожих работ — объёмные буквы на козырьке.' }];
  assert.deepEqual(findBannedPhrases(bad).map((h) => h.touchpoint_number), [4]);
  assert.equal(findBannedPhrases(ok).length, 0);
});

check('живой «Зерно 4»: угроза «слот уйдёт» и «нужно решение сегодня» ловятся', () => {
  const bad = [
    { touchpoint_number: 3, body: 'макет нужно согласовать до 19 ноября — иначе слот в производственном плане уйдёт и дата сдвинется.' },
    { touchpoint_number: 5, body: 'Постоянная вывеска — следом. Нужно решение Андрея сегодня.' }];
  assert.deepEqual(findBannedPhrases(bad).map((h) => h.touchpoint_number), [3, 5]);
  assert.equal(findBannedPhrases([{ touchpoint_number: 1, body: 'Согласуем макет сейчас — держим за вами ближайший слот, и дата не сдвинется.' }]).length, 0);
});
check('Зерно 6: «если решение по баннеру не принято до конца сегодня — … без вывески совсем» — давление', () => {
  const hits = findBannedPhrases([{ touchpoint_number: 4, body: 'Если решение по баннеру не принято до конца сегодня — к 1 декабря он уже не успеет, и открытие пройдёт без вывески совсем.' }]);
  assert.ok(hits.length >= 1);
  // честный факт о дате без давления — можно
  assert.equal(findBannedPhrases([{ touchpoint_number: 4, body: 'Сегодня последний день, когда баннер успевает к открытию. Если актуально — напишите «да».' }]).length, 0);
});

console.log(`phraseCheck: ${passed} проверок пройдено`);

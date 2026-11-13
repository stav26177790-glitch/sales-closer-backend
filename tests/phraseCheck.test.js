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

console.log(`phraseCheck: ${passed} проверок пройдено`);

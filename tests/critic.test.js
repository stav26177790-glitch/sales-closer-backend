/**
 * Финальная проверка грубых ошибок в Клоузере (engine/autoCompose.js → criticalGate, владелец 17.11).
 * Агенты подменены: critic находит ошибку → editor правит → critic чисто; editor не помог → writer переписывает.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';
process.env.CRITIC = 'on';
const assert = require('assert');
const pipeline = require('../engine/pipeline');
const calls = [];
let script = {};
pipeline.callAgentSafe = async (name, input) => { calls.push({ name, input }); const f = script[name]; return typeof f === 'function' ? f(input) : f; };
pipeline.runComposer = async () => { calls.push({ name: 'writer' }); return script.writer; };
const { composeUntilReady } = require('../engine/autoCompose');
const { CONFIG } = require('../engine/config');

let n = 0;
async function check(name, fn) { await fn(); n++; console.log(`  ✓ ${name}`); }

const SRC = 'Я (09.11): Отправила КП: 720 000 ₽ с монтажом.\nАрсен: «Сделаете 650 — подписываем до пятницы». Вика: говорить не могу — пишите сюда.';
const base = { today: '2026-11-20', deal: { client: 'Brot' }, materials: { source_materials: { text: SRC } }, timeline: null };
const plan = [{ touchpoint_number: 1, channel: 'Звонок', path_mode: 'step' }];
const good = { messages: [{ touchpoint_number: 1, channel: 'Звонок', body: 'Арсен, 650 — точно не смогу, у меня таких полномочий нет. Попробую согласовать небольшую уступку, если подписываем до пятницы. Как вам в целом?' }] };
const bad = { messages: [{ touchpoint_number: 1, channel: 'Звонок', body: 'Арсен, по цене мы договорились: 650 000 ₽. Как вам в целом?' }] };

(async () => {
  CONFIG.AUTO_COMPOSER_ROUNDS = 1; CONFIG.AUTO_REVIEWS = 0;
  await check('ошибка найдена → редактор исправил → чисто; голос недоступен — «деньги письменно» код отбрасывает', async () => {
    calls.length = 0;
    let k = 0;
    script = {
      critic: () => (k++ === 0 ? { critical: [{ n: 1, error: '1. Цена клиента ниже КП подана как согласованная', quote: 'по цене мы договорились: 650 000 ₽', fix: 'уступка через полномочия' }, { n: 1, error: '6. Деньги письменно', quote: '650' }] } : { critical: [] }),
      editor: { editor_output: { messages: good.messages } },
      writer: good
    };
    const r = await composeUntilReady(base, { id: 't', last_composer_output: bad, last_strategy_output: { touch_plan: plan } }, { startWith: bad });
    assert.equal(r.composer_output._check.critic, 'исправлено редактором: 1', JSON.stringify(r.composer_output._check));
    const ed = calls.filter((c) => c.name === 'editor').pop();
    assert.ok(/Грубая ошибка — 1/.test(JSON.stringify(ed.input)) && !/Грубая ошибка — 6/.test(JSON.stringify(ed.input)));
    const cr = calls.find((c) => c.name === 'critic');
    assert.equal(cr.input.kp_price, '720 000'); assert.equal(cr.input.client_price_ask, '650'); assert.equal(cr.input.voice_available_now, false); assert.equal(cr.input.manager_gender, 'женщина');
  });
  await check('редактор не помог → касание переписано заново writer\'ом', async () => {
    calls.length = 0;
    let k = 0;
    script = {
      critic: () => (k++ < 2 ? { critical: [{ n: 1, error: '1. Цена клиента ниже КП', quote: 'по цене мы договорились: 650 000 ₽' }] } : { critical: [] }),
      editor: { editor_output: { messages: bad.messages } },
      writer: good
    };
    const r = await composeUntilReady(base, { id: 't', last_composer_output: bad, last_strategy_output: { touch_plan: plan } }, { startWith: bad });
    assert.equal(r.composer_output._check.critic, 'переписано заново', JSON.stringify(r.composer_output._check));
    assert.ok(calls.some((c) => c.name === 'writer'));
  });
  await check('чисто сразу — касания не трогаем', async () => {
    calls.length = 0;
    script = { critic: { critical: [] }, editor: { editor_output: { messages: good.messages } }, writer: good };
    const r = await composeUntilReady(base, { id: 't', last_composer_output: good, last_strategy_output: { touch_plan: plan } }, { startWith: good });
    assert.equal(r.composer_output._check.critic, 'чисто');
    const afterCritic = calls.slice(calls.findIndex((c) => c.name === 'critic') + 1);
    assert.ok(!afterCritic.some((c) => c.name === 'editor' || c.name === 'writer'));
  });
  console.log(`critic: ${n} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });

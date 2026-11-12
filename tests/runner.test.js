#!/usr/bin/env node
/**
 * tests/runner.test.js — вызов агента (llm/runner.js) без реального API.
 *
 * Вместо @anthropic-ai/sdk подкладывается фейковый клиент, который
 * запоминает параметры запроса и отдаёт заготовленный ответ. Проверяется:
 * какой запрос уходит в Claude (модель, температура, системный промпт,
 * кэш, вход), как разбирается ответ и как обрабатываются ошибки.
 */
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SDK_PATH = require.resolve('@anthropic-ai/sdk', { paths: [ROOT] });

let clientOptions = null;
const requests = [];
let nextResponse = null;

class FakeAnthropic {
  constructor(options) {
    clientOptions = options;
    this.messages = {
      create: async (params) => {
        requests.push(params);
        if (nextResponse instanceof Error) throw nextResponse;
        return nextResponse;
      }
    };
  }
}
require.cache[SDK_PATH] = { id: SDK_PATH, filename: SDK_PATH, loaded: true, exports: FakeAnthropic, children: [], paths: [] };
for (const p of Object.keys(require.cache)) {
  if (p.startsWith(path.join(ROOT, 'llm')) || p === path.join(ROOT, 'agentRunner.js')) delete require.cache[p];
}

const { callAgent } = require('../agentRunner');
const { buildSystemPrompt } = require('../llm/prompt');
const { AGENTS } = require('../llm/registry');

const reply = (text, extra = {}) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...extra
});
const INPUT = { today: '2026-11-11', deal: { client: 'СтройДвор', industry: 'signage' }, materials: { correspondence: 'привет' } };

const results = [];
async function test(name, fn) {
  requests.length = 0;
  nextResponse = null;
  try {
    await fn();
    results.push(['✅', name]);
  } catch (e) {
    results.push(['❌', `${name}\n   ${e.message}`]);
  }
}

(async () => {
  const realLog = console.log;
  const realWarn = console.warn;
  const warnings = [];
  console.log = () => {};
  console.warn = (m) => warnings.push(String(m));

  await test('Клиент SDK создаётся с maxRetries: 4 (повторы временных сбоев делает SDK)', async () => {
    assert.deepStrictEqual(clientOptions, { maxRetries: 4 });
  });

  await test('composer: модель и температура из registry, весь промпт — один блок с кэшем', async () => {
    nextResponse = reply('{"composer_output":{"messages":[]}}');
    await callAgent('composer', INPUT, 8000);
    const r = requests[0];
    assert.strictEqual(r.model, AGENTS.composer.model);
    assert.strictEqual(r.temperature, AGENTS.composer.temperature);
    assert.strictEqual(r.max_tokens, 8000);
    assert.ok(Array.isArray(r.system) && r.system.length === 1, 'system должен быть массивом из одного блока');
    assert.deepStrictEqual(r.system[0].cache_control, { type: 'ephemeral' });
    assert.strictEqual(r.system[0].text, buildSystemPrompt('composer', 'signage'));
    assert.ok(r.system[0].text.includes('КЕЙСЫ ПО ОТРАСЛИ: signage'), 'кейсы отрасли должны быть в промпте composer');
  });

  await test('strategy: без кэша — системный промпт строкой, как до шага 4', async () => {
    nextResponse = reply('{"strategy_output":{}}');
    await callAgent('strategy', INPUT);
    assert.strictEqual(typeof requests[0].system, 'string');
    assert.strictEqual(requests[0].system, buildSystemPrompt('strategy', 'signage'));
    assert.strictEqual(requests[0].max_tokens, 4000);
  });

  await test('Файл отрасли (knowledge/industry/signage.md) — только для сделок по вывескам и только нужным агентам', async () => {
    const has = (agent, industry) => buildSystemPrompt(agent, industry).includes('# ОТРАСЛЬ СДЕЛКИ:');
    assert.ok(has('composer', 'signage'), 'composer/signage без файла отрасли');
    assert.ok(has('reviewer', 'signage'), 'reviewer/signage без файла отрасли');
    assert.ok(!has('composer', 'saas'), 'saas получил файл отрасли, которого нет');
    assert.ok(!has('diagnostic', 'signage'), 'diagnostic не должен получать факты компании');
    assert.ok(!has('composer', '../agents'), 'путь отрасли не должен выходить за папку');
  });

  await test('Шесть триггеров (24_client_triggers.md) есть у diagnostic, strategy, composer, reviewer, advisor', async () => {
    for (const a of ['diagnostic', 'strategy', 'composer', 'reviewer', 'advisor']) {
      assert.ok(AGENTS[a].knowledge.includes('24_client_triggers.md'), a);
    }
    assert.ok(AGENTS.composer.knowledge.includes('23_lpr_tactics.md'), 'composer без тактики выхода на ЛПР');
  });

  await test('Кэш включён ровно у composer, reviewer, advisor', async () => {
    const cached = Object.entries(AGENTS).filter(([, c]) => c.cache).map(([n]) => n).sort();
    assert.deepStrictEqual(cached, ['advisor', 'composer', 'reviewer']);
  });

  await test('Вход агента — JSON с отступом 2, как раньше', async () => {
    nextResponse = reply('{}');
    await callAgent('planner', INPUT);
    assert.strictEqual(requests[0].messages[0].role, 'user');
    assert.strictEqual(requests[0].messages[0].content, JSON.stringify(INPUT, null, 2));
  });

  await test('Ответ в обёртке ```json разбирается', async () => {
    nextResponse = reply('Вот ответ:\n```json\n{"memory_output":{"session_number":2}}\n```');
    const out = await callAgent('memory', INPUT);
    assert.deepStrictEqual(out, { memory_output: { session_number: 2 } });
  });

  await test('Ответ чистым JSON разбирается', async () => {
    nextResponse = reply('{"advisor_output":{"answer":"да"}}');
    assert.deepStrictEqual(await callAgent('advisor', INPUT), { advisor_output: { answer: 'да' } });
  });

  await test('Неразбираемый ответ → { raw_output, parse_error }, предупреждение про max_tokens', async () => {
    warnings.length = 0;
    nextResponse = reply('```json\n{"composer_output": {"messages": [', { stop_reason: 'max_tokens' });
    const out = await callAgent('composer', INPUT, 8000);
    assert.strictEqual(out.parse_error, true);
    assert.ok(out.raw_output.startsWith('```json'));
    assert.ok(warnings.some((w) => w.includes('max_tokens=8000')), 'нет предупреждения об обрезке ответа');
  });

  await test('Ошибка API пробрасывается сразу, без собственных повторов', async () => {
    nextResponse = Object.assign(new Error('400 invalid_request_error'), { status: 400 });
    await assert.rejects(() => callAgent('planner', INPUT), /400/);
    assert.strictEqual(requests.length, 1, `ожидался 1 запрос, было ${requests.length}`);
  });

  await test('Длинная переписка сокращается до начала + конца', async () => {
    nextResponse = reply('{}');
    const long = 'НАЧАЛО' + 'с'.repeat(20000) + 'ПОСЛЕДНЕЕ СООБЩЕНИЕ';
    await callAgent('planner', { ...INPUT, materials: { correspondence: long } });
    const sent = JSON.parse(requests[0].messages[0].content).materials.correspondence;
    assert.ok(sent.startsWith('НАЧАЛО'), 'потеряно начало');
    assert.ok(sent.endsWith('ПОСЛЕДНЕЕ СООБЩЕНИЕ'), 'потерян конец');
    assert.ok(sent.includes('[середина сокращена]'));
  });

  console.log = realLog;
  console.warn = realWarn;
  for (const [mark, name] of results) console.log(`${mark} ${name}`);
  const failed = results.filter(([m]) => m === '❌').length;
  console.log(`\nИтого: ${results.length - failed}/${results.length} проверок вызова агента пройдено.`);
  process.exit(failed ? 1 : 0);
})();

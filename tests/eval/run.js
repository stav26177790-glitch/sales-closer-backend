/**
 * tests/eval/run.js — прогон набора ситуаций на НАСТОЯЩЕЙ модели (владелец 14.11:
 * «проверь на 16 ситуациях, затем отшлифуем на „Зерне“»).
 *
 * Как менеджер: первое сообщение (ситуация + переписка) → путь без остановок
 * (оценка → стратегия → проверенные касания); если есть ответ клиента — второе
 * сообщение и перестройка пути. База — в памяти (как в tests/harness.js), агенты —
 * настоящие (llm/runner.js), нужен ключ провайдера (llm/provider.js: LLM_PROVIDER=deepseek →
 * DEEPSEEK_API_KEY; по умолчанию Claude → ANTHROPIC_API_KEY).
 *
 * После каждой ситуации — независимая оценка касаний отдельным запросом к модели
 * (судья не видел, как касания писались) по чек-листу из правил владельца.
 *
 * Запуск:  node tests/eval/run.js                 — все ситуации
 *          node tests/eval/run.js --only 1,8,13   — выбранные
 *          node tests/eval/run.js --concurrency 3 — параллельно (по умолчанию 2)
 *          node tests/eval/run.js --no-judge      — без оценки судьёй
 * Итог: eval-report/report.md (читать), eval-report/report.json (данные).
 */
const fs = require('fs');
const path = require('path');
const { SITUATIONS, EVAL_TODAY } = require('./situations');

process.env.KLOUZER_TODAY = process.env.KLOUZER_TODAY || EVAL_TODAY;

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'eval-report');
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ONLY = argVal('--only') ? new Set(argVal('--only').split(',').map(Number)) : null;
const CONCURRENCY = Number(argVal('--concurrency') || 2);
const JUDGE = !args.includes('--no-judge');

const provider = require(path.join(ROOT, 'llm', 'provider.js'));
const PROVIDER = provider.providerConfig();
if (!PROVIDER.apiKey) {
  console.error(`Нет ${PROVIDER.keyEnv} (провайдер ${PROVIDER.name}) — прогон на настоящей модели невозможен.`);
  process.exit(2);
}
console.log(`Провайдер: ${PROVIDER.name}, модели: ${PROVIDER.models.main} / ${PROVIDER.models.small}`);

// ---------- цена (USD) — по тарифу провайдера, llm/provider.js ----------
const costOf = (model, u) => provider.costOf(model, u);

// ---------- окружение: база в памяти, журнал вызовов ----------
const calls = []; // { situation, agent, usage, ms }
let currentSituation = null; // при параллельном запуске — через AsyncLocalStorage
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

function createDb(initialDeal) {
  let deal = { ...initialDeal };
  let memory = null;
  const messages = [];
  return {
    get deal() { return deal; },
    messages,
    api: {
      async getDeal() { return deal; },
      async loadMemory() { return memory; },
      async getMessages() { return messages.slice(); },
      async updateDealState(_id, patch) { deal = { ...deal, ...patch }; return deal; },
      async saveMemory(_id, m) { memory = m; },
      async addMessage(_id, role, content, state) { messages.push({ role, content, state }); }
    }
  };
}

// Каждая ситуация — свои копии модулей проекта с её базой (как tests/harness.js).
function loadEngine(dbApi) {
  for (const p of Object.keys(require.cache)) {
    if (p.startsWith(ROOT) && !p.includes(`${path.sep}node_modules${path.sep}`) && !p.startsWith(__dirname)) delete require.cache[p];
  }
  const fake = (filename, exports) => { require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] }; };
  fake(path.join(ROOT, 'db.js'), dbApi);
  fake(path.join(ROOT, 'engine', 'agentLog.js'), {
    runWithDeal: (_id, fn) => fn(),
    listAgentCalls: async () => [],
    recordAgentCall: ({ agent, usage, durationMs }) => {
      const sit = als.getStore() ?? currentSituation;
      const model = require(path.join(ROOT, 'llm', 'registry.js')).getAgentConfig(agent)?.model;
      calls.push({ situation: sit, agent, model, usage: usage || null, ms: durationMs || 0, cost: costOf(model, usage) });
    }
  });
  return {
    runPath: require(path.join(ROOT, 'engine', 'autoFlow.js')).runPath,
    codeChecks: require(path.join(ROOT, 'engine', 'autoCompose.js')).codeChecks,
    timelineForDeal: require(path.join(ROOT, 'engine', 'timeline.js')).timelineForDeal
  };
}

// ---------- судья: независимая оценка касаний ----------
const RUBRIC = fs.readFileSync(path.join(__dirname, 'rubric.md'), 'utf8');
async function judge(sit, finalTouches, plan, diagnosticSummary) {
  const client = provider.createClient();
  const { getAgentConfig } = require(path.join(ROOT, 'llm', 'registry.js'));
  const model = getAgentConfig('reviewer').model;
  const user = JSON.stringify({
    situation: sit.title, today: process.env.KLOUZER_TODAY, deal: sit.deal,
    conversation: [sit.first, sit.reply].filter(Boolean).join('\n\n--- ответ клиента после касаний ---\n\n'),
    what_this_situation_checks: sit.expect, diagnostic_summary: diagnosticSummary,
    touch_plan: (plan || []).map((p) => ({ n: p.touchpoint_number, timing: p.timing, channel: p.channel, kind: p.kind, criterion: p.criterion, last_chance: p.last_chance, goal: p.goal, facts: p.facts })),
    touches: finalTouches
  }, null, 1);
  const startedAt = Date.now();
  const r = await client.messages.create({ model, max_tokens: 6000, temperature: 0, system: RUBRIC, messages: [{ role: 'user', content: user }], ...PROVIDER.extraParams });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text || '').join('');
  calls.push({ situation: sit.id, agent: 'judge', model, usage: r.usage, ms: Date.now() - startedAt, cost: costOf(model, r.usage) });
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch { return { parse_error: true, raw: text.slice(0, 4000) }; }
}

// ---------- одна ситуация ----------
async function runSituation(sit) {
  const db = createDb({ id: `eval-${sit.name}`, current_state: 'INIT', criteria: { financial: '', need: '', trust: '', authority: '', urgency: '' }, ...sit.deal });
  const { runPath, codeChecks, timelineForDeal } = loadEngine(db.api);
  const parts = [];
  const errors = [];
  const t0 = Date.now();
  const say = async (message, label) => {
    await db.api.addMessage(db.deal.id, 'user', message, db.deal.current_state);
    try {
      await runPath(db.deal.id, message, async (r) => {
        parts.push({ label, text: r.chatText, state: r.nextState });
        await db.api.addMessage(db.deal.id, 'agent', r.chatText, r.nextState);
      });
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      if (/verification_required|can't receive replies/i.test(e.message)) { console.error('Организация Anthropic требует верификации — прогон остановлен.'); process.exit(3); }
      if (e.status === 401 || e.status === 402 || /insufficient balance|authentication/i.test(e.message)) { console.error(`Провайдер ${PROVIDER.name} не принял ключ или кончился баланс (${e.status}) — прогон остановлен.`); process.exit(3); }
    }
  };
  await say(sit.first, 'переписка');
  // Сделка без срока: Клоузер просит «сроки — или напишите «без срока»» — отвечаем как менеджер.
  if (!db.deal.last_composer_output?.messages?.length && /без срока/i.test(String(parts[parts.length - 1]?.text || ''))) {
    await say('без срока', 'без срока');
  }
  const firstTouches = db.deal.last_composer_output?.messages || [];
  const firstPlan = db.deal.last_strategy_output?.touch_plan || [];
  if (sit.reply) await say(sit.reply, 'ответ клиента');
  const deal = db.deal;
  const finalTouches = deal.last_composer_output?.messages || [];
  if (!finalTouches.length) errors.push(`касаний нет; состояние ${deal.current_state}; последний ответ: ${String(parts[parts.length - 1]?.text || '').slice(0, 300)}`);
  const plan = deal.last_strategy_output?.touch_plan || [];
  const timeline = timelineForDeal(deal);
  const source = (db.messages.filter((m) => m.role === 'user').map((m) => m.content)).join('\n\n');
  // Что осталось незакрытым по проверкам кода в итоговых касаниях.
  let residual = [];
  try {
    const r = codeChecks({ messages: finalTouches }, timeline, plan, `${source}\n${deal.client}\n${deal.product}`);
    residual = (r.messages_reviewed || []).filter((x) => x.verdict !== 'ОДОБРЕНО').map((x) => ({ n: x.touchpoint_number, fix: String(x.fix_instructions || '').slice(0, 400) }));
  } catch (e) { errors.push(`codeChecks: ${e.message}`); }
  let verdict = null;
  if (JUDGE && finalTouches.length) {
    try { verdict = await judge(sit, finalTouches, plan, deal.last_diagnostic_output?.diagnostic_summary); } catch (e) { errors.push(`judge: ${e.message}`); }
  }
  return {
    id: sit.id, name: sit.name, title: sit.title, expect: sit.expect,
    seconds: Math.round((Date.now() - t0) / 1000), state: deal.current_state, errors,
    diagnostic: { scores: deal.last_diagnostic_output?.scores, summary: deal.last_diagnostic_output?.diagnostic_summary, soprano_recommendations: deal.last_diagnostic_output?.soprano_recommendations },
    strategy: { name: deal.last_strategy_output?.strategy_name, goal: deal.last_strategy_output?.strategy_goal },
    plan, touches: finalTouches, check: deal.last_composer_output?._check || null,
    first_round: sit.reply ? { plan: firstPlan, touches: firstTouches } : null,
    residual, verdict, chat: parts
  };
}

// ---------- отчёт ----------
function md(results) {
  const total = calls.reduce((s, c) => s + c.cost, 0);
  const byAgent = {};
  for (const c of calls) { byAgent[c.agent] = byAgent[c.agent] || { n: 0, cost: 0 }; byAgent[c.agent].n++; byAgent[c.agent].cost += c.cost; }
  const send = results.flatMap((r) => r.verdict?.touches || []);
  const asIs = send.filter((t) => t.send === 'как есть').length;
  const minor = send.filter((t) => t.send === 'с мелкой правкой').length;
  const no = send.filter((t) => t.send === 'нет').length;
  const L = [];
  L.push(`# Прогон набора ситуаций — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  L.push(`«Сегодня» в прогоне: ${process.env.KLOUZER_TODAY}. Ситуаций: ${results.length}. Провайдер: ${PROVIDER.name} (${PROVIDER.models.main} / ${PROVIDER.models.small}). Цена: **$${total.toFixed(2)}**.`);
  L.push('');
  L.push(`**Касаний оценено: ${send.length}. Отправил бы как есть: ${asIs} (${send.length ? Math.round(asIs / send.length * 100) : 0}%), с мелкой правкой: ${minor}, нет: ${no}.** Планка владельца — 8 из 10 «как есть».`);
  L.push('');
  L.push('| # | Ситуация | Касаний | Как есть | Правка | Нет | Ожидания | Остаток проверок кода | Время | Ошибки |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const t = r.verdict?.touches || [];
    const exp = r.verdict?.expectations || [];
    const met = exp.filter((e) => e.met === 'да').length;
    L.push(`| ${r.id} | ${r.title} | ${r.touches.length} | ${t.filter((x) => x.send === 'как есть').length} | ${t.filter((x) => x.send === 'с мелкой правкой').length} | ${t.filter((x) => x.send === 'нет').length} | ${exp.length ? `${met}/${exp.length}` : '—'} | ${r.residual.length} | ${r.seconds} с | ${r.errors.length ? r.errors.length : ''} |`);
  }
  L.push('');
  L.push('## Цена по агентам');
  for (const [a, v] of Object.entries(byAgent).sort((x, y) => y[1].cost - x[1].cost)) L.push(`- ${a}: ${v.n} вызовов, $${v.cost.toFixed(2)}`);
  const issues = {};
  for (const r of results) for (const t of r.verdict?.touches || []) for (const i of t.issues || []) { const k = i.rule || i.type || 'прочее'; issues[k] = (issues[k] || 0) + 1; }
  L.push('');
  L.push('## Частые замечания судьи');
  for (const [k, n] of Object.entries(issues).sort((a, b) => b[1] - a[1]).slice(0, 20)) L.push(`- ${k}: ${n}`);
  for (const r of results) {
    L.push('');
    L.push(`---\n\n## ${r.id}. ${r.title}`);
    if (r.errors.length) L.push(`**Ошибки:** ${r.errors.join('; ')}`);
    L.push(`Состояние: ${r.state}. Время: ${r.seconds} с. Стратегия: ${r.strategy.name || '—'} — ${r.strategy.goal || ''}`);
    if (r.verdict?.summary) L.push(`\n**Судья:** ${r.verdict.summary}`);
    for (const e of r.verdict?.expectations || []) L.push(`- ${e.met === 'да' ? '✅' : e.met === 'частично' ? '🟡' : '❌'} ${e.expectation}${e.comment ? ` — ${e.comment}` : ''}`);
    if (r.residual.length) { L.push('\n**Остались замечания проверок кода:**'); for (const x of r.residual) L.push(`- касание ${x.n}: ${x.fix}`); }
    L.push('\n**План:**');
    for (const p of r.plan) L.push(`${p.touchpoint_number}. ${p.timing} · ${p.channel} · ${p.last_chance ? 'последний шанс' : p.kind}${p.criterion ? ` · ${String(p.criterion).split(' —')[0]}` : ''} — ${p.goal || ''}`);
    L.push('\n**Касания:**');
    r.touches.forEach((m, i) => {
      const v = (r.verdict?.touches || []).find((x) => Number(x.n) === Number(m.touchpoint_number ?? i + 1));
      L.push(`\n### Касание ${m.touchpoint_number ?? i + 1} · ${m.channel || ''} — ${v ? `**${v.send}**` : ''}`);
      if (m.timing) L.push(`_Когда: ${m.timing}_`);
      if (m.hook?.prep) L.push(`_Перед касанием: ${String(m.hook.prep).replace(/^перед касанием:?\s*/i, '')}_`);
      L.push('');
      L.push(String(m.body || '').split('\n').map((x) => `> ${x}`).join('\n'));
      for (const i2 of v?.issues || []) L.push(`- ⚠️ ${i2.rule || ''}: ${i2.comment || ''}`);
    });
  }
  return L.join('\n');
}

async function main() {
  const list = SITUATIONS.filter((s) => !ONLY || ONLY.has(s.id));
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`Прогон: ${list.length} ситуаций, параллельно ${CONCURRENCY}, «сегодня» ${process.env.KLOUZER_TODAY}, судья: ${JUDGE ? 'да' : 'нет'}`);
  // Модули проекта перезагружаются на каждую ситуацию, поэтому параллельность —
  // через отдельные процессы было бы чище; здесь ситуации внутри одного процесса
  // разделены AsyncLocalStorage, а модули грузятся перед стартом каждой.
  const results = [];
  const queue = list.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, list.length)) }, async () => {
    while (queue.length) {
      const sit = queue.shift();
      console.log(`→ ${sit.id}. ${sit.title}`);
      const r = await als.run(sit.id, () => runSituation(sit)).catch((e) => ({ id: sit.id, name: sit.name, title: sit.title, expect: sit.expect, errors: [e.stack || e.message], touches: [], plan: [], residual: [], strategy: {}, seconds: 0 }));
      console.log(`← ${sit.id}. ${r.touches.length} касаний, ${r.seconds} с${r.errors.length ? `, ошибки: ${r.errors.length}` : ''}`);
      results.push(r);
      fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ today: process.env.KLOUZER_TODAY, calls, results: results.slice().sort((a, b) => a.id - b.id) }, null, 1));
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.id - b.id);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ today: process.env.KLOUZER_TODAY, calls, results }, null, 1));
  fs.writeFileSync(path.join(OUT, 'report.md'), md(results));
  console.log(`Готово: eval-report/report.md. Цена: $${calls.reduce((s, c) => s + c.cost, 0).toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

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
// Повторы доводов (владелец 16.11: «Клоузер не должен долбить одно и то же») — по доводам, как проверка кода.
function repeatedPhrases(touches) {
  const { repeatedArguments } = require('../../engine/planChecks');
  const r = repeatedArguments(touches || []);
  return { count: r.length, examples: r.map((x) => ({ phrase: x.key, touches: [x.firstIn, x.touchpoint_number] })) };
}
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
// Судья 17.11: ему не давали факты компании → ложные «не подтверждено» (Щёлково, ОТК). Даём файл отрасли и 902-ПП.
const RUBRIC = [
  fs.readFileSync(path.join(__dirname, 'rubric.md'), 'utf8'),
  '# Факты компании (файл отрасли — всё здесь НЕ выдумка)\n\n' + fs.readFileSync(path.join(ROOT, 'knowledge', 'industry', 'signage.md'), 'utf8'),
  '# 902-ПП (только если объект в Москве)\n\n' + fs.readFileSync(path.join(ROOT, 'knowledge', 'industry', 'signage_902pp.md'), 'utf8')
].join('\n\n');
async function judge(sit, sets, diagnosticSummary) {
  const client = provider.createClient();
  const { getAgentConfig } = require(path.join(ROOT, 'llm', 'registry.js'));
  const model = getAgentConfig('reviewer').model;
  const planOf = (plan) => (plan || []).map((p) => ({ n: p.touchpoint_number, timing: p.timing, channel: p.channel, kind: p.kind, criterion: p.criterion, last_chance: p.last_chance, goal: p.goal, how: p.how, facts: p.facts }));
  // Судья 17.11 путал статус срока касаний (брал «не успеваем» чужого касания) — каждому касанию свой статус рядом.
  const withFacts = (touches, plan) => (touches || []).map((t) => {
    const p = (plan || []).find((q) => q.touchpoint_number === Number(t.touchpoint_number));
    return p?.facts?.status_on_send_day ? { ...t, srok_na_den_otpravki: `${p.facts.status_on_send_day}; готово при старте в день отправки: ${p.facts.permanent_ready_if_start_that_day}` } : t;
  });
  // Прицельный прогон 18.11: основной судья не получал `voice_available_now` и вилку (их видел только судья грубых
  // ошибок) — «деньги письменно» клиентке без телефона и «вилка — выдумка» в «Гибкости» (7 ложных «нет»).
  const { voiceBlocked } = require(path.join(ROOT, 'engine', 'voice.js'));
  const { priceGuide } = require(path.join(ROOT, 'engine', 'priceGuide.js'));
  const convAt = (k) => [sit.first, ...(sit.steps || []).slice(0, k).map((x) => x.text)].join('\n\n');
  const codeFacts = (conv) => {
    const pg = priceGuide(sit.deal, conv);
    return { voice_available_now: !voiceBlocked(conv), price_guide: pg ? { client_range: pg.client_range } : null };
  };
  const setOf = (x, conv) => (x && x.touches?.length ? { path_mode: x.plan?.[0]?.path_mode || 'full', ...codeFacts(conv), touch_plan: planOf(x.plan), touches: withFacts(x.touches, x.plan) } : null);
  const user = JSON.stringify({
    situation: sit.title, today: process.env.KLOUZER_TODAY, deal: sit.deal,
    conversation: sit.steps
      ? [sit.first, ...sit.steps.map((x) => `--- ${x.label} (сегодня ${x.today}) ---\n${x.text}`)].join('\n\n')
      : [sit.first, sit.reply].filter(Boolean).join('\n\n--- ответ клиента после касаний ---\n\n'),
    what_this_situation_checks: sit.expect, diagnostic_summary: diagnosticSummary,
    before_reply: setOf(sets.before, convAt(0)),
    after_reply: setOf(sets.after, sit.steps ? convAt(sit.steps.length) : [sit.first, sit.reply].filter(Boolean).join('\n\n')),
    // Многоуровневая сделка: промежуточные шаги (после каждой дописки менеджера).
    intermediate_stages: (sets.stages || []).map((x, i) => ({ after: x.label, today: x.today, what_this_step_checks: x.expect || [], ...setOf(x, convAt(i + 1)) }))
  }, null, 1);
  // Полный прогон 19.11 (ситуация 24): судья зациклился на одной находке и упёрся в лимит — JSON оборван, 0 касаний
  // оценено. Один повтор с небольшой температурой (при 0 повтор дал бы ту же петлю).
  let last;
  for (const temperature of [0, 0.3]) {
    const startedAt = Date.now();
    const r = await client.messages.create({ model, max_tokens: 9000, temperature, system: RUBRIC, messages: [{ role: 'user', content: user }], ...PROVIDER.extraParams });
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text || '').join('');
    calls.push({ situation: sit.id, agent: 'judge', model, usage: r.usage, ms: Date.now() - startedAt, cost: costOf(model, r.usage) });
    const m = text.match(/\{[\s\S]*\}/);
    try { return JSON.parse(m ? m[0] : text); } catch { last = { parse_error: true, raw: text.slice(0, 4000) }; }
  }
  return last;
}

// Судья 17.11: в общем вызове (все ходы сразу, ~40 тыс. знаков) грубую ошибку «по цене договорились: 650 000 ₽»
// судья пропускал трижды. Отдельный короткий вызов на каждый ход — только грубые ошибки, по переписке НА МОМЕНТ
// хода, с ценой КП. Найденное сливается в verdict.critical; такие касания — «нет».
const CRITICAL_RUBRIC = (() => {
  const r = fs.readFileSync(path.join(__dirname, 'rubric.md'), 'utf8');
  const a = r.indexOf('# Грубые ошибки'); const b = r.indexOf('# Не считай ошибкой'); const d = r.indexOf('# Образцы');
  return ['Ты — проверяющий касаний отдела продаж вывесок. Найди ТОЛЬКО грубые ошибки по списку ниже — в КАЖДОМ касании, медленно, фраза за фразой. Ничего другого не оценивай.',
    r.slice(a, b), r.slice(b, d),
    'Ответ — только JSON: {"critical": [{"n": номер касания, "error": "номер и название ошибки", "quote": "цитата до 15 слов"}]}. Нет ошибок — {"critical": []}.',
    '# Факты компании\n\n' + fs.readFileSync(path.join(ROOT, 'knowledge', 'industry', 'signage.md'), 'utf8')].join('\n\n');
})();
const withFactsC = (touches, plan) => (touches || []).map((t) => {
  const p = (plan || []).find((q) => q.touchpoint_number === Number(t.touchpoint_number));
  return p?.facts?.status_on_send_day ? { ...t, srok_na_den_otpravki: `${p.facts.status_on_send_day}; готово при старте в день отправки: ${p.facts.permanent_ready_if_start_that_day}` } : t;
});
async function criticalScan(sit, label, today, conversation, x) {
  if (!x || !x.touches?.length) return [];
  const client = provider.createClient();
  const { getAgentConfig } = require(path.join(ROOT, 'llm', 'registry.js'));
  const model = getAgentConfig('reviewer').model;
  const kp = String(sit.first || '').match(/КП[^.\n]{0,15}?:?\s*(\d{2,3}(?:[  ]\d{3}))\s*₽/i);
  // Прогон 4: судья ставил «деньги письменно», когда клиент просил писать, и «не тот род» на «решила» / «подготовлю».
  // Голос и род считает код — судье готовыми фактами.
  const { voiceBlocked } = require(path.join(ROOT, 'engine', 'voice.js'));
  const { managerGender } = require(path.join(ROOT, 'engine', 'planChecks.js'));
  const g = managerGender(conversation);
  const pg = require(path.join(ROOT, 'engine', 'priceGuide.js')).priceGuide(sit.deal, conversation);
  const user = JSON.stringify({ today, kp_price: kp ? kp[1] : null, price_guide: pg ? { client_range: pg.client_range } : null, deal: sit.deal, conversation_so_far: conversation,
    voice_available_now: !voiceBlocked(conversation), manager_gender: g === 'f' ? 'женщина' : g === 'm' ? 'мужчина' : 'неизвестно',
    path_mode: x.plan?.[0]?.path_mode || 'full', touches: withFactsC(x.touches, x.plan) }, null, 1);
  const startedAt = Date.now();
  const r = await client.messages.create({ model, max_tokens: 3000, temperature: 0, system: CRITICAL_RUBRIC, messages: [{ role: 'user', content: user }], ...PROVIDER.extraParams });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text || '').join('');
  calls.push({ situation: sit.id, agent: 'judge_critical', model, usage: r.usage, ms: Date.now() - startedAt, cost: costOf(model, r.usage) });
  try { return (JSON.parse((text.match(/\{[\s\S]*\}/) || [text])[0]).critical || []).map((c) => ({ ...c, set: label })); } catch { return []; }
}
// Шаг 2б дорожной карты (20.11): перепроверка тех же текстов шага 2 дала совпадение лишь 75% оценок, «как есть»
// 65% → 58% без смены текстов — шумит судья. Тройной судья: каждое касание оценивается JUDGE_VOTES раз, итог —
// медиана (= большинство): «нет» — только если так решили минимум двое из трёх. То же для ожиданий и грубых ошибок.
const JUDGE_VOTES = Math.max(1, Number(process.env.JUDGE_VOTES || 3));
const SEND_RANK = { 'как есть': 0, 'с мелкой правкой': 1, 'нет': 2 };
const MET_RANK = { 'да': 0, 'частично': 1, 'нет': 2 };
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2) + (xs.length % 2 ? 0 : 1)];
function mergeVerdicts(vs) {
  const ok = vs.filter((v) => v && !v.parse_error);
  if (ok.length <= 1) return ok[0] || vs[0];
  const base = JSON.parse(JSON.stringify(ok[0]));
  const byKey = new Map();
  for (const v of ok) for (const t of v.touches || []) { const k = `${t.set}|${t.n}`; byKey.set(k, [...(byKey.get(k) || []), t]); }
  base.touches = [...byKey.values()].map((ts) => {
    const m = median(ts.map((t) => SEND_RANK[t.send] ?? 1));
    return { ...(ts.find((t) => (SEND_RANK[t.send] ?? 1) === m) || ts[0]), votes: ts.map((t) => t.send) };
  });
  base.expectations = (base.expectations || []).map((e, i) => {
    const ms = ok.map((v) => (v.expectations || [])[i]).filter(Boolean);
    const m = median(ms.map((x) => MET_RANK[String(x.met || '').toLowerCase()] ?? 1));
    return ms.find((x) => (MET_RANK[String(x.met || '').toLowerCase()] ?? 1) === m) || e;
  });
  const ck = (c) => `${c.set}|${c.n}|${String(c.error || '').match(/\d+/)?.[0] || c.error}`;
  const count = new Map();
  for (const v of ok) for (const k of new Set((v.critical || []).map(ck))) count.set(k, (count.get(k) || 0) + 1);
  const seen = new Set();
  base.critical = ok.flatMap((v) => v.critical || []).filter((c) => { const k = ck(c); if (count.get(k) * 2 <= ok.length || seen.has(k)) return false; seen.add(k); return true; });
  base.judge_votes = ok.length;
  return base;
}
async function judgeWithCritical(sit, sets, diagnosticSummary) {
  const v = mergeVerdicts(await Promise.all(Array.from({ length: JUDGE_VOTES }, () => judge(sit, sets, diagnosticSummary))));
  if (!v || v.parse_error) return v;
  const steps = sit.steps || [];
  const conv = (k) => [sit.first, ...steps.slice(0, k).map((x) => `--- ${x.label} (сегодня ${x.today}) ---\n${x.text}`)].join('\n\n');
  // Шаг 5 (20.11): судья грубых ошибок звучал один раз, а любая его находка ставит касанию «нет» — тройной основной
  // судья не спасал от его шума. Тоже JUDGE_VOTES раз: находка остаётся, если её дали больше половины прогонов.
  const voteScan = async (...a) => {
    const runs = await Promise.all(Array.from({ length: JUDGE_VOTES }, () => criticalScan(...a)));
    const k = (c) => `${c.set}|${c.n}|${String(c.error || '').match(/\d+/)?.[0] || c.error}`;
    const cnt = new Map();
    for (const r of runs) for (const kk of new Set((r || []).map(k))) cnt.set(kk, (cnt.get(kk) || 0) + 1);
    const seen = new Set();
    return runs.flat().filter((c) => c && cnt.get(k(c)) * 2 > runs.length && !seen.has(k(c)) && seen.add(k(c)));
  };
  const jobs = [voteScan(sit, 'before_reply', process.env.KLOUZER_TODAY, conv(0), sets.before)];
  (sets.stages || []).forEach((x, i) => jobs.push(voteScan(sit, `intermediate_stages[${i}]`, x.today, conv(i + 1), x)));
  if (sets.after && steps.length) jobs.push(voteScan(sit, 'after_reply', steps.at(-1).today, conv(steps.length), sets.after));
  // Ошибка 2 — только обещание к открытию / к дате; честная дата готовности без «к открытию» — не ошибка (прогон 4:
  // судья ставил ⛔ на «при старте сегодня — готово 16–17 декабря»). Код отсеивает такие находки.
  const isErr2 = (c) => /^\s*2\b|обещани[ея] срока/i.test(String(c.error || ''));
  const keep = (c) => !isErr2(c) || (/к открыт|успева|успеем|к \d{1,2} (ноябр|декабр|январ)/i.test(String(c.quote || '')) && !/не успева|уже не|позже|временн/i.test(String(c.quote || '')));
  // Ошибка 6 «деньги письменно» — неверна, если на момент хода голос недоступен (прогон 5: судья не верил полю).
  const { voiceBlocked } = require(path.join(ROOT, 'engine', 'voice.js'));
  const convOf = (set) => { const m = String(set || '').match(/\[(\d+)\]/); return conv(set === 'before_reply' ? 0 : m ? Number(m[1]) + 1 : steps.length); };
  const isErr6 = (c) => /^\s*6\b|деньги письменно/i.test(String(c.error || ''));
  const keep6 = (c) => !isErr6(c) || !voiceBlocked(convOf(c.set));
  // Прогон 6: судья ставил ошибку 2 на «к открытию» при «впритык» — по рубрике обещать можно. Сверяем со статусом касания.
  const planOfSet = (set) => { const m = String(set || '').match(/\[(\d+)\]/); return (set === 'before_reply' ? sets.before : set === 'after_reply' ? sets.after : m ? (sets.stages || [])[Number(m[1])] : null)?.plan || []; };
  const keep2 = (c) => !isErr2(c) || !/с запасом|впритык/i.test(String(planOfSet(c.set).find((p) => p.touchpoint_number === Number(c.n))?.facts?.status_on_send_day || ''));
  const { keepCritical } = require(path.join(ROOT, 'engine', 'criticFilters.js'));
  const setTouches = (set) => { const m = String(set || '').match(/\[(\d+)\]/); return (set === 'before_reply' ? sets.before : set === 'after_reply' ? sets.after : m ? (sets.stages || [])[Number(m[1])] : null)?.touches || []; };
  const { priceGuide } = require(path.join(ROOT, 'engine', 'priceGuide.js'));
  const keepAll = (c) => keepCritical(c, { priceGuide: priceGuide(sit.deal, convOf(c.set)), source: convOf(c.set), status: planOfSet(c.set).find((p) => p.touchpoint_number === Number(c.n))?.facts?.status_on_send_day, channel: setTouches(c.set).find((t) => Number(t.touchpoint_number) === Number(c.n))?.channel });
  const extra = (await Promise.all(jobs)).flat().filter(keep).filter(keep6).filter(keep2).filter(keepAll);
  v.critical = (v.critical || []).filter(keep2).filter(keepAll);
  v.critical = (v.critical || []).filter(keep6);
  v.critical = (v.critical || []).filter(keep);
  // Шаг 5 (20.11): «Решил записать короткое видео … у меня появилась идея, уверен, она вас точно заинтересует!» — образец
  // владельца для кружка-интриги (touchPlan), а судья грубых ошибок ставил «неживая речь».
  const OWNER_KRUG_RE = /появилась идея,? уверен[а]?,? (она )?вас точно заинтересует|решил[а]? записать (короткое )?видео/i;
  v.critical = (v.critical || []).filter((c) => !(/неживая речь|^\s*10\b/i.test(String(c.error || '')) && OWNER_KRUG_RE.test(String(c.quote || ''))));
  // Полный прогон 19.11 (ситуация 19): основной судья ставил «нет» по «честности сроков» на «готова 7–8 декабря»
  // при «с запасом» и на «готова 15–16 декабря» при «не успеваем» — это и есть расчётная дата (рубрика: не ошибка).
  // Снимаем такие «нет», только если в тексте касания нет обещания к открытию / к дате клиента.
  const PROMISE_RE = /к открыт|успеем|успеваем|к \d{1,2} (ноябр|декабр|январ)/i;
  const honestDates = (set, n) => {
    const st = String(planOfSet(set).find((p) => p.touchpoint_number === Number(n))?.facts?.status_on_send_day || '');
    if (/с запасом|впритык/i.test(st)) return true;
    const body = String(setTouches(set).find((t) => Number(t.touchpoint_number) === Number(n))?.body || '');
    return !body.split(/(?<=[.!?\n])/).some((x) => PROMISE_RE.test(x) && !/не успева|не успеем|уже не|позже|временн/i.test(x));
  };
  for (const t of v.touches || []) {
    if (t.send !== 'нет' || !(t.issues || []).length) continue;
    const srok = (i) => /срок|обещание к (открыт|дат)/i.test(String(i.rule || '')) && !/грубая/i.test(String(i.rule || ''));
    if (!t.issues.some(srok) || !honestDates(t.set, t.n)) continue;
    const rest = t.issues.filter((i) => !srok(i));
    t.filtered = (t.filtered || []).concat(t.issues.filter(srok));
    t.issues = rest;
    t.send = rest.length ? 'с мелкой правкой' : 'как есть';
  }
  // Прогон 19.11 (день): «деньги письменно» звонку (ситуация 6) и при `voice_available_now: false` (19, 24) — рубрика это
  // прямо разрешает, судья не слушал. Снимаем только такие «нет»; остальные его находки остаются.
  // Шаг 7 (20.11): итоговое письмо после договорённости голосом — финальная сумма и условия письменно можно
  // (владелец 19.11: «только итоговая сумма, без „уступка N%“»); судья ставил «деньги письменно».
  const SUMMARY_RE = /резюмир|договор[её]нност|по итогам (наш|встреч|звонк|разговор|созвон)|как (и )?договорились|фиксирую (наши )?договор/i;
  const summaryOk = (body) => SUMMARY_RE.test(body) && !/уступк|скидк|минус \d|−\s*\d/i.test(body);
  for (const t of v.touches || []) {
    // Шаг 7: снимаем ложные «деньги письменно» и с «мелкой правки», а не только с «нет» (ситуации 1, 14, 18).
    if (t.send === 'как есть' || !(t.issues || []).length) continue;
    const money = (i) => /деньги письменно/i.test(String(i.rule || ''));
    const ch = String(setTouches(t.set).find((x) => Number(x.touchpoint_number) === Number(t.n))?.channel || '');
    // Шаг 5 (20.11): цена / состав / условия из КП в письме для пересылки ЛПР — можно (владелец 20.11); судья не слушал.
    const body = String(setTouches(t.set).find((x) => Number(x.touchpoint_number) === Number(t.n))?.body || '');
    const { moneySentences } = require(path.join(ROOT, 'engine', 'planChecks.js'));
    const lprOk = /пересыл|переслать|перешл|передайте|для передачи|для (руководител|собственник|владельц|директор)/i.test(body) && !moneySentences(body, { forLpr: true }).length;
    // Разбор 20.11: приглашение обсудить цену голосом («в Zoom … и по цене сразу всё обсудим») — это и есть «деньги
    // голосом» (владелец 20.11: «там всё в Zoom или звонке проговаривается»); сроки и гарантия — не деньги.
    const inviteOk = !moneySentences(body).length && t.issues.filter(money).every((i) => /обсуд|проговор|zoom|звон|созвон|срок|рабочих дн|гаранти|отк/i.test(String(i.comment || '')));
    if (!t.issues.some(money) || !(/звон|zoom|зум|встреч/i.test(ch) || voiceBlocked(convOf(t.set)) || lprOk || inviteOk || summaryOk(body))) continue;
    const rest = t.issues.filter((i) => !money(i));
    t.filtered = (t.filtered || []).concat(t.issues.filter(money));
    t.issues = rest;
    t.send = rest.length ? 'с мелкой правкой' : 'как есть';
  }
  const key = (c) => `${c.set}|${c.n}|${String(c.error || '').match(/\d+/)?.[0] || c.error}`;
  const have = new Set((v.critical || []).map(key));
  v.critical = [...(v.critical || []), ...extra.filter((c) => !have.has(key(c)))];
  // Шаг 5 (20.11): «деньги письменно» на письме для пересылки ЛПР с ценой / составом КП — можно (владелец 20.11).
  { const { moneySentences } = require(path.join(ROOT, 'engine', 'planChecks.js'));
    const lprOk = (c) => { const b = String(setTouches(c.set).find((x) => Number(x.touchpoint_number) === Number(c.n))?.body || '');
      return /пересыл|переслать|перешл|передайте|для передачи|для (руководител|собственник|владельц|директор)/i.test(b) && !moneySentences(b, { forLpr: true }).length; };
    const chOf = (c) => String(setTouches(c.set).find((x) => Number(x.touchpoint_number) === Number(c.n))?.channel || '');
    const bodyOf = (c) => String(setTouches(c.set).find((x) => Number(x.touchpoint_number) === Number(c.n))?.body || '');
    // Шаг 7: цена в сценарии звонка — это голос; итог после договорённости голосом — финальная сумма письменно можно.
    v.critical = v.critical.filter((c) => !(isErr6(c) && (lprOk(c) || /звон|zoom|зум|встреч/i.test(chOf(c)) || summaryOk(bodyOf(c))))); }
  // Шаг 7 (20.11): «Что я сделал(а) не так?» — шаблон владельца для последнего шанса / проигранной сделки (рубрика п.3),
  // судья снимал его как «самобичевание» (ситуация 15). Замечания, которые цепляются только за этот шаблон, снимаем.
  { const OWNER_TPL_RE = /что я сделал[а]? не так|в открытую/i;
    for (const t of v.touches || []) {
      if (t.send === 'как есть' || !(t.issues || []).length) continue;
      const tpl = (i) => !/грубая/i.test(String(i.rule || '')) && OWNER_TPL_RE.test(String(i.comment || '') + ' ' + String(i.quote || ''));
      if (!t.issues.some(tpl)) continue;
      const rest = t.issues.filter((i) => !tpl(i));
      t.filtered = (t.filtered || []).concat(t.issues.filter(tpl));
      t.issues = rest;
      if (!rest.length) t.send = 'как есть';
      else if (t.send === 'нет' && !rest.some((i) => /грубая/i.test(String(i.rule || '')))) t.send = 'с мелкой правкой';
    }
    v.critical = (v.critical || []).filter((c) => !OWNER_TPL_RE.test(String(c.quote || ''))); }
  for (const c of v.critical) {
    const t = (v.touches || []).find((x) => x.set === c.set && Number(x.n) === Number(c.n));
    if (t && t.send !== 'нет') { t.send = 'нет'; t.issues = [...(t.issues || []), { rule: `Грубая ошибка: ${c.error}`, comment: c.quote || '' }]; }
  }
  return v;
}

// ---------- живой прогресс (владелец 18.11: «показывать прогресс симуляции онлайн») ----------
// После каждого хода — ответ Клоузера (как в чате) в ветку eval-live: live/<run_id>/<ситуация>.md. Только в GitHub Actions.
const { execSync } = require('child_process');
const LIVE_DIR = '/tmp/live';
let liveReady = false;
function liveSh(cmd, cwd) { return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
function livePublish(sit, label, chatText) {
  if (!process.env.GITHUB_ACTIONS || !process.env.GITHUB_RUN_ID) return;
  try {
    if (!liveReady) {
      liveSh('git config user.name "eval-bot" && git config user.email "eval-bot@users.noreply.github.com"', ROOT);
      let remote = true;
      try { liveSh('git ls-remote --exit-code --heads origin eval-live', ROOT); } catch { remote = false; }
      if (remote) liveSh(`git fetch -q --depth 1 origin eval-live && git worktree add -q -B eval-live ${LIVE_DIR} FETCH_HEAD`, ROOT);
      else liveSh(`git worktree add -q --orphan -b eval-live ${LIVE_DIR}`, ROOT);
      liveReady = true;
    }
    const dir = path.join(LIVE_DIR, 'live', String(process.env.GITHUB_RUN_ID));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sit.id}.md`);
    const head = fs.existsSync(file) ? '' : `# ${sit.id}. ${sit.title}\n\n`;
    fs.appendFileSync(file, `${head}## ${new Date().toISOString().slice(11, 16)} UTC — ${label} (сегодня ${process.env.KLOUZER_TODAY})\n\n${chatText || '(ответа нет)'}\n\n---\n\n`);
    liveSh(`git add -A && git commit -qm "live ${sit.id}: ${label.replace(/["`$]/g, '')}" && (git push -q origin eval-live || (git pull -q --rebase origin eval-live && git push -q origin eval-live))`, LIVE_DIR);
  } catch (e) { console.error(`живой прогресс: ${String(e.message).slice(0, 200)}`); }
}

// ---------- одна ситуация ----------
// Многоуровневые сделки меняют «сегодня» через process.env (одно на процесс) — параллельно две такие
// сделки путали даты (симулятор 16.11: шаг 20.11 посчитался от 19.11). Идут по очереди.
let stepLock = Promise.resolve();
async function runSituation(sit) {
  if (sit.steps) {
    let release; const prev = stepLock; stepLock = new Promise((r) => { release = r; });
    await prev;
    try { return await runSituationInner(sit); } finally { release(); }
  }
  return runSituationInner(sit);
}
async function runSituationInner(sit) {
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
  if (sit.today) process.env.KLOUZER_TODAY = sit.today; // свой «сегодня» у первого хода (живой тест владельца)
  await say(sit.first, 'переписка');
  // Сделка без срока: Клоузер просит «сроки — или напишите «без срока»» — отвечаем как менеджер.
  if (!db.deal.last_composer_output?.messages?.length && /без срока/i.test(String(parts[parts.length - 1]?.text || ''))) {
    await say('без срока', 'без срока');
  }
  livePublish(sit, 'первый ход', parts.filter((x) => x.label === 'переписка' || x.label === 'без срока').map((x) => x.text).join('\n\n'));
  const firstTouches = db.deal.last_composer_output?.messages || [];
  const firstPlan = db.deal.last_strategy_output?.touch_plan || [];
  if (sit.reply) await say(sit.reply, 'ответ клиента');
  // Многоуровневая сделка (15.11): цепочка дописок менеджера, у каждой — своё «сегодня».
  const stages = [];
  const baseToday = process.env.KLOUZER_TODAY;
  for (const st of sit.steps || []) {
    if (st.today) process.env.KLOUZER_TODAY = st.today;
    const before = db.deal.last_composer_output;
    await say(st.text, st.label);
    const d = db.deal;
    stages.push({ label: st.label, today: process.env.KLOUZER_TODAY, expect: st.expect || [],
      plan: d.last_strategy_output?.touch_plan || [], touches: d.last_composer_output !== before ? (d.last_composer_output?.messages || []) : [],
      scores: d.last_diagnostic_output?.scores, soprano: d.last_diagnostic_output?.soprano, soprano_recs: d.last_diagnostic_output?.soprano_recommendations,
      chat: parts.filter((x) => x.label === st.label).map((x) => x.text).join('\n\n') });
    livePublish(sit, st.label, stages[stages.length - 1].chat);
  }
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
  process.env.KLOUZER_TODAY = baseToday; // проверки кода выше — от «сегодня» последнего шага
  let verdict = null;
  if (JUDGE && finalTouches.length) {
    const sets = sit.reply || sit.steps ? { before: { touches: firstTouches, plan: firstPlan }, after: { touches: finalTouches, plan }, stages: stages.slice(0, -1) } : { before: { touches: finalTouches, plan } };
    try { verdict = await judgeWithCritical(sit, sets, deal.last_diagnostic_output?.diagnostic_summary); } catch (e) { errors.push(`judge: ${e.message}`); }
    if (verdict && !verdict.parse_error) {
      const msgs = verdict.touches || [];
      const cnt = (re) => msgs.filter((m) => re.test(String(m.send || ''))).length;
      const crit = (verdict.critical || []).map((c) => `- ⛔ ${c.error}: «${String(c.quote || '').slice(0, 120)}»`).join('\n');
      const miss = (verdict.missing || []).map((m) => `- 🔎 ${String(m).slice(0, 200)}`).join('\n');
      livePublish(sit, 'оценка судьи', `**Касаний: ${msgs.length} · как есть ${cnt(/как есть/i)} · с правкой ${cnt(/правк/i)} · нет ${cnt(/^нет/i)}**\n\n${verdict.summary || ''}\n\n${crit}\n${miss}`);
    }
  }
  return {
    id: sit.id, name: sit.name, title: sit.title, expect: sit.expect,
    seconds: Math.round((Date.now() - t0) / 1000), state: deal.current_state, errors,
    diagnostic: { scores: deal.last_diagnostic_output?.scores, summary: deal.last_diagnostic_output?.diagnostic_summary, soprano_recommendations: deal.last_diagnostic_output?.soprano_recommendations },
    strategy: { name: deal.last_strategy_output?.strategy_name, goal: deal.last_strategy_output?.strategy_goal },
    plan, touches: finalTouches, check: deal.last_composer_output?._check || null,
    first_round: sit.reply || sit.steps ? { plan: firstPlan, touches: firstTouches } : null,
    stages,
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
  for (const [key, title] of [['before_reply', 'До ответа клиента'], ['after_reply', 'После ответа клиента (следующий шаг)']]) {
    const x = send.filter((t) => (t.set || 'before_reply') === key);
    if (x.length) L.push(`- ${title}: ${x.length} касаний, как есть ${x.filter((t) => t.send === 'как есть').length} (${Math.round(x.filter((t) => t.send === 'как есть').length / x.length * 100)}%), с правкой ${x.filter((t) => t.send === 'с мелкой правкой').length}, нет ${x.filter((t) => t.send === 'нет').length}`);
  }
  L.push('');
  L.push('| # | Ситуация | Касаний | Как есть | Правка | Нет | Ожидания | Остаток проверок кода | Время | Ошибки |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const t = r.verdict?.touches || [];
    const exp = r.verdict?.expectations || [];
    const met = exp.filter((e) => e.met === 'да').length;
    L.push(`| ${r.id} | ${r.title} | ${t.length} | ${t.filter((x) => x.send === 'как есть').length} | ${t.filter((x) => x.send === 'с мелкой правкой').length} | ${t.filter((x) => x.send === 'нет').length} | ${exp.length ? `${met}/${exp.length}` : '—'} | ${r.residual.length} | ${r.seconds} с | ${r.errors.length ? r.errors.length : ''} |`);
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
    for (const c of r.verdict?.critical || []) L.push(`- ⛔ Грубая ошибка (${c.set}, касание ${c.n}): ${c.error} — «${c.quote || ''}»`);
    for (const x of r.verdict?.missing || []) L.push(`- 🔎 Не хватает: ${x}`);
    for (const e of r.verdict?.expectations || []) L.push(`- ${e.met === 'да' ? '✅' : e.met === 'частично' ? '🟡' : '❌'} ${e.expectation}${e.comment ? ` — ${e.comment}` : ''}`);
    if (r.residual.length) { L.push('\n**Остались замечания проверок кода:**'); for (const x of r.residual) L.push(`- касание ${x.n}: ${x.fix}`); }
    // Многоуровневая сделка: что Клоузер сделал после каждой дописки.
    for (const st of r.stages || []) {
      const mode = st.plan?.[0]?.path_mode === 'step' ? 'следующий шаг' : 'весь путь';
      L.push(`\n#### Шаг «${st.label}» (сегодня ${st.today}) — ${mode}`);
      if (st.expect?.length) L.push(`_Ожидается: ${st.expect.join('; ')}_`);
      if (st.scores) L.push(`Оценка: ${Object.entries(st.scores).map(([k, v]) => `${k} ${v?.status || v}`).join(', ')}`);
      if (st.soprano) L.push(`СОПРАНО: ${Object.entries(st.soprano).map(([k, v]) => `${k} ${v?.status || v}`).join(', ')}`);
      if (st.soprano_recs?.length) L.push(`Рекомендации СОПРАНО: ${st.soprano_recs.map((x) => `«${String(x).slice(0, 140)}»`).join('; ')}`);
      { const rp = repeatedPhrases(st.touches); if (rp.count) L.push(`Повторы между касаниями: ${rp.count} — ${rp.examples.map((e) => `«${e.phrase}» (${e.touches.join(', ')})`).join('; ')}`); }
      L.push('\n**План:**');
      for (const p of st.plan || []) L.push(`${p.touchpoint_number}. ${p.timing} · ${p.channel} · ${p.last_chance ? 'последний шанс' : p.kind}${p.criterion ? ` · ${String(p.criterion).split(' —')[0]}` : ''} — ${p.goal || ''}`);
      st.touches.forEach((m, i) => { L.push(`\n**${m.touchpoint_number ?? i + 1} · ${m.channel || ''}** _${m.timing || ''}_`); L.push(String(m.body || '').split('\n').map((x) => `> ${x}`).join('\n')); });
      if (!st.touches.length) L.push(`\n_Касания не менялись. Ответ Клоузера:_ ${String(st.chat || '').slice(0, 800)}`);
    }
    // Два набора (владелец 15.11 — режимы пути): до ответа клиента и после (следующий шаг).
    const sets = r.stages?.length ? [{ key: 'before_reply', title: 'Первый ход (до дописок)', plan: r.first_round.plan, touches: r.first_round.touches }, { key: 'after_reply', title: 'Итог (после последней дописки)', plan: r.plan, touches: r.touches }] : r.first_round
      ? [{ key: 'before_reply', title: 'До ответа клиента', plan: r.first_round.plan, touches: r.first_round.touches },
        { key: 'after_reply', title: 'После ответа клиента', plan: r.plan, touches: r.touches }]
      : [{ key: 'before_reply', title: 'Касания', plan: r.plan, touches: r.touches }];
    for (const set of sets) {
      const mode = set.plan?.[0]?.path_mode === 'step' ? 'следующий шаг' : 'весь путь';
      L.push(`\n#### ${set.title} — ${mode}`);
      { const rp = repeatedPhrases(set.touches); L.push(`Повторы между касаниями: ${rp.count ? `${rp.count} — ${rp.examples.map((e) => `«${e.phrase}» (${e.touches.join(', ')})`).join('; ')}` : 'нет'}`); }
      L.push('\n**План:**');
      for (const p of set.plan || []) L.push(`${p.touchpoint_number}. ${p.timing} · ${p.channel} · ${p.last_chance ? 'последний шанс' : p.kind}${p.criterion ? ` · ${String(p.criterion).split(' —')[0]}` : ''} — ${p.goal || ''}`);
      (set.touches || []).forEach((m, i) => {
        const n = Number(m.touchpoint_number ?? i + 1);
        const v = (r.verdict?.touches || []).find((x) => Number(x.n) === n && (x.set || 'before_reply') === set.key)
          || (sets.length === 1 ? (r.verdict?.touches || []).find((x) => Number(x.n) === n) : null);
        L.push(`\n### Касание ${n} · ${m.channel || ''} — ${v ? `**${v.send}**` : ''}`);
        if (m.timing) L.push(`_Когда: ${m.timing}_`);
        if (m.hook?.prep) L.push(`_Перед касанием: ${String(m.hook.prep).replace(/^перед касанием:?\s*/i, '')}_`);
        L.push('');
        L.push(String(m.body || '').split('\n').map((x) => `> ${x}`).join('\n'));
        for (const i2 of v?.issues || []) L.push(`- ⚠️ ${i2.rule || ''}: ${i2.comment || ''}`);
      });
    }
  }
  return L.join('\n');
}

// --rejudge <report.json>: только заново оценить судьёй касания готового прогона (без генерации) —
// чтобы мерить правку правил судьи без колебаний модели (15.11). Цена — только судья (~$0,2).
async function rejudge(file) {
  const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const r of prev.results) {
    if (ONLY && !ONLY.has(r.id)) continue; // пересуд части ситуаций (шаг 5, 20.11)
    const sit = SITUATIONS.find((x) => x.id === r.id);
    if (!sit || (!r.touches?.length && !r.first_round?.touches?.length)) { results.push(r); continue; }
    // Судья 17.11: при пересуде промежуточные ходы не передавались — «650 договорились» (ход 2 экзамена) судья не видел.
    const sets = r.first_round ? { before: r.first_round, after: { touches: r.touches, plan: r.plan }, stages: (r.stages || []).slice(0, -1) } : { before: { touches: r.touches, plan: r.plan } };
    let verdict = null;
    try { verdict = await als.run(sit.id, () => judgeWithCritical(sit, sets, r.diagnostic?.summary)); } catch (e) { r.errors = [...(r.errors || []), `judge: ${e.message}`]; }
    results.push({ ...r, verdict });
    console.log(`← ${r.id} пересужено`);
  }
  fs.writeFileSync(path.join(OUT, 'report.md'), `_Пересуд касаний прогона ${path.basename(path.dirname(file))} (без новой генерации)._\n\n${md(results)}`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ today: process.env.KLOUZER_TODAY, rejudge_of: file, calls, results }, null, 1));
  console.log(`Готово: eval-report/report.md. Цена: $${calls.reduce((a, c) => a + c.cost, 0).toFixed(2)}`);
}

async function main() {
  if (argVal('--rejudge')) return rejudge(argVal('--rejudge'));
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

/**
 * engine/pathMode.js — режим пути: «весь путь» или «следующий шаг» (владелец 15.11).
 *
 * Прогон DeepSeek (16 ситуаций, 15.11): после ответа клиента Клоузер строил путь как для
 * молчащего — 7 касаний до «последнего шанса» через месяц («Булка»: клиент прислал фото,
 * касание 7 — «проект ещё актуален?»). Судья ставил «не по делу».
 *
 * Решение владельца: развилка, по умолчанию выбирает Клоузер.
 *   full — клиент молчит: весь путь сразу, до «последнего шанса».
 *   step — идёт разговор (клиент ответил / ждёт нашего ответа): только следующий шаг —
 *          ответ клиенту и договорённость, без «последнего шанса».
 * Менеджер переключает словами (кнопки на сайте шлют те же слова):
 *   «весь путь» / «клиент молчит» → full; «следующий шаг» → step.
 * Режим хранится в last_diagnostic_output._path_mode (новых колонок в базе нет).
 */

const FULL_RE = /^\s*(покажи\s+|построй\s+)?(весь путь|все касания|полный путь|клиент (снова )?молчит|клиент не отвечает)[.!\s]*$/i;
const STEP_RE = /^\s*(только\s+|покажи\s+)?(следующий шаг|шаг за шагом|пошагово)[.!\s]*$/i;

function modeCommand(text) {
  if (FULL_RE.test(String(text || ''))) return 'full';
  if (STEP_RE.test(String(text || ''))) return 'step';
  return null;
}

// Молчание явно названо менеджером — значит, путь для молчащего клиента.
const SILENCE_RE = /(ответа нет|не отвечает|не отвечают|молчит|молчат|тишина|без ответа|пропал|игнор|не выходит на связь|прочитал и|не бер[её]т трубку|не перезвонил[аи]?|(он|она|они) (всё ещё |пока |ещё )?дума(ет|ют)|не берут трубку|не взял[аи]? трубку|не дозвон|сбрасывает)/i;
// «Имя (дд.мм): текст» — реплика с датой; «Я (…)» / «Менеджер (…)» — наша.
const LINE_RE = /^\s*([А-ЯЁA-Z][^():\n]{0,40}?)\s*\((\d{1,2}[./]\d{1,2})[^)]*\)\s*:/gm;
const OURS_RE = /^(я|менеджер|мы)$/i;

/**
 * Режим по умолчанию для первого сообщения: последняя реплика в переписке — клиента и
 * молчание не названо → идёт разговор, нужен следующий шаг; иначе — весь путь.
 */
function autoMode(text) {
  const t = String(text || '');
  if (!t.trim()) return 'full';
  const speakers = [...t.matchAll(LINE_RE)].map((m) => m[1].trim());
  if (!speakers.length) return 'full';
  const last = speakers[speakers.length - 1];
  // Молчание — только в тексте после последней реплики или в описании ситуации до переписки.
  const tail = t.slice(t.lastIndexOf(`${last} (`));
  const tailAfterLine = tail.split('\n').slice(1).join('\n');
  if (SILENCE_RE.test(tailAfterLine)) return 'full';
  return OURS_RE.test(last) ? 'full' : 'step';
}

/**
 * Режим при перестройке после новых фактов («Котик», 15.11): «он всё равно не отвечает» дважды
 * давал одинаковый «следующий шаг» по кругу. Менеджер сообщает молчание (и не пересказывает
 * ответ клиента) → весь путь до «последнего шанса»; иначе клиент ожил → следующий шаг.
 */
// «не перезвонил» — не разговор (симулятор 16.11 «Дента Плюс»).
const CLIENT_SPOKE_RE = /(?<!не )(ответил|ответила|написал|написала|сказал|сказала|говорит|пишет|прислал|прислала|спросил|спросила|перезвонил|перезвонила)/i;
// Последнее событие решает (правило 79, прогон 15.11 «Fresh Bowl»): «созвонились, сказал
// „подумаю“. С тех пор три дня тишина» — разговор был раньше, сейчас клиент молчит → весь путь.
// Тишина после слов клиента считается, только если названо время после них («с тех пор»,
// «после этого», «уже 3 дня»…), — иначе «Ксения написала: Сергей пока молчит» — это разговор.
const AFTER_RE = /(с тех пор|после (этого|него|неё|звонка|зума|zoom|встречи|созвона|разговора)|дальше|снова|опять|уже (\d+|два|две|три|четыре|пять|шесть|семь|несколько|неделю)|(\d+|два|две|три|четыре|пять|несколько) (дн|дня|дней|недел)|прош[её]л|прошла)/i;
const lastIndex = (re, t) => { let i = -1; const g = new RegExp(re.source, 'gi'); let m; while ((m = g.exec(t))) i = m.index; return i; };
function rebuildMode(managerInput) {
  const t = String(managerInput || '');
  if (!SILENCE_RE.test(t)) return 'step';
  if (!CLIENT_SPOKE_RE.test(t)) return 'full';
  return lastIndex(SILENCE_RE, t) > lastIndex(CLIENT_SPOKE_RE, t) && AFTER_RE.test(t.slice(lastIndex(CLIENT_SPOKE_RE, t))) ? 'full' : 'step';
}

function modeOf(deal) {
  const m = deal?.last_diagnostic_output?._path_mode;
  return m === 'step' ? 'step' : 'full';
}

// «весь путь» / «клиент молчит» / «следующий шаг» (engine/pathMode.js): план пересобирается кодом
// из уже готовой стратегии (без нового вызова модели), затем касания пишутся заново (autoFlow).
function switchPathMode({ deal, baseInput }, mode) {
  const { buildTouchPlan } = require('./touchPlan');
  const diagnostic = { ...(deal.last_diagnostic_output || {}), _path_mode: mode };
  const strategy = { ...deal.last_strategy_output };
  const plan = buildTouchPlan(strategy, baseInput.timeline, baseInput.today, diagnostic.scores,
    { source: baseInput.materials?.source_materials?.text, client: deal.client, daysSilent: deal.days_silent, mode, dealSize: deal.deal_size, soprano: diagnostic.soprano });
  if (plan) strategy.touch_plan = plan;
  return { nextState: 'STRATEGY_SELECTION', output: { diagnostic_output: diagnostic, strategy_output: strategy } };
}

module.exports = { modeCommand, autoMode, rebuildMode, modeOf, switchPathMode, FULL_RE, STEP_RE };

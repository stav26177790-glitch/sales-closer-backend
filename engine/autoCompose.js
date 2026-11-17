/**
 * engine/autoCompose.js — касания составляются, проверяются и дорабатываются
 * САМИ, в одном ходе, без участия менеджера.
 *
 * Было (до 2026-11-13): composer → менеджер «ок» → reviewer → менеджер
 * «дальше» → доработка → «ок» → … и лимит 3 попытки, после которого —
 * «эскалация менеджеру». Живой тест «Зерно 2»: менеджер ничего не правил,
 * а ему пришлось 6 раз нажимать «ок/дальше» и вручную выводить сделку из
 * эскалации — все ошибки находил и исправлял сам Клоузер. Владелец:
 * «Клоузер сам не справляется и ограничивает лимит».
 *
 * Стало: один ход менеджера → цикл
 *   composer → проверки кода (длина, запрещённые фразы, календарь; мгновенно)
 *     → есть ошибки → доработка (без reviewer'а, он дорогой)
 *     → чисто → reviewer + проверки кода (обязательные пункты и т.д.)
 *       → ОДОБРЕНО → готово
 *       → иначе → доработка по замечаниям
 * до AUTO_COMPOSER_ROUNDS вызовов composer и AUTO_REVIEWS вызовов reviewer.
 * Менеджер видит готовые касания: «проверено» или «что проверка не приняла».
 */
const { CONFIG } = require('./config');
const { callAgentSafe, runComposer, keepApprovedTouches } = require('./pipeline');
const { applyPhraseCheck } = require('./phraseCheck');
const { applyHookCheck } = require('./hookCheck');
const { applyPlanChecks } = require('./planChecks');
const { applyMustIncludeCheck } = require('./mustInclude');
const { applyScheduleCheck } = require('./scheduleCheck');
const { pinToPlan } = require('./touchPlan');
const { setStage } = require('./progress');

// Канал касания → ключ лимита длины («Звонок», «call», «WhatsApp»…).
function channelKey(channel) {
  const c = String(channel || '').trim().toLowerCase();
  if (/whats|ватс|вотс/.test(c)) return 'whatsapp';
  if (/telegram|телеграм|^tg$/.test(c)) return 'telegram';
  if (/mail|почт|письм/.test(c)) return 'email';
  if (/voice|голосов|кружок/.test(c)) return 'voice';
  if (/call|phone|звон|скрипт/.test(c)) return 'call_script';
  return c;
}

// Переписка (все сообщения менеджера) + шапка сделки — здесь ищем цитату повода.
const sourceTextOf = (baseInput) => [baseInput?.materials?.source_materials?.text, baseInput?.deal?.client, baseInput?.deal?.product].filter(Boolean).join('\n');

const messagesOf = (out) => out?.messages || out?.composer_output?.messages || [];

// Проверки кода без модели: длина, запрещённые фразы, календарь.
// Вердикт в форме reviewer'а; касания без замечаний — ОДОБРЕНО (чтобы при
// доработке их не переписывали).
function isForwardMaterial(step, m) {
  const t = [step?.recipient, step?.goal, step?.key_message, m?.recipient].filter(Boolean).join(' ');
  return /пересыл|переслать|для передачи/i.test(t);
}

function codeChecks(composerOutput, timeline, plan, sourceText, sentHistory = []) {
  const msgs = messagesOf(composerOutput);
  const r = {
    verdict: 'ОДОБРЕНО',
    source: 'code',
    messages_reviewed: msgs.map((m, i) => ({ touchpoint_number: Number(m?.touchpoint_number ?? i + 1), verdict: 'ОДОБРЕНО' }))
  };
  // Каждое касание плана должно быть написано (writer иногда пропускает).
  if (Array.isArray(plan)) {
    const have = new Set(msgs.map((m, i) => Number(m?.touchpoint_number ?? i + 1)));
    for (const p of plan) {
      if (have.has(p.touchpoint_number)) continue;
      r.messages_reviewed.push({ touchpoint_number: p.touchpoint_number, verdict: 'НА ДОРАБОТКУ', code_checked: true, failed_criteria: ['missing_touch'],
        fix_instructions: `Касание ${p.touchpoint_number} из плана не написано (${p.channel}, ${p.timing}${p.goal ? `: ${p.goal}` : ''}) — написать.` });
      r.verdict = 'НА ДОРАБОТКУ';
    }
  }
  const planStep = (m, i) => (Array.isArray(plan) ? plan.find((p) => p.touchpoint_number === Number(m?.touchpoint_number ?? i + 1)) : null);
  msgs.forEach((m, i) => {
    // Материал для пересылки ЛПР (живой «Зерно 5»): это не реплика в чате, а готовый
    // текст-«одна страница» — лимит как у письма, иначе проверка режет суть стратегии.
    const max = isForwardMaterial(planStep(m, i), m) ? CONFIG.MAX_MESSAGE_LENGTH.email : CONFIG.MAX_MESSAGE_LENGTH[channelKey(m?.channel)];
    const len = String(m?.body || '').length;
    // Владелец 17.11 («превышение небольшое — сам посмотри и прими решение»): до 10% сверх лимита не гоняем
    // круг правок — сценарий звонка с развилками важнее нескольких лишних знаков.
    if (max && len > Math.round(max * 1.1)) {
      const x = r.messages_reviewed[i];
      x.verdict = 'НА ДОРАБОТКУ';
      x.code_checked = true;
      x.failed_criteria = ['channel_fit'];
      x.fix_instructions = `Сократить: ${len} из ${max} символов для этого канала. Обязательные пункты не выбрасывать — перенести в другое касание.`;
      r.verdict = 'НА ДОРАБОТКУ';
    }
  });
  // Кружок — речь менеджера в камеру, а не текст с вложениями (живой «Зерно 5»:
  // «[фото похожей работы — если есть]» в кружке, проверка не приняла, менеджеру — недоделка).
  msgs.forEach((m, i) => {
    if (!/кружок|видео/i.test(String(m?.channel || ''))) return;
    if (!/\[(фото|ссылк|вложен|скрин|прикреп|картин)/i.test(String(m?.body || ''))) return;
    const x = r.messages_reviewed[i];
    x.verdict = 'НА ДОРАБОТКУ';
    x.code_checked = true;
    x.failed_criteria = [...new Set([...(x.failed_criteria || []), 'circle_format'])];
    x.fix_instructions = [x.fix_instructions, 'Кружок — это речь менеджера в камеру на 20–40 секунд: живые фразы от первого лица, без вложений в квадратных скобках и без списков. Ничего не «показывать» в кадре и не рассказывать о других работах — только повод, участие и один шаг; сроки — одной фразой.'].filter(Boolean).join(' ');
    r.verdict = 'НА ДОРАБОТКУ';
  });
  // Воронка владельца: касания после КП чередуются экспертное / эмпатичное.
  // Условные ветки («только если…») — не следующий шаг цепочки, их пропускаем.
  // Если есть план (engine/touchPlan.js) — чередование уже выстроено кодом и тип
  // касания приколочен pinToPlan; вторая проверка тут только мешала. Живой «Зерно 5»
  // (13.11, вечер): «звонок эмп → сообщение эксп сразу после → кружок эмп» эта проверка
  // считала двумя эмпатичными подряд → редактор не запускался, writer переписывал всё
  // 3 раза впустую (+3 минуты), в итоге «Проверка приняла не всё».
  let prev = null;
  const hasPlan = Array.isArray(plan) && plan.length > 0;
  msgs.forEach((m, i) => {
    if (hasPlan) return;
    if (/только если/i.test(String(m?.timing || ''))) return;
    // «Сразу после звонка/кружка» тому же контакту — уходит наверняка: задаёт тип для следующего шага.
    if (/сразу после|в тот же день после|после звонка/i.test(String(m?.timing || ''))) {
      const kk = String(m?.kind || (/кружок|видео|голосов|voice/i.test(String(m?.channel || '')) ? 'эмпатичное' : 'экспертное')).toLowerCase();
      prev = { kind: /экспер/.test(kk) ? 'экспертное' : 'эмпатичное', n: r.messages_reviewed[i].touchpoint_number };
      return;
    }
    // composer не всегда ставит kind (живой тест 2026-11-13). По воронке владельца
    // эмпатичные касания — короткие видео (кружки), поэтому без kind: кружок/видео/
    // голосовое — эмпатичное, остальное (текст, звонок) — экспертное.
    const kind = String(m?.kind || (/кружок|видео|голосов|voice/i.test(String(m?.channel || '')) ? 'эмпатичное' : 'экспертное')).toLowerCase();
    const k = /экспер/.test(kind) ? 'экспертное' : /эмпат/.test(kind) ? 'эмпатичное' : null;
    if (k && prev && k === prev.kind) {
      const x = r.messages_reviewed[i];
      x.verdict = 'НА ДОРАБОТКУ';
      x.code_checked = true;
      x.failed_criteria = [...new Set([...(x.failed_criteria || []), 'alternation'])];
      x.fix_instructions = [x.fix_instructions, `Два ${k === 'экспертное' ? 'экспертных' : 'эмпатичных'} касания подряд (${prev.n} и ${x.touchpoint_number}) — по воронке их чередуем: сделать это касание ${k === 'экспертное' ? 'эмпатичным (короткое видео-кружок)' : 'экспертным'} или поменять порядок.`].filter(Boolean).join(' ');
      r.verdict = 'НА ДОРАБОТКУ';
    }
    if (k) prev = { kind: k, n: r.messages_reviewed[i].touchpoint_number };
  });
  applyPhraseCheck(r, msgs, sourceText);
  applyScheduleCheck(r, msgs, timeline);
  // Повод касания (владелец 14.11) — только для касаний по плану (writer);
  // старые сделки без плана пишет composer, у него повода нет.
  if (hasPlan) applyHookCheck(r, msgs, sourceText);
  // «Последний шанс» — только последним; альтернатива подешевле — с риском / отходом от ТЗ.
  applyPlanChecks(r, msgs, hasPlan ? plan : null, sourceText, sentHistory);
  return r;
}

// Точечная доработка: editor получает только касания с замечаниями и сами
// замечания, меняет только их. Возвращает новый composer_output или null
// (тогда — полная переработка composer'ом).
async function runEditor(baseInput, deal, composerOutput, verdict) {
  const msgs = messagesOf(composerOutput);
  const rejected = (reviewedOf(verdict)?.messages_reviewed || []).filter((m) => m?.verdict && m.verdict !== 'ОДОБРЕНО');
  const nums = new Set(rejected.map((m) => Number(m.touchpoint_number)));
  const numOf = (m, i) => Number(m?.touchpoint_number ?? i + 1);
  const touchesToFix = msgs
    .map((m, i) => ({ m, n: numOf(m, i) }))
    .filter(({ n }) => nums.has(n))
    .map(({ m, n }) => {
      const r = rejected.find((x) => Number(x.touchpoint_number) === n);
      const planned = (deal.last_strategy_output?.touch_plan || []).find((p) => p.touchpoint_number === n);
      return { touch: m, fix_instructions: r?.fix_instructions || (r?.failed_criteria || []).join(', '), ...(planned ? { plan: { facts: planned.facts, must_include: planned.must_include, value: planned.value } } : {}) };
    });
  if (!touchesToFix.length) return null;
  // Чередование экспертное/эмпатичное — это структура цепочки (вставить кружок,
  // переставить касания), точечной правкой не решается → полная переработка composer.
  if (rejected.some((m) => (m.failed_criteria || []).some((c) => c === 'alternation' || c === 'missing_touch'))) return null;
  const t = baseInput.timeline;
  const result = await callAgentSafe('editor', {
    touches_to_fix: touchesToFix,
    other_touches: msgs.filter((m, i) => !nums.has(numOf(m, i))),
    must_include: deal.last_strategy_output?.must_include || [],
    facts: {
      today: baseInput.today,
      timeline: t ? { summary: t.summary, if_start_today: t.if_start_today, ready_if_start_on: t.ready_if_start_on, temp_banner: t.temp_banner, latest_start_date: t.latest_start_date } : null,
      working_days_ahead: baseInput.working_days_ahead
    },
    deal: baseInput.deal,
    // Для повода касания: цитата клиента берётся дословно отсюда.
    source_materials: baseInput.materials?.source_materials?.text || ''
  }, 6000);
  const fixed = result?.editor_output?.messages || result?.composer_output?.messages || result?.messages;
  if (!Array.isArray(fixed) || !fixed.length) return null;
  // Меняем только касания с замечаниями — остальные остаются дословно.
  const messages = msgs.map((m, i) => {
    const n = numOf(m, i);
    if (!nums.has(n)) return m;
    const f = fixed.find((x) => Number(x?.touchpoint_number) === n);
    return f && f.body ? { ...m, ...f, touchpoint_number: m.touchpoint_number ?? n } : m;
  });
  const plan = deal.last_strategy_output?.touch_plan;
  return Array.isArray(plan) ? pinToPlan({ ...composerOutput, messages }, plan) : { ...composerOutput, messages };
}

// «Совет» reviewer'а — касание можно отправлять: не переделываем и не
// показываем менеджеру как «не принято» (живой тест 2026-11-13: проверка
// возвращала касания с собственными сомнениями «это не проблема, но…»).
// Правила, которые проверяет КОД (длина, формат кружка, материал для пересылки,
// даты на день отправки), — у reviewer'а по ним только совет. Иначе он спорит с
// планом и гоняет круги (живой «Зерно 5», 13.11 вечер: «при старте сегодня — 11–14
// декабря» в касании 23 ноября — верно по расчёту, а reviewer вернул как ошибку;
// кружок «не похож на речь» по вкусу — круг за кругом).
function applyCodeOwnership(reviewerOutput, msgs, plan) {
  const r = reviewedOf(reviewerOutput);
  if (!r || !Array.isArray(r.messages_reviewed)) return reviewerOutput;
  for (const m of r.messages_reviewed) {
    if (!m?.verdict || m.verdict === 'ОДОБРЕНО' || m.code_checked) continue;
    const n = Number(m.touchpoint_number);
    const msg = msgs.find((x, i) => Number(x?.touchpoint_number ?? i + 1) === n);
    const step = Array.isArray(plan) ? plan.find((p) => p.touchpoint_number === n) : null;
    if (!msg) continue;
    let crit = Array.isArray(m.failed_criteria) ? [...m.failed_criteria] : [];
    const owned = new Set();
    if (/кружок|видео/i.test(String(msg.channel || '')) || isForwardMaterial(step, msg)) owned.add('channel_fit');
    const ready = step?.facts?.permanent_ready_if_start_that_day;
    if (ready) {
      const nums = (ready.match(/\d{1,2}/g) || []).slice(0, 2);
      const body = String(msg.body || '');
      if (nums.length && nums.every((d) => body.includes(d)) && /сегодня|старт|готов/i.test(String(m.fix_instructions || ''))) owned.add('data_honesty');
    }
    if (!owned.size) continue;
    const left = crit.filter((c) => !owned.has(c));
    if (crit.length && !left.length) {
      m.severity = 'совет';
      m.code_owned = [...owned];
    }
  }
  return reviewerOutput;
}

function applySeverity(reviewerOutput) {
  const r = reviewedOf(reviewerOutput);
  if (!r || !Array.isArray(r.messages_reviewed)) return reviewerOutput;
  let anyRejected = false;
  for (const m of r.messages_reviewed) {
    if (m?.verdict && m.verdict !== 'ОДОБРЕНО' && /совет/i.test(String(m.severity || '')) && !m.code_checked) {
      m.advice = m.fix_instructions;
      m.verdict = 'ОДОБРЕНО';
      m.failed_criteria = [];
      m.fix_instructions = '';
    }
    if (m?.verdict && m.verdict !== 'ОДОБРЕНО') anyRejected = true;
  }
  if (!anyRejected && r.messages_reviewed.length && r.verdict !== 'ПЕРЕСБОРКА') r.verdict = 'ОДОБРЕНО';
  return reviewerOutput;
}

function reviewedOf(r) {
  return r?.messages_reviewed ? r : r?.reviewer_output;
}

function verdictOf(r) {
  return reviewedOf(r)?.verdict;
}

/**
 * @param baseInput  вход агентов
 * @param deal       сделка (last_* поля — текущее состояние)
 * @param opts.feedback        фидбэк первой попытки (правка менеджера / прошлый вердикт) или undefined
 * @param opts.channelHistory  для первой попытки новой сессии
 * @returns { composer_output, reviewer_output, approved, rounds, reviews }
 */
async function composeUntilReady(baseInput, deal, opts = {}) {
  return criticalGate(await composeCore(baseInput, deal, opts), baseInput, deal);
}
async function composeCore(baseInput, deal, { feedback, channelHistory, startWith } = {}) {
  const stage = (text) => setStage(deal.id, text);
  let cur = { ...deal };
  let fb = feedback;
  let composerOutput = deal.last_composer_output;
  // Что ушло клиенту в прошлых ходах (касание 1 каждого хода) — не повторять (владелец 16.11).
  const sentHistory = Array.isArray(deal.last_composer_output?._sent_history) ? deal.last_composer_output._sent_history : [];
  let reviewerOutput = null;
  let rounds = 0;
  let reviews = 0;
  const timeline = baseInput.timeline;
  // Ход цикла — для менеджера и для разбора (что делал Клоузер за этот ход).
  const trace = [];
  const bad = (r) => (reviewedOf(r)?.messages_reviewed || []).filter((m) => m?.verdict && m.verdict !== 'ОДОБРЕНО').map((m) => m.touchpoint_number).join(',');

  // startWith — уже готовые касания (сделки, начатые до этой версии): сначала проверить, не переписывая.
  let skipCompose = !!startWith;
  let reviewOnly = null;
  // Владелец 17.11 (п. 3 «как сделать 10»): касание, которое редактор не исправил дважды, — переписать заново.
  const failCount = {};
  if (startWith) composerOutput = startWith;
  while (rounds < CONFIG.AUTO_COMPOSER_ROUNDS) {
    // Доработка по замечаниям проверки — сначала точечно редактором.
    const badNow = (reviewedOf(fb)?.messages_reviewed || []).filter((m) => m?.verdict && m.verdict !== 'ОДОБРЕНО').map((m) => Number(m.touchpoint_number));
    const stuck = badNow.length && badNow.every((x) => (failCount[x] || 0) >= 2);
    if (stuck) trace.push(`переписываю заново ${badNow.join(',')}`);
    const byVerdict = !skipCompose && !stuck && fb && cur.last_reviewer_output && fb === cur.last_reviewer_output;
    if (byVerdict) {
      stage(`Редактор правит касания ${bad(fb) || ''}…`);
      const edited = await runEditor(baseInput, deal, cur.last_composer_output, fb);
      if (edited) {
        rounds++;
        composerOutput = edited;
        skipCompose = true;
        trace.push('редактор');
        // Повторная проверка — только тех касаний, что правил редактор (время: живой
        // «Зерно 6» — reviewer 65 с на круг; остальные касания уже одобрены).
        if (reviews > 0) {
          const nums = (reviewedOf(fb)?.messages_reviewed || []).filter((m) => m?.verdict && m.verdict !== 'ОДОБРЕНО').map((m) => Number(m.touchpoint_number));
          reviewOnly = [...new Set([...(reviewOnly || []), ...nums])].sort((a, b) => a - b);
        }
      } else {
        trace.push('редактор не смог');
      }
    }
    if (!skipCompose) {
      stage(rounds === 0 && !fb ? 'Пишу касания по плану…' : 'Переписываю касания с учётом замечаний…');
      const fresh = await runComposer(baseInput, cur, {
        feedback: fb,
        channelHistory: rounds === 0 ? channelHistory : undefined,
        iteration: rounds + 1
      });
      rounds++;
      reviewOnly = null; // переписано целиком — проверять всё
      trace.push(rounds === 1 && !fb ? 'составил' : 'переписал');
      // Касания, одобренные на прошлом круге, возвращаем дословно.
      composerOutput = fb && cur.last_reviewer_output && fb === cur.last_reviewer_output
        ? keepApprovedTouches(fresh, cur.last_composer_output, cur.last_reviewer_output).output
        : fresh;
    }
    skipCompose = false;
    if (sentHistory.length && composerOutput && typeof composerOutput === 'object') composerOutput._sent_history = sentHistory;
    cur = { ...cur, last_composer_output: composerOutput };

    if (!messagesOf(composerOutput).length) {
      // Ответ composer не прочитан — показываем как есть, крутить дальше бессмысленно.
      return { composer_output: composerOutput, reviewer_output: null, approved: false, rounds, reviews };
    }

    const code = codeChecks(composerOutput, timeline, deal.last_strategy_output?.touch_plan, sourceTextOf(baseInput), sentHistory);
    if (code.verdict !== 'ОДОБРЕНО') { trace.push(`код вернул ${bad(code)}`); for (const m of code.messages_reviewed) if (m.verdict !== 'ОДОБРЕНО') failCount[m.touchpoint_number] = (failCount[m.touchpoint_number] || 0) + 1; }
    if (code.verdict !== 'ОДОБРЕНО' && rounds < CONFIG.AUTO_COMPOSER_ROUNDS) {
      console.log(`[autoCompose] круг ${rounds}: проверки кода вернули касания ${code.messages_reviewed.filter((m) => m.verdict !== 'ОДОБРЕНО').map((m) => m.touchpoint_number).join(', ')}`);
      reviewerOutput = code;
      fb = code;
      cur = { ...cur, last_reviewer_output: code };
      continue;
    }

    if (reviews >= CONFIG.AUTO_REVIEWS) break; // защита: вердикт — последняя проверка reviewer'а
    stage(reviews === 0 ? 'Проверяю касания: тон, выгода, давление, обязательные пункты…' : 'Проверяю касания ещё раз…');
    // Лимит 12000: ответ reviewer'а самый объёмный (14 критериев на касание).
    const result = await callAgentSafe('reviewer', {
      ...baseInput,
      diagnostic_output: deal.last_diagnostic_output,
      strategy_output: deal.last_strategy_output,
      composer_output: composerOutput,
      ...(reviews > 0 && reviewOnly && reviewOnly.length ? { review_only: reviewOnly } : {})
    }, 12000);
    reviews++;
    reviewerOutput = result?.reviewer_output || result;
    const traceAt = trace.length;
    const msgs = messagesOf(composerOutput);
    applyCodeOwnership(reviewerOutput, msgs, deal.last_strategy_output?.touch_plan);
    applySeverity(reviewerOutput);
    applyPhraseCheck(reviewerOutput, msgs, sourceTextOf(baseInput));
    applyMustIncludeCheck(reviewerOutput, deal.last_strategy_output?.must_include, msgs.length);
    applyScheduleCheck(reviewerOutput, msgs, timeline);
    trace.splice(traceAt, 0, verdictOf(reviewerOutput) === 'ОДОБРЕНО' ? 'проверка приняла' : `проверка вернула ${bad(reviewerOutput) || '(вердикт не прочитан)'}`);
    if (verdictOf(reviewerOutput) === 'ОДОБРЕНО') {
      return done(composerOutput, reviewerOutput, true, rounds, reviews, { trace });
    }
    console.log(`[autoCompose] круг ${rounds}: проверка не приняла касания`);
    if (reviews >= CONFIG.AUTO_REVIEWS) {
      // Проверок больше не делаем (время) — последние замечания вносит editor.
      stage(`Редактор вносит последние правки в касания ${bad(reviewerOutput)}…`);
      const edited = await runEditor(baseInput, deal, composerOutput, reviewerOutput);
      if (edited) {
        rounds++;
        trace.push('редактор');
        const code2 = codeChecks(edited, timeline, deal.last_strategy_output?.touch_plan, sourceTextOf(baseInput));
        if (code2.verdict === 'ОДОБРЕНО') {
          const fixedNums = (reviewedOf(reviewerOutput)?.messages_reviewed || []).filter((m) => m?.verdict && m.verdict !== 'ОДОБРЕНО').map((m) => m.touchpoint_number);
          return done(edited, reviewerOutput, false, rounds, reviews, { fixedAfterReview: fixedNums, trace });
        }
        trace.push(`код после редактора вернул ${bad(code2)}`);
        // Замечания кода механические (длина, формат) — ещё одна точечная правка.
        const edited2 = await runEditor(baseInput, deal, edited, code2);
        if (edited2) {
          rounds++;
          trace.push('редактор');
          const code3 = codeChecks(edited2, timeline, deal.last_strategy_output?.touch_plan, sourceTextOf(baseInput));
          if (code3.verdict === 'ОДОБРЕНО') {
            const fixedNums = (reviewedOf(reviewerOutput)?.messages_reviewed || []).filter((m) => m?.verdict && m.verdict !== 'ОДОБРЕНО').map((m) => m.touchpoint_number);
            return done(edited2, reviewerOutput, false, rounds, reviews, { fixedAfterReview: fixedNums, trace });
          }
          trace.push(`код после редактора вернул ${bad(code3)}`);
        }
      } else {
        trace.push('редактор не смог');
      }
      break;
    }
    fb = reviewerOutput;
    cur = { ...cur, last_reviewer_output: reviewerOutput };
  }
  const ok = verdictOf(reviewerOutput) === 'ОДОБРЕНО';
  // Не довёл до конца — менеджеру это не перекладываем; сделка помечается для разбора.
  if (!ok) console.warn(`[autoCompose] needs_review: ${deal?.client || deal?.id || ''} — касания не прошли проверку (${trace.join(' → ')})`);
  return done(composerOutput, reviewerOutput, ok, rounds, reviews, { trace, ...(ok ? {} : { needs_review: true }) });
}


// ---------- Финальная проверка грубых ошибок (владелец 17.11: «как сделать, чтобы оценки были 10») ----------
// Та же проверка, что у судьи симулятора (agents/critic_agent.md, 9 грубых ошибок): после всех кругов — ещё один
// короткий вызов. Нашёл — редактор правит эти касания; не помогло — касания ПЕРЕПИСЫВАЮТСЯ writer'ом заново
// (не латаем по кругу). Голос и род менеджера считает код и даёт готовыми; ложные «обещание к открытию» на честной
// дате и «деньги письменно» при недоступном голосе код отсеивает.
const { voiceBlocked } = require('./voice');
const { managerGender } = require('./planChecks');
function sourceTextForCritic(baseInput) { return sourceTextOf(baseInput); }
async function runCritic(baseInput, deal, composerOutput, onlyNums) {
  const plan = deal.last_strategy_output?.touch_plan || [];
  const src = sourceTextForCritic(baseInput);
  const kp = src.match(/КП[^.\n]{0,15}?:?\s*(\d{2,3}(?:[  ]\d{3}))\s*₽/i);
  const ask = src.match(/сделаете (?:на |за )?(\d{2,3})(?:[  ]?(?:000|тыс))?/i);
  const g = managerGender(src);
  const touches = messagesOf(composerOutput)
    .map((m, i) => ({ m, n: Number(m?.touchpoint_number ?? i + 1) }))
    .filter(({ n }) => !onlyNums || onlyNums.includes(n))
    .map(({ m, n }) => {
      const p = plan.find((q) => q.touchpoint_number === n);
      return { n, channel: m.channel, body: m.body, ...(p?.facts?.status_on_send_day ? { srok_na_den_otpravki: `${p.facts.status_on_send_day}; готово при старте в день отправки: ${p.facts.permanent_ready_if_start_that_day}` } : {}) };
    });
  if (!touches.length) return [];
  let out;
  try {
    out = await callAgentSafe('critic', {
      today: baseInput.today, deal: baseInput.deal, conversation: src, kp_price: kp ? kp[1] : null, client_price_ask: ask ? ask[1] : null,
      voice_available_now: !voiceBlocked(src), manager_gender: g === 'f' ? 'женщина' : g === 'm' ? 'мужчина' : 'неизвестно', touches
    }, 3000);
  } catch (e) { console.warn(`[critic] ошибка: ${e.message}`); return []; }
  const list = Array.isArray(out?.critical) ? out.critical : [];
  const { keepCritical } = require('./criticFilters');
  return list.filter((c) => keepCritical(c, { source: src, status: plan.find((q) => q.touchpoint_number === Number(c.n))?.facts?.status_on_send_day, channel: touches.find((x) => x.n === Number(c.n))?.channel }));
}
function criticVerdict(composerOutput, list) {
  const msgs = messagesOf(composerOutput);
  const by = new Map();
  for (const c of list) { const n = Number(c.n); by.set(n, [...(by.get(n) || []), c]); }
  return {
    verdict: by.size ? 'НА ДОРАБОТКУ' : 'ОДОБРЕНО', source: 'critic',
    messages_reviewed: msgs.map((m, i) => {
      const n = Number(m?.touchpoint_number ?? i + 1);
      const cs = by.get(n);
      return cs ? { touchpoint_number: n, verdict: 'НА ДОРАБОТКУ', code_checked: true, failed_criteria: ['critical'],
        fix_instructions: cs.map((c) => `Грубая ошибка — ${c.error}: «${c.quote || ''}». ${c.fix || ''}`).join(' ') } : { touchpoint_number: n, verdict: 'ОДОБРЕНО' };
    })
  };
}
async function criticalGate(result, baseInput, deal) {
  if (!CONFIG.CRITIC || !result?.composer_output || !messagesOf(result.composer_output).length) return result;
  const stage = (text) => setStage(deal.id, text);
  const timeline = baseInput.timeline;
  const plan = deal.last_strategy_output?.touch_plan;
  const src = sourceTextOf(baseInput);
  const mark = (out, extra) => ({ ...result, composer_output: { ...out, _check: { ...(out._check || result.composer_output._check || {}), ...extra } } });
  // Шероховатость 2 (17.11): касания, оставшиеся с замечаниями проверок кода после всех кругов, тоже идут через
  // «редактор → переписать заново», а не уходят к менеджеру как есть. Структурные (пропущено касание, чередование)
  // — нет: их решает план, не текст.
  const codeLeft = (o) => (codeChecks(o, timeline, plan, src).messages_reviewed || [])
    .filter((m) => m.verdict !== 'ОДОБРЕНО' && !(m.failed_criteria || []).some((c) => c === 'missing_touch' || c === 'alternation'));
  const verdictOf2 = (o, crit, code) => {
    const v = criticVerdict(o, crit);
    for (const c of code) {
      const m = v.messages_reviewed.find((x) => Number(x.touchpoint_number) === Number(c.touchpoint_number));
      if (!m) continue;
      m.verdict = 'НА ДОРАБОТКУ'; m.code_checked = true;
      m.failed_criteria = [...new Set([...(m.failed_criteria || []), ...(c.failed_criteria || ['code'])])];
      m.fix_instructions = [m.fix_instructions, c.fix_instructions].filter(Boolean).join(' ');
      v.verdict = 'НА ДОРАБОТКУ';
    }
    return v;
  };
  const numsOf = (crit, code) => [...new Set([...crit.map((c) => Number(c.n)), ...code.map((c) => Number(c.touchpoint_number))])];
  stage('Финальная проверка грубых ошибок…');
  let crit = await runCritic(baseInput, deal, result.composer_output);
  let code = codeLeft(result.composer_output);
  if (!crit.length && !code.length) return mark(result.composer_output, { critic: 'чисто' });
  let best = result.composer_output;
  const score = (c1, c2) => c1.length * 3 + c2.length; // грубая ошибка весит больше замечания кода
  let bestScore = score(crit, code);
  const nums0 = numsOf(crit, code);
  console.log(`[critic] касания ${nums0.join(', ')}: грубых ошибок ${crit.length}, замечаний кода ${code.length}`);
  const tryCandidate = async (cand, nums, label) => {
    if (!cand || !messagesOf(cand).length) return null;
    const c1 = await runCritic(baseInput, deal, cand, nums);
    const c2 = codeLeft(cand).filter((m) => nums.includes(Number(m.touchpoint_number)));
    const sc = score(c1, c2);
    if (sc < bestScore) { best = cand; bestScore = sc; crit = c1; code = c2; }
    return sc === 0 ? label : null;
  };
  // 1) точечно — редактор
  stage(`Исправляю касания ${nums0.join(', ')}…`);
  const edited = await runEditor(baseInput, { ...deal, last_composer_output: best }, best, verdictOf2(best, crit, code));
  const ok1 = await tryCandidate(edited, nums0, `исправлено редактором: ${nums0.join(', ')}`);
  if (ok1) return mark(best, { critic: ok1 });
  // 2) не помогло — переписать эти касания заново (не латать по кругу)
  const nums1 = numsOf(crit, code);
  stage(`Переписываю касания ${nums1.join(', ')} заново…`);
  const v2 = verdictOf2(best, crit, code);
  try {
    const fresh = await runComposer(baseInput, { ...deal, last_composer_output: best, last_reviewer_output: v2 }, { feedback: v2, iteration: 9 });
    const merged = keepApprovedTouches(fresh, best, v2).output;
    const ok2 = await tryCandidate(merged, nums1, 'переписано заново');
    if (ok2) return mark(best, { critic: ok2 });
  } catch (e) { console.warn(`[critic] переписать не удалось: ${e.message}`); }
  if (!crit.length && !code.length) return mark(best, { critic: 'исправлено' });
  console.warn(`[critic] needs_review: ${deal?.client || deal?.id || ''} — осталось: ${[...crit.map((c) => `${c.n}: ${c.error}`), ...code.map((c) => `${c.touchpoint_number}: код`)].join('; ')}`);
  return mark(best, { critic: 'осталось', critic_left: crit, code_left: code.map((c) => ({ n: c.touchpoint_number, fix: c.fix_instructions })), needs_review: true });
}

// Касания помечаются как прошедшие цикл проверки: «ок» менеджера на них —
// это принятие итога, а не запуск проверки.
function done(composerOutput, reviewerOutput, approved, rounds, reviews, extra = {}) {
  const out = composerOutput && typeof composerOutput === 'object'
    ? { ...composerOutput, _check: { approved, rounds, reviews, ...extra } }
    : composerOutput;
  return { composer_output: out, reviewer_output: reviewerOutput, approved, rounds, reviews };
}

module.exports = { runCritic, criticVerdict, composeUntilReady, codeChecks, channelKey, messagesOf, applySeverity, applyCodeOwnership, isForwardMaterial };

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
const { applyMustIncludeCheck } = require('./mustInclude');
const { applyScheduleCheck } = require('./scheduleCheck');
const { pinToPlan } = require('./touchPlan');

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

const messagesOf = (out) => out?.messages || out?.composer_output?.messages || [];

// Проверки кода без модели: длина, запрещённые фразы, календарь.
// Вердикт в форме reviewer'а; касания без замечаний — ОДОБРЕНО (чтобы при
// доработке их не переписывали).
function codeChecks(composerOutput, timeline, plan) {
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
  msgs.forEach((m, i) => {
    const max = CONFIG.MAX_MESSAGE_LENGTH[channelKey(m?.channel)];
    const len = String(m?.body || '').length;
    if (max && len > max) {
      const x = r.messages_reviewed[i];
      x.verdict = 'НА ДОРАБОТКУ';
      x.code_checked = true;
      x.failed_criteria = ['channel_fit'];
      x.fix_instructions = `Сократить: ${len} из ${max} символов для этого канала. Обязательные пункты не выбрасывать — перенести в другое касание.`;
      r.verdict = 'НА ДОРАБОТКУ';
    }
  });
  // Воронка владельца: касания после КП чередуются экспертное / эмпатичное.
  // Условные ветки («только если…») — не следующий шаг цепочки, их пропускаем.
  let prev = null;
  msgs.forEach((m, i) => {
    if (/только если/i.test(String(m?.timing || ''))) return;
    // «Сразу после звонка/кружка» — продолжение того же касания (текст вдогонку), не новый шаг.
    if (/сразу после|в тот же день после|после звонка/i.test(String(m?.timing || ''))) return;
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
  applyPhraseCheck(r, msgs);
  applyScheduleCheck(r, msgs, timeline);
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
    deal: baseInput.deal
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
async function composeUntilReady(baseInput, deal, { feedback, channelHistory, startWith } = {}) {
  let cur = { ...deal };
  let fb = feedback;
  let composerOutput = deal.last_composer_output;
  let reviewerOutput = null;
  let rounds = 0;
  let reviews = 0;
  const timeline = baseInput.timeline;
  // Ход цикла — для менеджера и для разбора (что делал Клоузер за этот ход).
  const trace = [];
  const bad = (r) => (reviewedOf(r)?.messages_reviewed || []).filter((m) => m?.verdict && m.verdict !== 'ОДОБРЕНО').map((m) => m.touchpoint_number).join(',');

  // startWith — уже готовые касания (сделки, начатые до этой версии): сначала проверить, не переписывая.
  let skipCompose = !!startWith;
  if (startWith) composerOutput = startWith;
  while (rounds < CONFIG.AUTO_COMPOSER_ROUNDS) {
    // Доработка по замечаниям проверки — сначала точечно редактором.
    const byVerdict = !skipCompose && fb && cur.last_reviewer_output && fb === cur.last_reviewer_output;
    if (byVerdict) {
      const edited = await runEditor(baseInput, deal, cur.last_composer_output, fb);
      if (edited) {
        rounds++;
        composerOutput = edited;
        skipCompose = true;
        trace.push('редактор');
      } else {
        trace.push('редактор не смог');
      }
    }
    if (!skipCompose) {
      const fresh = await runComposer(baseInput, cur, {
        feedback: fb,
        channelHistory: rounds === 0 ? channelHistory : undefined,
        iteration: rounds + 1
      });
      rounds++;
      trace.push(rounds === 1 && !fb ? 'составил' : 'переписал');
      // Касания, одобренные на прошлом круге, возвращаем дословно.
      composerOutput = fb && cur.last_reviewer_output && fb === cur.last_reviewer_output
        ? keepApprovedTouches(fresh, cur.last_composer_output, cur.last_reviewer_output).output
        : fresh;
    }
    skipCompose = false;
    cur = { ...cur, last_composer_output: composerOutput };

    if (!messagesOf(composerOutput).length) {
      // Ответ composer не прочитан — показываем как есть, крутить дальше бессмысленно.
      return { composer_output: composerOutput, reviewer_output: null, approved: false, rounds, reviews };
    }

    const code = codeChecks(composerOutput, timeline, deal.last_strategy_output?.touch_plan);
    if (code.verdict !== 'ОДОБРЕНО') trace.push(`код вернул ${bad(code)}`);
    if (code.verdict !== 'ОДОБРЕНО' && rounds < CONFIG.AUTO_COMPOSER_ROUNDS) {
      console.log(`[autoCompose] круг ${rounds}: проверки кода вернули касания ${code.messages_reviewed.filter((m) => m.verdict !== 'ОДОБРЕНО').map((m) => m.touchpoint_number).join(', ')}`);
      reviewerOutput = code;
      fb = code;
      cur = { ...cur, last_reviewer_output: code };
      continue;
    }

    if (reviews >= CONFIG.AUTO_REVIEWS) break; // защита: вердикт — последняя проверка reviewer'а
    // Лимит 12000: ответ reviewer'а самый объёмный (14 критериев на касание).
    const result = await callAgentSafe('reviewer', {
      ...baseInput,
      diagnostic_output: deal.last_diagnostic_output,
      strategy_output: deal.last_strategy_output,
      composer_output: composerOutput
    }, 12000);
    reviews++;
    reviewerOutput = result?.reviewer_output || result;
    const traceAt = trace.length;
    applySeverity(reviewerOutput);
    const msgs = messagesOf(composerOutput);
    applyPhraseCheck(reviewerOutput, msgs);
    applyMustIncludeCheck(reviewerOutput, deal.last_strategy_output?.must_include, msgs.length);
    applyScheduleCheck(reviewerOutput, msgs, timeline);
    trace.splice(traceAt, 0, verdictOf(reviewerOutput) === 'ОДОБРЕНО' ? 'проверка приняла' : `проверка вернула ${bad(reviewerOutput) || '(вердикт не прочитан)'}`);
    if (verdictOf(reviewerOutput) === 'ОДОБРЕНО') {
      return done(composerOutput, reviewerOutput, true, rounds, reviews, { trace });
    }
    console.log(`[autoCompose] круг ${rounds}: проверка не приняла касания`);
    if (reviews >= CONFIG.AUTO_REVIEWS) {
      // Проверок больше не делаем (время) — последние замечания вносит editor.
      const edited = await runEditor(baseInput, deal, composerOutput, reviewerOutput);
      if (edited) {
        rounds++;
        trace.push('редактор');
        const code2 = codeChecks(edited, timeline, deal.last_strategy_output?.touch_plan);
        if (code2.verdict === 'ОДОБРЕНО') {
          const fixedNums = (reviewedOf(reviewerOutput)?.messages_reviewed || []).filter((m) => m?.verdict && m.verdict !== 'ОДОБРЕНО').map((m) => m.touchpoint_number);
          return done(edited, reviewerOutput, false, rounds, reviews, { fixedAfterReview: fixedNums, trace });
        }
        trace.push(`код после редактора вернул ${bad(code2)}`);
      } else {
        trace.push('редактор не смог');
      }
      break;
    }
    fb = reviewerOutput;
    cur = { ...cur, last_reviewer_output: reviewerOutput };
  }
  return done(composerOutput, reviewerOutput, verdictOf(reviewerOutput) === 'ОДОБРЕНО', rounds, reviews, { trace });
}

// Касания помечаются как прошедшие цикл проверки: «ок» менеджера на них —
// это принятие итога, а не запуск проверки.
function done(composerOutput, reviewerOutput, approved, rounds, reviews, extra = {}) {
  const out = composerOutput && typeof composerOutput === 'object'
    ? { ...composerOutput, _check: { approved, rounds, reviews, ...extra } }
    : composerOutput;
  return { composer_output: out, reviewer_output: reviewerOutput, approved, rounds, reviews };
}

module.exports = { composeUntilReady, codeChecks, channelKey, messagesOf, applySeverity };

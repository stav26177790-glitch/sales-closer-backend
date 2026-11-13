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
function codeChecks(composerOutput, timeline) {
  const msgs = messagesOf(composerOutput);
  const r = {
    verdict: 'ОДОБРЕНО',
    source: 'code',
    messages_reviewed: msgs.map((m, i) => ({ touchpoint_number: Number(m?.touchpoint_number ?? i + 1), verdict: 'ОДОБРЕНО' }))
  };
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
  applyPhraseCheck(r, msgs);
  applyScheduleCheck(r, msgs, timeline);
  return r;
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

  // startWith — уже готовые касания (сделки, начатые до этой версии): сначала проверить, не переписывая.
  let skipCompose = !!startWith;
  if (startWith) composerOutput = startWith;
  while (rounds < CONFIG.AUTO_COMPOSER_ROUNDS) {
    if (!skipCompose) {
      const fresh = await runComposer(baseInput, cur, {
        feedback: fb,
        channelHistory: rounds === 0 ? channelHistory : undefined,
        iteration: rounds + 1
      });
      rounds++;
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

    const code = codeChecks(composerOutput, timeline);
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
    const msgs = messagesOf(composerOutput);
    applyPhraseCheck(reviewerOutput, msgs);
    applyMustIncludeCheck(reviewerOutput, deal.last_strategy_output?.must_include, msgs.length);
    applyScheduleCheck(reviewerOutput, msgs, timeline);
    if (verdictOf(reviewerOutput) === 'ОДОБРЕНО') {
      return done(composerOutput, reviewerOutput, true, rounds, reviews);
    }
    console.log(`[autoCompose] круг ${rounds}: проверка не приняла касания`);
    if (reviews >= CONFIG.AUTO_REVIEWS) break;
    fb = reviewerOutput;
    cur = { ...cur, last_reviewer_output: reviewerOutput };
  }
  return done(composerOutput, reviewerOutput, verdictOf(reviewerOutput) === 'ОДОБРЕНО', rounds, reviews);
}

// Касания помечаются как прошедшие цикл проверки: «ок» менеджера на них —
// это принятие итога, а не запуск проверки.
function done(composerOutput, reviewerOutput, approved, rounds, reviews) {
  const out = composerOutput && typeof composerOutput === 'object'
    ? { ...composerOutput, _check: { approved, rounds, reviews } }
    : composerOutput;
  return { composer_output: out, reviewer_output: reviewerOutput, approved, rounds, reviews };
}

module.exports = { composeUntilReady, codeChecks, channelKey, messagesOf };

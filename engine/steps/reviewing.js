/**
 * Этап REVIEWING — reviewer не одобрил касания, результат показан менеджеру.
 * Следующее сообщение запускает автоматическую доработку, пока не исчерпан
 * лимит MAX_COMPOSER_ITERATIONS; после него — ESCALATION.
 */
const { runComposer, runMemoryUpdate, keepApprovedTouches } = require('../pipeline');
const { CONFIG } = require('../config');

// На доработке только касания, которые вернул КОД (у них точная подсказка).
const CODE_CRITERIA = new Set(['schedule', 'must_include', 'no_stop_words']);
function onlyCodeFixes(reviewerOutput) {
  const r = reviewerOutput?.messages_reviewed ? reviewerOutput : reviewerOutput?.reviewer_output;
  const rejected = (r?.messages_reviewed || []).filter((m) => m?.verdict && m.verdict !== 'ОДОБРЕНО');
  return rejected.length > 0 && rejected.every((m) => m.code_checked && (m.failed_criteria || []).every((c) => CODE_CRITERIA.has(c)));
}

async function reviewing({ dealId, deal, baseInput }) {
  const output = {};
  const iterations = deal.composer_iterations || 1;
  // С фикса бага №34 одобрение финализируется сразу в COMPOSING. Ветка ниже —
  // фоллбэк для сделок, застрявших в REVIEWING с вердиктом «ОДОБРЕНО» до фикса.
  if (deal.last_reviewer_output?.verdict === 'ОДОБРЕНО') {
    output._finalText = await runMemoryUpdate(dealId, baseInput, deal);
    return { nextState: 'FINAL_OUTPUT', output };
  }
  if (iterations >= CONFIG.MAX_COMPOSER_ITERATIONS + (onlyCodeFixes(deal.last_reviewer_output) ? CONFIG.CODE_FIX_EXTRA_ITERATIONS : 0)) {
    return { nextState: 'ESCALATION', output };
  }
  const reworked = await runComposer(baseInput, deal, {
    feedback: deal.last_reviewer_output,
    iteration: iterations + 1
  });
  const { output: merged, kept } = keepApprovedTouches(reworked, deal.last_composer_output, deal.last_reviewer_output);
  if (kept.length) console.log(`[composer] Одобренные касания оставлены без изменений: ${kept.join(', ')}`);
  output.composer_output = merged;
  output._composer_iterations = iterations + 1;
  return { nextState: 'COMPOSING', output };
}

module.exports = { reviewing, onlyCodeFixes };

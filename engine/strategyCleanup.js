/**
 * engine/strategyCleanup.js — правила владельца для текста стратегии, кодом.
 *
 * Спящий режим — только после 7 касаний без ответа (или явного «не сейчас»),
 * длится 30–40 рабочих дней, затем одно касание «как дела, какие результаты».
 * Живые «Зерно 2/4/5» (2026-11-13): стратегия трижды писала «если после 5
 * касаний движения нет — в спящий режим». Инструкцией не удержалось → код.
 */
const SLEEP_RULE = 'Если после 7 касаний без ответа движения нет — спящий режим на 30–40 рабочих дней, затем одно касание «как дела, какие результаты».';
const EARLY_SLEEP_RE = /[^.!?\n]*(после|через)\s+([1-6]|одно|двух|трёх|трех|четыр[её]х|пяти|шести|1–\d|\d–[1-6])\s*(-?х|-?ти)?\s*касани[а-яё]*[^.!?\n]*спящ[а-яё]*[^.!?\n]*[.!?]?|[^.!?\n]*спящ[а-яё]*[^.!?\n]*(после|через)\s+([1-6]|пяти|шести)\s*касани[а-яё]*[^.!?\n]*[.!?]?/gi;

// «Если после 5 касаний движения нет — … зафиксировать как потерянную» (живой «Зерно 6»
// после ответа клиента): тоже против правила — после 7 касаний спящий режим, не «потеряна».
const EARLY_LOST_RE = /[^.!?\n]*(после|через)\s+([1-6]|одно|двух|трёх|трех|четыр[её]х|пяти|шести)\s*(-?х|-?ти)?\s*касани[а-яё]*[^.!?\n]*(потерянн|закрыть сделку|закрываем сделку|списать)[^.!?\n]*[.!?]?/gi;

function cleanText(text) {
  if (typeof text !== 'string' || !/спящ|потерянн|закрыть сделку|закрываем сделку|списать/i.test(text)) return { text, fixed: 0 };
  let fixed = 0;
  const repl = (m) => { fixed++; return (/^\s/.test(m) ? ' ' : '') + SLEEP_RULE; };
  const out = text.replace(EARLY_SLEEP_RE, repl).replace(EARLY_LOST_RE, repl);
  return { text: out, fixed };
}

function cleanStrategy(s) {
  if (!s || typeof s !== 'object') return 0;
  let total = 0;
  for (const k of ['strategy_summary', 'recommended_next_action']) {
    const { text, fixed } = cleanText(s[k]);
    if (fixed) { s[k] = text; total += fixed; }
  }
  if (s.primary_strategy && typeof s.primary_strategy === 'object') {
    const { text, fixed } = cleanText(s.primary_strategy.rationale);
    if (fixed) { s.primary_strategy.rationale = text; total += fixed; }
  }
  if (total) console.warn(`[strategyCleanup] Исправлен ранний «спящий режим»: ${total}`);
  return total;
}

module.exports = { cleanStrategy, cleanText, SLEEP_RULE };

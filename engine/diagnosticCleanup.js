/**
 * engine/diagnosticCleanup.js — правила владельца для текста оценки, кодом.
 *
 * Живые «Зерно 4» и «Зерно 5» (2026-11-13): в выводе оценки дважды было
 * «предложить Андрею напрямую, не через Марину» — совет обойти контактное
 * лицо. Оценка советов не даёт, а выход на ЛПР — только с согласия
 * контактного лица. Инструкцией это не удержалось → убираем кодом.
 * Заодно старое «срочность» в выводе → «ЗС (здесь и сейчас)».
 */
// Предложение с советом обойти контактное лицо.
const BYPASS_RE = /(не через\s+[А-ЯЁ][а-яё]+|в обход\s+[А-ЯЁа-яё]+|напрямую,?\s+минуя|минуя\s+[А-ЯЁ][а-яё]+)/;

function splitSentences(text) {
  return String(text || '').match(/[^.!?\n]+[.!?]*\n*|\n+/g) || [];
}

function cleanSummary(text) {
  if (!text) return { text, removed: 0 };
  let removed = 0;
  let out = splitSentences(text).filter((s) => {
    if (BYPASS_RE.test(s)) { removed++; return false; }
    return true;
  }).join('');
  // «через Марину или напрямую» → с согласия
  out = out.replace(/или напрямую(?![^.]*соглас)/g, () => { removed++; return 'или напрямую — с её согласия'; });
  out = out.replace(/(блокер|фактор)\s+—\s+срочность/gi, '$1 — ЗС (здесь и сейчас)');
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), removed };
}

function cleanDiagnostic(diag) {
  if (!diag || typeof diag !== 'object' || typeof diag.diagnostic_summary !== 'string') return 0;
  const { text, removed } = cleanSummary(diag.diagnostic_summary);
  diag.diagnostic_summary = text;
  if (removed) console.warn(`[diagnosticCleanup] Убраны советы обойти контактное лицо: ${removed}`);
  return removed;
}

// СОПРАНО «О — Ограничения» (владелец, 14.11): бюджет менеджер должен был выяснить,
// но получается не всегда. Если в переписке возражение по цене, а среди рекомендаций
// нет бюджета — добавляем рекомендацию кодом (она ведёт к ответу на «дорого»).
const PRICE_OBJECTION_RE = /(дорог|дороговат|дешевле|не укладыва|бюджет(а)? не хват|предлагают за|у других (дешевле|за))/i;
function ensureBudgetRecommendation(diag, sourceText) {
  if (!diag || typeof diag !== 'object') return false;
  if (!PRICE_OBJECTION_RE.test(String(sourceText || ''))) return false;
  const recs = Array.isArray(diag.soprano_recommendations) ? diag.soprano_recommendations : [];
  if (recs.some((r) => /бюджет|сколько заложил|ориентир по (цене|стоимости)/i.test(String(r)))) return false;
  const rec = 'Бюджет (СОПРАНО: Ограничения): клиент говорит о цене — уточнить ориентир по бюджету и с чем сравнивает. ' +
    '«Чтобы предложить подходящий вариант — какой бюджет заложили на вывеску и с чем сравниваете?» ' +
    'Без этого ответ на «дорого» — гадание; скидку не предлагать.';
  diag.soprano_recommendations = [rec, ...recs].slice(0, 3);
  return true;
}

module.exports = { cleanDiagnostic, cleanSummary, ensureBudgetRecommendation };

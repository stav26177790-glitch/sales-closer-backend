/**
 * engine/brand.js — под каким брендом идёт сделка (владелец 14.11: «используем оба по ситуации»).
 * Металл (нержавейка, латунь) — «Металл Буква Экспресс» (metallbukva.ru), остальное —
 * «Яркая Реклама» (msk-viveska.ru). Цифры опыта и гарантии называются только своего бренда
 * (knowledge/industry/signage.md). Только для отрасли вывесок.
 */
function detectBrand(deal) {
  if (deal?.industry && deal.industry !== 'signage') return null;
  const t = String(deal?.product || '').toLowerCase();
  if (!t.trim()) return null;
  if (/нерж|латун|металл|сталь|стальн/.test(t)) return 'Металл Буква Экспресс';
  return 'Яркая Реклама';
}
module.exports = { detectBrand };

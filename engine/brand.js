/**
 * engine/brand.js — под каким брендом идёт сделка (владелец 14.11: «используем оба по ситуации»).
 * Металл (нержавейка, латунь) — «Металл Буква Экспресс» (metallbukva.ru), остальное —
 * «Яркая Реклама» (msk-viveska.ru). Цифры опыта и гарантии называются только своего бренда
 * (knowledge/industry/signage.md). Только для отрасли вывесок.
 */
function detectBrand(deal, source = '') {
  if (deal?.industry && deal.industry !== 'signage') return null;
  // Живой тест 19.11: в Клоузере поле «продукт» пустое, КП (нержавейка) — в переписке → писатель взял «Яркую Рекламу».
  // Без продукта — по строкам КП / заказа в переписке.
  const kp = String(source || '').split(/\n|(?<=[.!?])\s/).filter((x) => /кп|₽|буквы|вывеск/i.test(x)).join(' ');
  const t = String(deal?.product || '').toLowerCase() || kp.toLowerCase();
  if (!t.trim()) return null;
  if (/нерж|латун|металл|сталь|стальн/.test(t)) return 'Металл Буква Экспресс';
  return 'Яркая Реклама';
}
module.exports = { detectBrand };

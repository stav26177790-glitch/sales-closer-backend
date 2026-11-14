/**
 * engine/cases.js — реальные кейсы компании (сайты msk-viveska.ru и metallbukva.ru,
 * владелец 14.11: «рейтингов нет, но есть масса кейсов — заход через кейсы»).
 *
 * Модель читает кейсы из knowledge/industry/signage.md (что сделали, где посмотреть).
 * Здесь — только названия: код проверяет, что кейс, названный в касании
 * («делали вывеску для «Капи»»), действительно есть в списке или в переписке.
 * Новый кейс → строка в signage.md И название здесь (тест сверяет).
 */
const CASE_NAMES = [
  'Капи', 'Smoke Dog', 'Смоук Дог', 'Мята', 'Kaufman', 'Кауфман', 'Н·Дорс', 'Н-Дорс', 'Рений', 'Автомобильное ателье',
  'MySmile', 'KV', 'Лимон', 'Мельница', 'Zaira Gatagazheva', 'KICO', 'Ё ХАУС', 'Е ХАУС', 'Лужники',
  'Арбат Плаза', 'GISLAVED', 'Pastech', 'SOKOLOV', 'Соколов', 'Курск', 'Потапово', 'Росгаз', 'BODUEN', 'Радаарт'
];

const norm = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[·\-]/g, ' ').replace(/\s+/g, ' ').trim();

// «делали / сделали / изготовили … для «X»» → X. Название — в «ёлочках» или латиницей.
const CLAIM_RE = /(делали|сделали|изготовили|изготавливали|монтировали|смонтировали|ставили|устанавливали)[^.!?\n]{0,60}?(?:для|у|в)\s+(?:[а-яё]+\s+){0,3}(«[^»]{2,40}»|[A-Z][A-Za-z0-9&' ]{1,30})/gi;

// Названные в тексте кейсы, которых нет ни в списке, ни в переписке.
function unknownCases(text, sourceText = '') {
  const out = [];
  const src = norm(sourceText);
  for (const m of String(text || '').matchAll(CLAIM_RE)) {
    const name = m[2].replace(/[«»]/g, '').trim();
    const n = norm(name);
    if (!n) continue;
    if (CASE_NAMES.some((c) => n.includes(norm(c)) || norm(c).includes(n))) continue;
    if (src && src.includes(n)) continue;
    out.push(name);
  }
  return out;
}

module.exports = { CASE_NAMES, unknownCases };

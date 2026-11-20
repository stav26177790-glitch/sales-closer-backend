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


// ── Подбор кейса под тип бизнеса клиента — на уровне плана (дорожная карта, шаг 3, 20.11) ──
// Прогоны 19.11: писатель выдумывал «барбершоп похожего формата, которому мы делали вывеску» и «кейс ресторана» —
// таких в списке нет, а план требовал «кейс того же типа». Код подбирает кейс из таблицы signage.md («# Кейсы»):
// тот же тип → смежный (владелец 20.11: «можно», назвать смежным) → ни того ни другого — кейс в план не ставим.
const fs = require('fs');
const path = require('path');

let CASES = null;
function loadCases() {
  if (CASES) return CASES;
  const md = fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'industry', 'signage.md'), 'utf8');
  const sec = md.slice(md.indexOf('# Кейсы'));
  const rows = sec.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*(Клиент|-)/.test(l));
  CASES = [];
  for (const l of rows) {
    const c = l.split('|').slice(1, -1).map((x) => x.trim());
    if (c.length < 4) break;
    CASES.push({ name: c[0], type: c[1], what: c[2], where: c[3] });
  }
  return CASES;
}

// Тип бизнеса клиента → какие кейсы «тот же тип», какие «смежные». Ключи кейсов — по полю «Клиент» / «Тип».
const TYPES = [
  { key: 'кафе', re: /кофейн|кафе|пекарн|бистро|столов|кондитерск/i, same: /кафе/i, near: /бар|кальян|мята/i },
  { key: 'ресторан', re: /ресторан|гриль|стейк|пиццери|суши/i, same: /ресторан/i, near: /кафе|бар|кальян|мята/i },
  { key: 'бар', re: /\bбар\b|паб|кальянн|лаунж/i, same: /бар|кальян/i, near: /кафе|мята/i },
  { key: 'отель', re: /отел|гостиниц|хостел|апарт/i, same: /отель/i, near: /деловой центр|жилой/i },
  { key: 'аптека', re: /аптек/i, same: /аптека/i, near: /стоматолог/i },
  { key: 'медицина', re: /медцентр|медицинск|клиник|стоматолог|дент/i, same: /стоматолог/i, near: /аптека/i },
  { key: 'автосервис', re: /автосервис|шиномонтаж|автомой|автомастерск|гараж|автозапчаст/i, same: /автосервис|автомастерск/i, near: /^$/ },
  { key: 'фитнес', re: /фитнес|растяжк|йог|танц|спортзал|бокс|пилатес/i, same: /фитнес|спорт/i, near: /^$/ },
  { key: 'салон', re: /салон красоты|бьюти|маникюр|ногт|косметолог|брови|ресниц/i, same: /салон|бьюти/i, near: /^$/ },
  { key: 'барбершоп', re: /барбершоп|барбер|парикмахерск/i, same: /барбершоп/i, near: /салон|бьюти/i },
  { key: 'магазин', re: /магазин|бутик|ювелир|цвет(ы|оч)|шоурум/i, same: /магазин/i, near: /торговый центр/i },
  { key: 'офис', re: /юрист|юридическ|офис|бизнес-центр|бизнес центр|агентств|бюро/i, same: /деловой центр/i, near: /^$/ }
];

function bizTypeOf(source) {
  const s = String(source || '');
  let best = null;
  for (const t of TYPES) {
    const m = s.match(t.re);
    if (m && (best === null || m.index < best.at)) best = { t, at: m.index };
  }
  return best ? best.t : null;
}

function casesFor(source) {
  const t = bizTypeOf(source);
  if (!t) return { type: null, same: [], near: [] };
  const all = loadCases();
  const hay = (c) => `${c.name} ${c.type}`;
  const same = all.filter((c) => t.same.test(hay(c)));
  const near = all.filter((c) => !same.includes(c) && t.near.test(hay(c)));
  return { type: t.key, same, near };
}

const nm = (c) => (/без названия/.test(c.name) ? `${c.type} (работа в портфолио, без названия — показывать ссылкой)` : `«${c.name.replace(/^«|»$/g, '')}» (${c.type})`);
const line = (c) => `${nm(c)} — ${c.what}${/^https?:/.test(c.where) ? `, ${c.where}` : ', галерея https://msk-viveska.ru/galereya'}`;

// Подсказка писателю для касания с кейсом. null — кейса нет, инструмент «кейс» в план не ставим.
function caseNote(source) {
  const { type, same, near } = casesFor(source);
  if (same.length) return `КЕЙС (код подобрал из кейсов компании, тип «${type}»): ${same.slice(0, 2).map(line).join('; ')}. Только эти кейсы, с названием; результатов, цен и сроков, которых нет в списке, не добавлять.`;
  if (near.length) return `КЕЙС: того же типа («${type}») у компании нет — СМЕЖНЫЙ (владелец 20.11: можно, назвать смежным, «делали для …, тоже …»): ${near.slice(0, 2).map(line).join('; ')}. «Похожий барбершоп / ресторан, которому мы делали» — не писать: его нет.`;
  return null;
}

module.exports = { CASE_NAMES, unknownCases, casesFor, caseNote, bizTypeOf, loadCases };

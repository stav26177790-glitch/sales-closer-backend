'use strict';
/**
 * Ценовой ориентир для вилки клиенту (владелец 18.11). Считает КОД, не модель.
 *
 * Источник — общий прайс обоих брендов «01_08_ПРАЙС.xlsm» (лист «Прайс», «Сроки | Монтаж»). Цены в прайсе —
 * СЕБЕСТОИМОСТЬ. Клиентская цена Х = себестоимость × 1,8 (база); металл и сложные решения — × 2; нижняя граница
 * торга — × 1,6. Вилка клиенту: от Х − 20% до Х + 40%. Точная цена — после экспертизы менеджера.
 * Себестоимость, коэффициенты и нижнюю границу торга клиенту НЕ называть.
 *
 * Буквы считаются «за 1 см по большей стороне» (высота буквы) по полосам высоты. Если высоты нет, но есть
 * длина вывески L: сумма высот букв ≈ L / 0,85 (ширина буквы ≈ 0,85 высоты, с пробелами) — от числа букв
 * не зависит. Позиции «инд.» / «считается индивидуально» — без вилки.
 */

const COEF = { base: 1.8, metal: 2.0, floor: 1.6 };
const RANGE = { low: 0.8, high: 1.4 };
const WIDTH_PER_HEIGHT = 0.85;

// Себестоимость, ₽ за 1 см высоты буквы: [от см, до см, ставка]. Лист «Прайс», базовая строка (лицо без плёнки).
const LETTERS = {
  light_front: { name: 'световые объёмные буквы, металлический борт, лицевая подсветка (акрил)', min: 11000,
    re: /(светов|подсветк|светящ)/i, bands: [[8, 13, 110.4], [14, 20, 99.75], [21, 50, 78.75], [51, 90, 97.65], [91, 130, 188.1]] },
  light_front_back: { name: 'световые буквы с лицевой и задней подсветкой', min: 11000,
    re: /лицев[а-яё]* и задн|задн[а-яё]* и лицев/i, bands: [[8, 13, 120], [14, 20, 115.5], [21, 50, 105], [51, 90, 126], [91, 130, 195.7]] },
  light_back: { name: 'буквы с контражурной (задней) подсветкой', min: 11000,
    re: /контражур|задн[а-яё]* подсвет/i, bands: [[8, 13, 116], [14, 20, 105], [21, 50, 99.75], [51, 90, 115.5], [91, 130, 192.8]] },
  light_side: { name: 'буквы с боковой подсветкой', min: 11000,
    re: /боков[а-яё]* подсвет/i, bands: [[14, 20, 220.5], [21, 50, 173.2], [51, 90, 199.5], [91, 130, 213.8]] },
  unlit_volume: { name: 'объёмные буквы без подсветки, металлический борт', min: 5000,
    re: /без подсвет|несветов/i, bands: [[8, 13, 76.5], [14, 20, 73.5], [21, 50, 68.25], [51, 90, 89.25], [91, 130, 114]] },
  flat_pvc: { name: 'плоские буквы из ПВХ 5 мм', min: 5000,
    re: /плоск[а-яё]* букв[^.\n]{0,20}(пвх|пластик)|(пвх|пластик)[^.\n]{0,20}плоск/i, bands: [[10, 130, 21.8]] },
  steel_flat: { name: 'плоские буквы из нержавеющей стали', metal: true, min: 5000,
    re: /плоск[а-яё]*[^.\n]{0,25}нерж|нерж[а-яё]*[^.\n]{0,25}плоск/i, bands: [[8, 60, 50.8], [60, 99, 56.6]] },
  brass_flat: { name: 'плоские буквы из латуни', metal: true, min: 5000,
    re: /плоск[а-яё]*[^.\n]{0,25}латун|латун[а-яё]*[^.\n]{0,25}плоск/i, bands: [[8, 60, 67], [60, 99, 78.5]] },
  steel_volume: { name: 'объёмные буквы из нержавеющей стали', metal: true, min: 5000,
    re: /нерж/i, bands: [[8, 60, 93.6], [60, 99, 99.3]] },
  brass_volume: { name: 'объёмные буквы из латуни', metal: true, min: 5000,
    re: /латун/i, bands: [[8, 60, 104], [60, 99, 125.9]] },
  steel_light: { name: 'световые буквы из нержавеющей стали', metal: true, min: 11000,
    re: /(нерж|латун|металл)[^.\n]{0,40}(светов|подсвет)|(светов|подсвет)[^.\n]{0,40}(нерж|латун|металл)/i, bands: [[10, 19, 153.6], [20, 59, 153.6], [60, 99, 169]] }
};
// Порядок проверки: от частного к общему.
const ORDER = ['steel_light', 'steel_flat', 'brass_flat', 'brass_volume', 'steel_volume', 'light_side', 'light_front_back', 'light_back', 'flat_pvc', 'unlit_volume', 'light_front'];

// Таблички — себестоимость за 1 дм²; короба — за 1 м².
const PLAQUE = { plastic: { name: 'табличка из пластика с гравировкой', rate: 187 }, steel: { name: 'табличка из нержавейки с аппликацией', rate: 148.5, metal: true } };
const PLAQUE_DEFAULT_DM2 = 12; // 40 × 30 см — типовая табличка у входа
const BOX = { acrylic: { name: 'световой короб из акрила', rate: 12000, min: 8000 }, pseudo: { name: 'короб из АКП с фрезеровкой (псевдоинкрустация)', rate: 13000, min: 9000 }, inlay: { name: 'короб из АКП с инкрустацией', rate: 16500, min: 9000 } };

// Монтаж, лист «Сроки | Монтаж» (редакция февраль 2026): ширина до N м → цена; таблички: выезд 2500 + 800 за шт.
const MOUNT_TUBE = [[1, 3000], [3, 4500], [4, 5500], [6, 7000], [9, 8500]];
const MOUNT_BOX = [[1, 4000], [4, 6000], [6, 8000], [8, 9500], [10, 13000]];
const MOUNT_PLAQUE = { visit: 2500, each: 800 };
const MOUNT_MIN = 5000;

// Лист «Согласование» (клиентская цена, без коэффициента): Москва — по 902-ПП без согласования; Подмосковье — проект.
// Порядок — от частного к общему (Люберцы до общего «область»).
const APPROVAL = [
  [/балаших/i, 'Балашиха', 16000], [/видн(ое|ом)/i, 'Видное', 10000], [/долгопрудн/i, 'Долгопрудный', 18000],
  [/истр/i, 'Истра', 10000], [/королёв|королев/i, 'Королёв', 15000], [/котельник/i, 'Котельники', 15000],
  [/красногорск/i, 'Красногорск', 20000], [/люберц/i, 'Люберцы', 15000], [/мытищ/i, 'Мытищи', 15000],
  [/одинцов/i, 'Одинцово', 10000], [/орехово/i, 'Орехово-Зуево', 15000], [/подольск/i, 'Подольск', 10000],
  [/химк/i, 'Химки', 10000], [/щёлков|щелков/i, 'Щёлково', 10000], [/московск[а-яё]* обл|подмосков/i, 'город МО', 10000]
];
// Мелкая вторая строка («ГИБКОСТЬ» и маленькая строка «студия растяжки»): высота ≈ 1/3,5 основной, не ниже 10 см.
const SECOND_LINE_RATIO = 3.5;
const SECOND_LINE_MIN_CM = 10;

const num = (s) => Number(String(s).replace(',', '.'));
function rateFor(bands, h) {
  const b = bands.find(([a, z]) => h >= a && h <= z) || (h < bands[0][0] ? bands[0] : bands[bands.length - 1]);
  return b[2];
}
const pick = (table, w) => (table.find(([max]) => w <= max) || table[table.length - 1])[1];
const round1000 = (x) => Math.round(x / 1000) * 1000;
// Вилка клиенту — круглыми цифрами (владелец 18.11: «ориентир, округляй цифры в диапазоне»): шаг 1 / 5 / 10 тыс.
const stepOf = (x) => (x < 30000 ? 1000 : x < 100000 ? 5000 : 10000);
const roundDown = (x) => Math.floor(x / stepOf(x)) * stepOf(x);
const roundUp = (x) => Math.ceil(x / stepOf(x)) * stepOf(x);

/** Параметры из текста сделки: длина вывески (см), высота букв (см), текст вывески, табличка, короб, площадь. */
function parseParams(text) {
  const t = String(text || '');
  const out = {};
  const len = t.match(/(длин[а-яё]*|ширин[а-яё]*)[^.!?\n\d]{0,25}(\d+(?:[.,]\d+)?)\s*(м(?![а-яё])|метр[а-яё]*|см)/i)
    || t.match(/(\d+(?:[.,]\d+)?)\s*(метр[а-яё]*|м(?![а-яё]))\s*(в длину|длин|шириной)/i);
  if (len) {
    const v = num(len[2] && /\d/.test(len[2]) ? len[2] : len[1]);
    const unit = len[2] && /\d/.test(len[2]) ? len[3] : len[2];
    out.lengthCm = /^см/i.test(unit) ? v : v * 100;
  }
  const h = t.match(/высот[а-яё]*\s*(букв[а-яё]*)?[^.!?\n\d]{0,15}(\d+)\s*см/i) || t.match(/букв[а-яё]*\s*(по|высотой)\s*(\d+)\s*см/i);
  if (h) out.letterHeightCm = num(h[2]);
  const q = t.match(/текст[^«"\n]{0,20}[«"]([^»"\n]{2,40})[»"]/i);
  if (q) out.signText = q[1];
  // Живой «Гибкость» (аудит 18.11): «Текст «ГИБКОСТЬ» и маленькая строка «студия растяжки»» — вторая строка не считалась.
  const q2 = t.match(/(?:маленьк[а-яё]*|мелк[а-яё]*|втор[а-яё]*|нижн[а-яё]*|под ним[а-яё]*)\s+(?:строк[а-яё]*|надпис[а-яё]*|подпис[а-яё]*)[^«"\n]{0,10}[«"]([^»"\n]{2,60})[»"]/i);
  if (q2) out.secondText = q2[1];
  if (/табличк/i.test(t)) out.plaque = /нерж|металл|латун/i.test((t.match(/табличк[^.!?\n]{0,60}/i) || [''])[0]) ? 'steel' : 'plastic';
  if (/короб|лайтбокс/i.test(t)) out.box = /инкрустац/i.test(t) ? (/псевдо/i.test(t) ? 'pseudo' : 'inlay') : 'acrylic';
  const area = t.match(/(\d+(?:[.,]\d+)?)\s*[x×х*]\s*(\d+(?:[.,]\d+)?)\s*(м|см)/i);
  if (area) { const k = /см/i.test(area[3]) ? 0.0001 : 1; out.areaM2 = num(area[1]) * num(area[2]) * k; }
  return out;
}

function detectLetters(productText) {
  const t = String(productText || '');
  if (!/букв|вывеск|надпис|логотип/i.test(t)) return null;
  for (const k of ORDER) if (LETTERS[k].re.test(t)) return k;
  return /объ[её]мн/i.test(t) ? 'unlit_volume' : null;
}

/**
 * Ориентир. deal: { product, industry }, sourceText — материалы сделки.
 * null — если не вывески, продукт не распознан или нет ни длины, ни высоты букв (вилку не выдумываем).
 */
function priceGuide(deal, sourceText = '') {
  if (deal?.industry && deal.industry !== 'signage') return null;
  const all = [deal?.product, sourceText].filter(Boolean).join('\n');
  const p = parseParams(all);
  const kind = detectLetters(deal?.product) || detectLetters(sourceText);
  const items = [];
  const assumptions = [];
  let cost = 0;
  let metal = false;
  let widthM = p.lengthCm ? p.lengthCm / 100 : null;

  if (kind) {
    const L = LETTERS[kind];
    let sumHeights = null;
    let h = p.letterHeightCm || null;
    const letters = p.signText ? p.signText.replace(/[^А-ЯЁA-Zа-яёa-z0-9]/g, '').length : null;
    if (h && letters) sumHeights = h * letters;
    else if (p.lengthCm) {
      sumHeights = p.lengthCm / WIDTH_PER_HEIGHT;
      if (!h && letters) h = Math.round(p.lengthCm / (letters * WIDTH_PER_HEIGHT));
      if (!h) { h = 40; assumptions.push('высота букв не известна — взята типовая 21–50 см'); }
    } else if (h) {
      return null; // высота есть, а ни текста, ни длины — сколько букв, неизвестно
    } else {
      return null;
    }
    if (!widthM && h && letters) widthM = (h * letters * WIDTH_PER_HEIGHT) / 100;
    const c = Math.max(L.min, rateFor(L.bands, h) * sumHeights);
    cost += c;
    metal = metal || !!L.metal;
    items.push(`${L.name}: ${p.lengthCm ? `длина ≈ ${Math.round(p.lengthCm / 10) / 10} м` : `${letters} букв`}${h ? `, высота ≈ ${h} см` : ''}`);
    if (!p.signText) assumptions.push('текст вывески не известен — расчёт по длине');
    if (p.secondText && h) {
      const n2 = p.secondText.replace(/[^А-ЯЁA-Zа-яёa-z0-9]/g, '').length;
      const h2 = Math.max(SECOND_LINE_MIN_CM, Math.round(h / SECOND_LINE_RATIO));
      cost += Math.max(0, rateFor(L.bands, h2) * h2 * n2);
      items.push(`вторая строка «${p.secondText}»: ${n2} букв, высота ≈ ${h2} см`);
      assumptions.push('высота второй строки не известна — взята ≈ 1/3,5 основной');
    }
  }
  // Короб — и отдельно, и вместе с буквами (буквы + короб «Шиномонтаж»).
  if (p.box && p.areaM2) {
    const B = BOX[p.box];
    cost += Math.max(B.min, B.rate * p.areaM2);
    items.push(`${B.name}: ${Math.round(p.areaM2 * 100) / 100} м²`);
  } else if (!kind) {
    return null;
  }
  if (p.plaque) {
    const P = PLAQUE[p.plaque];
    cost += P.rate * PLAQUE_DEFAULT_DM2;
    metal = metal || !!P.metal;
    items.push(`${P.name}: типовая 40 × 30 см`);
    assumptions.push('размер таблички не известен — взята типовая 40 × 30 см');
  }
  // Монтаж — если в сделке он есть (по умолчанию да: «под ключ»), кроме явного «без монтажа».
  // «Баннер на фасад сами повесим за 15 тысяч» — про баннер-альтернативу, не про нашу вывеску (аудит 18.11).
  const selfMount = [...all.matchAll(/сами (повесим|смонтируем|поставим)/gi)]
    .some((m) => !/баннер|плёнк|пленк|наклейк|распечат/i.test(all.slice(Math.max(0, m.index - 60), m.index + 40)));
  const noMount = /без монтаж/i.test(all) || selfMount;
  if (!noMount) {
    let m = widthM ? pick(kind ? MOUNT_TUBE : MOUNT_BOX, widthM) : MOUNT_MIN;
    if (p.plaque) m += MOUNT_PLAQUE.each;
    cost += Math.max(MOUNT_MIN, m);
    items.push('монтаж');
  }
  const coef = metal ? COEF.metal : COEF.base;
  // Согласование в Подмосковье — клиентская цена из листа «Согласование», поверх (без коэффициента).
  const { MOSCOW_RE } = require('./geo');
  const city = MOSCOW_RE.test(all) ? null : APPROVAL.find(([re]) => re.test(all));
  const approval = city ? city[2] : 0;
  if (city) items.push(`согласование (${city[1]}): дизайн-проект${city[2] >= 15000 ? ' и проекты по листу «Согласование»' : ''}`);
  const x = cost * coef + approval;
  return {
    source: 'прайс 01.08 (себестоимость) × коэффициент, расчёт кодом',
    items,
    assumptions,
    coef,
    x: round1000(x),
    client_range: { from: roundDown(x * RANGE.low), to: roundUp(x * RANGE.high) },
    torg_floor: round1000(cost * COEF.floor + approval),
    how_to_use: 'Вилку клиенту — «от … до … ₽ с монтажом»: ориентир, «точную цену дам, когда посмотрю ваш фасад / макет» (владелец 18.11: точная цена — после экспертизы менеджера). Себестоимость, коэффициент и нижнюю границу торга клиенту НЕ называть. torg_floor — для менеджера: ниже неё цену не опускать (коэффициент 1,6). Если в сделке уже есть цена КП — клиенту звучит она, а не вилка.'
  };
}

/** Короткая строка для проверок кода: числа ориентира — «данные сделки», а не выдумка. */
function priceGuideNumbers(g) {
  return g ? `${g.x} ${g.client_range.from} ${g.client_range.to}` : '';
}

module.exports = { priceGuide, parseParams, priceGuideNumbers, COEF, RANGE };

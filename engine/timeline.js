/**
 * engine/timeline.js — расчёт сроков сделки кодом, а не моделью.
 *
 * Модели ошибаются в календаре (живой тест 2026-11-12: «20 ноября»,
 * «13 рабочих дней», «гарантированно успеем»). Поэтому все даты готовности
 * и последний день старта считает этот модуль, агенты получают готовый
 * расчёт (`baseInput.timeline`) и только используют его.
 *
 * Правила счёта:
 *  - только рабочие дни: без суббот, воскресений и праздников РФ (HOLIDAYS);
 *  - производство N рабочих дней ПОСЛЕ дня старта (день старта — день
 *    согласования макета — не считается);
 *  - монтаж — ещё install_days_min…max рабочих дней после производства;
 *  - клиенту нужно К дате (день открытия) — значит, монтаж должен
 *    закончиться в последний рабочий день ДО неё (ready_by);
 *  - последний день старта считается по худшему случаю (max дней монтажа).
 */

// Нерабочие праздничные дни, выпадающие на будни (выходные исключаются и так).
// 2026 — по постановлению Правительства (переносы: 9 января и 31 декабря).
// 2027 — по Трудовому кодексу (праздник в выходной → следующий рабочий день);
// январские переносы 2027 — уточнить после постановления и дополнить.
const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09',
  '2026-02-23', '2026-03-09', '2026-05-01', '2026-05-11', '2026-06-12', '2026-11-04', '2026-12-31',
  // 2027
  '2027-01-01', '2027-01-04', '2027-01-05', '2027-01-06', '2027-01-07', '2027-01-08',
  '2027-02-23', '2027-03-08', '2027-05-03', '2027-05-10', '2027-06-14', '2027-11-04'
]);

// Временная вывеска (баннер) к открытию, если постоянную не успеваем —
// от владельца 2026-11-12: изготовление 3–4 рабочих дня + монтаж.
// Монтаж баннера — 1 рабочий день (допущение, уточнить у владельца).
const TEMP_BANNER = { productionMin: 3, productionMax: 4, install: 1 };

const DAY_MS = 864e5;
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Даты — строки YYYY-MM-DD; внутри считаем в UTC, чтобы не зависеть от пояса сервера.
const toDate = (iso) => new Date(`${iso}T00:00:00Z`);
const toIso = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => toIso(new Date(toDate(iso).getTime() + n * DAY_MS));

function isWorkingDay(iso) {
  const wd = toDate(iso).getUTCDay();
  return wd !== 0 && wd !== 6 && !HOLIDAYS.has(iso);
}

// N рабочих дней после даты (сама дата не считается).
function addWorkingDays(iso, n) {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isWorkingDay(d)) left--;
  }
  return d;
}

// Дата, от которой N рабочих дней спустя будет `iso` (обратная к addWorkingDays).
function subtractWorkingDays(iso, n) {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, -1);
    if (isWorkingDay(d)) left--;
  }
  // день старта сам должен быть рабочим — сдвигаем назад до рабочего
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}

// Последний рабочий день строго до даты.
function lastWorkingDayBefore(iso) {
  let d = addDays(iso, -1);
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}

// Рабочих дней от a (не включая) до b (включая); отрицательное, если b раньше a.
function workingDaysBetween(a, b) {
  if (a === b) return 0;
  const sign = a < b ? 1 : -1;
  let [from, to] = sign > 0 ? [a, b] : [b, a];
  let count = 0;
  while (from < to) {
    from = addDays(from, 1);
    if (isWorkingDay(from)) count++;
  }
  return sign * count;
}

function humanDate(iso) {
  const d = toDate(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} (${WEEKDAYS[d.getUTCDay()]})`;
}

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
};
const wdays = (n) => `${n} ${plural(n, 'рабочий день', 'рабочих дня', 'рабочих дней')}`;

/**
 * @param {object} p
 * @param {string} p.today            YYYY-MM-DD
 * @param {string} p.clientDeadline   YYYY-MM-DD — к какой дате нужно клиенту (день открытия)
 * @param {number} p.productionDays   рабочих дней производства
 * @param {number} [p.installDaysMin] рабочих дней монтажа, минимум (по умолчанию 2)
 * @param {number} [p.installDaysMax] рабочих дней монтажа, максимум (по умолчанию 3)
 * @returns {object|null} null — если данных для расчёта нет
 */
function computeTimeline({ today, clientDeadline, productionDays, installDaysMin = 2, installDaysMax = 3 }) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const prod = Number(productionDays);
  if (!iso.test(String(today)) || !iso.test(String(clientDeadline)) || !(prod > 0)) return null;
  const iMin = Math.max(0, Number(installDaysMin) || 0);
  const iMax = Math.max(iMin, Number(installDaysMax) || iMin);

  // Дата клиента уже прошла — почти всегда опечатка при вводе (живой тест
  // 2026-11-12: вместо 1 декабря сохранилось 1 ноября). Не считаем, а просим
  // менеджера проверить; агенты в этом случае дат не называют.
  if (clientDeadline <= today) {
    return {
      today,
      client_deadline: clientDeadline,
      status: 'дата прошла',
      summary: `Дата клиента — ${humanDate(clientDeadline)} — уже прошла. Проверьте поле «Нужно клиенту к» в сроках сделки. Пока даты готовности не называем.`,
      rules: 'Дата клиента в карточке сделки уже прошла — вероятно, ошибка ввода. Конкретных дат готовности и последнего дня старта в касаниях не называй.'
    };
  }

  const readyBy = lastWorkingDayBefore(clientDeadline);
  const productionDone = addWorkingDays(today, prod);
  const installedEarliest = addWorkingDays(productionDone, iMin);
  const installedLatest = addWorkingDays(productionDone, iMax);
  const latestStart = subtractWorkingDays(readyBy, prod + iMax);
  const latestStartBestCase = subtractWorkingDays(readyBy, prod + iMin);
  const buffer = workingDaysBetween(installedLatest, readyBy); // >0 запас, <0 опоздание

  let status;
  let verdict;
  if (buffer > 0) {
    status = 'с запасом';
    verdict = `успеваем с запасом ${wdays(buffer)}`;
  } else if (buffer === 0) {
    status = 'впритык';
    verdict = 'успеваем впритык, без запаса';
  } else if (installedEarliest <= readyBy) {
    status = 'впритык';
    verdict = `успеваем впритык, только если монтаж займёт ${iMin} ${plural(iMin, 'день', 'дня', 'дней')}`;
  } else {
    status = 'не успеваем';
    verdict = `при обычном сроке не успеваем: опоздание ${wdays(-workingDaysBetween(installedEarliest, readyBy))} даже при быстром монтаже`;
  }

  // Временная вывеска — считаем, только когда постоянную не успеваем или впритык.
  let tempBanner = null;
  if (status !== 'с запасом') {
    const bEarliest = addWorkingDays(today, TEMP_BANNER.productionMin + TEMP_BANNER.install);
    const bLatest = addWorkingDays(today, TEMP_BANNER.productionMax + TEMP_BANNER.install);
    const bLatestStart = subtractWorkingDays(readyBy, TEMP_BANNER.productionMax + TEMP_BANNER.install);
    tempBanner = {
      production_working_days: `${TEMP_BANNER.productionMin}–${TEMP_BANNER.productionMax}`,
      install_working_days: TEMP_BANNER.install,
      if_start_today_ready: bEarliest === bLatest ? bLatest : `${bEarliest} – ${bLatest}`,
      fits_client_deadline: bLatest <= readyBy,
      latest_start_date: bLatestStart,
      summary: bLatest <= readyBy
        ? `Временная вывеска (баннер): ${TEMP_BANNER.productionMin}–${TEMP_BANNER.productionMax} раб. дн. + монтаж ${TEMP_BANNER.install} раб. дн. — при старте сегодня готова ${humanDate(bEarliest)} – ${humanDate(bLatest)}, к дате клиента успеваем; запустить не позже ${humanDate(bLatestStart)}. Эта дата — только для баннера: постоянная вывеска при любом дне задержки старта сдвигается на столько же рабочих дней.`
        : `Временная вывеска (баннер): ${TEMP_BANNER.productionMin}–${TEMP_BANNER.productionMax} раб. дн. + монтаж ${TEMP_BANNER.install} раб. дн. — к дате клиента тоже не успеваем (готова ${humanDate(bLatest)}).`
    };
  }

  const install = iMin === iMax ? `${iMin}` : `${iMin}–${iMax}`;
  const shiftNote = buffer < 0 ? ' Каждый рабочий день задержки старта сдвигает готовность постоянной вывески на рабочий день.' : '';
  const lastStartText = latestStart >= today
    ? `Последний день старта (согласования макета) с учётом монтажа ${iMax} дн. — ${humanDate(latestStart)}.`
    : `Последний день старта был ${humanDate(latestStart)}${latestStartBestCase >= today && latestStartBestCase !== latestStart ? ` (при монтаже за ${iMin} дн. — ${humanDate(latestStartBestCase)})` : ''}.`;

  return {
    today,
    client_deadline: clientDeadline,
    ready_by: readyBy,
    production_working_days: prod,
    install_working_days: install,
    if_start_today: {
      production_done: productionDone,
      installed_earliest: installedEarliest,
      installed_latest: installedLatest
    },
    latest_start_date: latestStart,
    buffer_working_days: buffer,
    status,
    temp_banner: tempBanner,
    summary:
      `Старт сегодня, ${humanDate(today)}: производство ${wdays(prod)} — до ${humanDate(productionDone)}, ` +
      `монтаж ${install} раб. дн. — готово ${iMin === iMax ? humanDate(installedLatest) : `${humanDate(installedEarliest)} – ${humanDate(installedLatest)}`}. ` +
      `Клиенту нужно к ${humanDate(clientDeadline)} (готово не позже ${humanDate(readyBy)}): ${verdict}. ${lastStartText}${shiftNote}` +
      (tempBanner ? ` ${tempBanner.summary}` : ''),
    rules: 'Считаются только рабочие дни (без выходных и праздников РФ). Даты готовности и последний день старта в касаниях — только из этого расчёта, сам не считай.'
  };
}

module.exports = {
  computeTimeline,
  isWorkingDay,
  addWorkingDays,
  subtractWorkingDays,
  workingDaysBetween,
  humanDate,
  HOLIDAYS,
  TEMP_BANNER
};

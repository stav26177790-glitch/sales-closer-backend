/**
 * engine/scheduleCheck.js — календарь касаний против сроков.
 *
 * Живой тест 2026-11-13 («Зерно»): касание 4 уходило «через 5 рабочих дней
 * после касания 1» (= 20 ноября), касание 5 — ещё через 3 (= 25 ноября), и оба
 * говорили «до 19 ноября успеем с баннером». К моменту отправки дата уже
 * прошла. Агенты пишут timing относительными днями и не сверяют с календарём.
 *
 * Поэтому:
 *  - агентам даётся календарь рабочих дней вперёд (workingDaysAhead);
 *  - composer пишет в timing календарную дату;
 *  - код находит касание, у которого дата отправки ПОЗЖЕ срока из расчёта
 *    (последний день старта, последний день запуска баннера, дата клиента),
 *    а текст называет этот срок как ещё не наступивший, — и не даёт его одобрить.
 */
const { addWorkingDays, humanDate } = require('./timeline');

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const DATE_RE = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join('|')})`, 'gi');
const NUM_DATE_RE = /\b(\d{1,2})\.(\d{1,2})(?:\.\d{2,4})?\b/g;

// Ближайшие рабочие дни: «1-й раб. день — 16 ноября (пн)» и т.д.
function workingDaysAhead(today, n = 15) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(`через ${i} раб. дн. — ${humanDate(addWorkingDays(today, i))}`);
  return out;
}

// «20 ноября» / «20.11» → ISO, год — ближайший к today (декабрь → январь следующего года).
function toIso(day, monthIdx, today) {
  const y = Number(today.slice(0, 4));
  const tm = Number(today.slice(5, 7)) - 1;
  const year = monthIdx < tm - 6 ? y + 1 : y;
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function datesIn(text, today) {
  const out = [];
  for (const m of String(text || '').matchAll(DATE_RE)) out.push(toIso(Number(m[1]), MONTHS.indexOf(m[2].toLowerCase()), today));
  for (const m of String(text || '').matchAll(NUM_DATE_RE)) {
    const mo = Number(m[2]) - 1;
    if (mo >= 0 && mo < 12 && Number(m[1]) >= 1 && Number(m[1]) <= 31) out.push(toIso(Number(m[1]), mo, today));
  }
  return out;
}

// Дата отправки касания: календарная дата в timing; «сегодня» — today;
// «через N рабочих дней» без даты — от today (нижняя оценка).
// «…после касания K» — отсчёт от даты касания K (known: номер → ISO).
function sendDate(timing, today, known = {}) {
  const t = String(timing || '');
  const explicit = datesIn(t, today);
  if (explicit.length) return explicit.sort().pop();
  if (/сегодня/i.test(t)) return today;
  const after = t.match(/после\s+касани[а-яё]*\s+(\d+)/i);
  const base = (after && known[Number(after[1])]) || today;
  const m = t.match(/через\s+(\d+)\s+(раб|д)/i);
  if (m) return addWorkingDays(base, Number(m[1]));
  if (/на следующий день|завтра/i.test(t)) return addWorkingDays(base, 1);
  return after && known[Number(after[1])] ? base : null;
}

// Сроки из расчёта, которые нельзя называть будущими после их наступления.
function deadlines(timeline) {
  if (!timeline || !timeline.today) return [];
  const out = [];
  if (timeline.latest_start_date && timeline.latest_start_date >= timeline.today) out.push(timeline.latest_start_date);
  if (timeline.temp_banner?.latest_start_date) out.push(timeline.temp_banner.latest_start_date);
  return [...new Set(out)];
}

// [{ touchpoint_number, fixes }] — касания, которые уходят после срока и называют его.
function findScheduleIssues(messages, timeline) {
  const dl = deadlines(timeline);
  if (!dl.length) return [];
  const today = timeline.today;
  const out = [];
  const known = {};
  (messages || []).forEach((m, i) => {
    const n = Number(m?.touchpoint_number ?? i + 1);
    const sent = sendDate(m?.timing, today, known);
    if (sent) known[n] = sent;
    if (!sent) return;
    const mentioned = new Set(datesIn([m?.subject, m?.body].filter(Boolean).join('\n'), today));
    const fixes = dl
      .filter((d) => sent > d && mentioned.has(d))
      .map((d) => `Касание уходит ${humanDate(sent)}, а в тексте срок ${humanDate(d)} — к отправке он уже пройдёт. Либо отправить касание не позже ${humanDate(d)} (поменять timing), либо убрать этот срок и честно говорить о реальной дате готовности на день отправки.`);
    if (fixes.length) out.push({ touchpoint_number: n, fixes });
  });
  return out;
}

// Касание с такой ошибкой — НА ДОРАБОТКУ поверх вердикта reviewer'а.
function applyScheduleCheck(reviewerOutput, messages, timeline) {
  const hits = findScheduleIssues(messages, timeline);
  if (!hits.length || !reviewerOutput || typeof reviewerOutput !== 'object') return { reviewerOutput, hits };
  const r = reviewerOutput.reviewer_output && !reviewerOutput.messages_reviewed ? reviewerOutput.reviewer_output : reviewerOutput;
  const reviewed = Array.isArray(r.messages_reviewed) ? r.messages_reviewed : (r.messages_reviewed = []);
  for (const h of hits) {
    let m = reviewed.find((x) => Number(x?.touchpoint_number) === h.touchpoint_number);
    if (!m) { m = { touchpoint_number: h.touchpoint_number }; reviewed.push(m); }
    if (m.verdict === 'ОДОБРЕНО' || !m.verdict) m.verdict = 'НА ДОРАБОТКУ';
    m.failed_criteria = [...new Set([...(m.failed_criteria || []), 'schedule'])];
    m.fix_instructions = [m.fix_instructions, ...h.fixes].filter(Boolean).join(' ');
  }
  if (r.verdict === 'ОДОБРЕНО' || !r.verdict) r.verdict = 'НА ДОРАБОТКУ';
  return { reviewerOutput, hits };
}

module.exports = { workingDaysAhead, findScheduleIssues, applyScheduleCheck, sendDate, datesIn };

// Дата клиента: «2026-12-01» (календарик) или как пишут люди — «01.12.2026», «1.12.26», «1.12»
// (без года — ближайшее будущее 1 декабря). Живой «Зерно 9» (15.11): календарик в браузере
// не принял ввод, дата молча терялась. Неверная дата → null.
function parseClientDate(v, today = new Date()) {
  const s = String(v || '').trim();
  let y, m, d;
  let r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (r) [y, m, d] = [r[1], r[2], r[3]].map(Number);
  else if ((r = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/))) {
    d = Number(r[1]); m = Number(r[2]);
    if (r[3]) y = r[3].length === 2 ? 2000 + Number(r[3]) : Number(r[3]);
    else {
      y = today.getUTCFullYear();
      const cand = Date.UTC(y, m - 1, d);
      if (cand < Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) y += 1;
    }
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

module.exports = { parseClientDate };

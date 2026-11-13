// Разбор JSON из ответа модели с починкой типовых поломок.
//
// Живой «Зерно 5» (2026-11-13, вечер): reviewer дважды вернул верный по смыслу
// ответ, но внутри строки написал прямые кавычки — «первую точку "Зерна"» — и
// JSON не разобрался. Код счёл, что проверка «не дала вердикт», writer переписал
// всё заново, менеджер получил «Проверка приняла не всё».
//
// Порядок: как есть → экранируем кавычки внутри строк. Оборванный ответ (лимит
// длины) намеренно НЕ «достраиваем»: недописанная стратегия хуже честного «не разобрался».

function stripFence(text) {
  const s = String(text || '').trim();
  const m = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  return (m ? m[1] : s).trim();
}

// Прямая кавычка внутри строки, которая не закрывает строку, экранируется.
// Закрывающая — та, после которой (через пробелы) идёт } ] : или конец, либо
// запятая, за которой следует начало следующего значения/ключа.
function escapeInnerQuotes(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (esc) { esc = false; out += ch; continue; }
    if (ch === '\\') { esc = true; out += ch; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch !== '"') { out += ch; continue; }
    let j = i + 1;
    while (j < s.length && /\s/.test(s[j])) j++;
    const next = s[j];
    let closes = next === undefined || next === '}' || next === ']' || next === ':';
    if (next === ',') {
      let k = j + 1;
      while (k < s.length && /\s/.test(s[k])) k++;
      closes = k >= s.length || /["{[\-\d]/.test(s[k]) || s.startsWith('true', k) || s.startsWith('false', k) || s.startsWith('null', k);
    }
    if (closes) { inStr = false; out += ch; } else out += '\\"';
  }
  return out;
}

function parseModelJson(text) {
  const body = stripFence(text);
  if (!body) return null;
  const attempts = [
    () => JSON.parse(body),
    () => JSON.parse(escapeInnerQuotes(body))
  ];
  for (const a of attempts) {
    try {
      const v = a();
      if (v && typeof v === 'object') return v;
    } catch { /* следующая попытка */ }
  }
  return null;
}

module.exports = { parseModelJson, escapeInnerQuotes, stripFence };

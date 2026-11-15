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

// Лишняя закрывающая скобка (живой «Зерно» на DeepSeek, 15.11): после каждого касания модель ставила
// лишнюю «}» — внутри массива messages. Скобка, которая не соответствует открытой (} при открытом [,
// ] при открытом {, или закрывающая без открытой), выбрасывается. Строки не трогаем.
function dropStrayClosers(s) {
  let out = '';
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); out += ch; continue; }
    if (ch === '}' || ch === ']') {
      const want = ch === '}' ? '{' : '[';
      if (stack[stack.length - 1] !== want) continue; // лишняя — выбрасываем
      stack.pop();
      out += ch;
      continue;
    }
    out += ch;
  }
  // запятая перед закрывающей скобкой, оставшаяся после выброса, — убираем
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseModelJson(text) {
  const body = stripFence(text);
  if (!body) return null;
  const attempts = [
    () => JSON.parse(body),
    () => JSON.parse(escapeInnerQuotes(body)),
    () => JSON.parse(dropStrayClosers(body)),
    () => JSON.parse(dropStrayClosers(escapeInnerQuotes(body)))
  ];
  for (const a of attempts) {
    try {
      const v = a();
      if (v && typeof v === 'object') return v;
    } catch { /* следующая попытка */ }
  }
  return null;
}

module.exports = { parseModelJson, escapeInnerQuotes, dropStrayClosers, stripFence };

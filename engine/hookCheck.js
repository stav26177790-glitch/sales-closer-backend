/**
 * engine/hookCheck.js — повод касания (владелец, 14.11, «Зерно 7»).
 *
 * Было: тип касания «экспертное / эмпатичное» — только метка в плане, а текст
 * обычный («Марина, хочу сказать кое-что важное…»). Владелец: касание
 * начинается с ПОВОДА, и повод делает его экспертным или эмпатичным:
 *   эмпатичное — «разбирался с ситуацией с подобной вывеской и вспомнил про вас»;
 *   экспертное — «проверял ваш дизайн-проект, увидел несоответствие по 902-ПП
 *                 и решил набрать — обсудить размещение на фасаде».
 * Менеджеры работают удалённо: повод — звонок на производство, разговор с
 * технологом / дизайнером / руководством, проверка макета, а не «заехал».
 *
 * Чтобы повод не был «ИИшным» и выдуманным, writer отдаёт у каждого касания:
 *   hook.quote   — деталь клиента дословно из переписки (на ней держится повод);
 *   hook.prep    — что менеджер делает перед касанием (5–15 минут, удалённо),
 *                  чтобы сказанное было правдой;
 *   hook.opening — фраза касания с поводом (с неё касание начинается).
 * Код проверяет: всё есть; цитата есть в переписке; касание начинается с
 * повода; подготовка — удалённая. Текст вдогонку «сразу после» звонка
 * повода не требует («как договорились»).
 */

const norm = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е')
  .replace(/[«»"'“”„.,!?:;()\[\]—–\-…/]/g, ' ').replace(/\s+/g, ' ').trim();

// Цитата есть в переписке: целиком или любые 4 слова подряд из неё.
function quoteInSource(quote, source) {
  const q = norm(quote);
  const src = norm(source);
  if (!q || q.length < 4 || !src) return false;
  if (src.includes(q)) return true;
  const w = q.split(' ');
  if (w.length < 4) return false;
  for (let i = 0; i + 4 <= w.length; i++) {
    if (src.includes(w.slice(i, i + 4).join(' '))) return true;
  }
  return false;
}

// Касание начинается с повода: первые слова opening — в начале текста
// (после приветствия и ремарок звонка «[Марина берёт трубку]»).
// Мягко (прогон 14.11: editor трижды не мог «попасть» в фразу у первого звонка ЛПР):
// приветствие и [заглушки] не считаем; достаточно любых 4 слов подряд из повода
// в начале текста (у звонка начало длиннее — ремарки и «удобно говорить?»).
const OPENING_ZONE = 900;
const GREETING_RE = /^(добрый (день|вечер)|здравствуйте|привет|доброе утро)\s*/;
function openingAtStart(opening, body) {
  const o = norm(String(opening || '').replace(/\[[^\]]*\]/g, ' ')).replace(GREETING_RE, '');
  const w = o.split(' ').filter(Boolean);
  if (!w.length) return false;
  const start = norm(String(body || '').replace(/\[[^\]]*\]/g, ' ')).slice(0, OPENING_ZONE);
  if (w.length < 4) return start.includes(w.join(' '));
  for (let i = 0; i + 4 <= Math.min(w.length, 12); i++) if (start.includes(w.slice(i, i + 4).join(' '))) return true;
  return false;
}

// Менеджеры работают удалённо — поводы «заехал / был на производстве» неправда.
const PHYSICAL_RE = /(заехал|заезжал|съездил|проезжал|был(а)? на (производстве|объекте|точке|фасаде)|заш[её]л в цех|посмотрел вживую|был(а)? у вас)/i;
const PHYSICAL_FIX = 'Менеджеры работают удалённо — не «заехал / был на производстве / проезжал мимо». Повод — звонок или разговор: «позвонил на производство», «разбирался с похожей вывеской», «обсуждали с руководством / технологом / дизайнером», «проверял ваш макет по 902-ПП».';

const isFollowUp = (m) => /сразу после|в тот же день после|после звонка/i.test(String(m?.timing || ''));

// [{ touchpoint_number, fixes: [..] }] — только касания с замечаниями.
function findHookIssues(messages, sourceText) {
  const out = [];
  (messages || []).forEach((m, i) => {
    const n = Number(m?.touchpoint_number ?? i + 1);
    const fixes = [];
    const body = String(m?.body || '');
    // «Заехал» в самом тексте ловит phraseCheck; здесь — в поводе и подготовке.
    if (isFollowUp(m)) { if (fixes.length) out.push({ touchpoint_number: n, fixes }); return; }
    const h = m?.hook && typeof m.hook === 'object' ? m.hook : null;
    const kind = /эмпат/i.test(String(m?.kind || '')) ? 'эмпатичное' : 'экспертное';
    if (!h || !String(h.quote || '').trim() || !String(h.opening || '').trim() || !String(h.prep || '').trim()) {
      fixes.push(`Нет повода касания. Касание ${kind === 'эмпатичное' ? 'эмпатичное — повод личный, «вспомнил про вас» (разбирался с похожей вывеской / звонил на производство по похожему заказу — и вспомнил про ваш проект)' : 'экспертное — повод: поработал над проектом клиента (позвонил на производство / технологу, проверил макет по 902-ПП, прикинул размер букв под фасад) и нашёл, что обсудить'}. Заполнить hook: quote — деталь клиента дословно из переписки, prep — что менеджер делает перед касанием (удалённо, 5–15 минут), opening — фраза с поводом, с неё начинается касание.`);
    } else {
      if (!quoteInSource(h.quote, sourceText)) fixes.push(`Повод держится на цитате, которой нет в переписке («${String(h.quote).slice(0, 80)}»). Взять деталь клиента дословно из переписки.`);
      if (!openingAtStart(h.opening, body)) fixes.push(`Касание должно начинаться с повода (сразу после обращения): «${String(h.opening).slice(0, 120)}».`);
      if (PHYSICAL_RE.test(String(h.prep)) || PHYSICAL_RE.test(String(h.opening))) { if (!fixes.includes(PHYSICAL_FIX)) fixes.push(PHYSICAL_FIX); }
    }
    if (fixes.length) out.push({ touchpoint_number: n, fixes });
  });
  return out;
}

// Накладывает проверку повода на вердикт (форма reviewer'а): касание — НА ДОРАБОТКУ.
function applyHookCheck(verdict, messages, sourceText) {
  const hits = findHookIssues(messages, sourceText);
  if (!hits.length || !verdict || typeof verdict !== 'object') return { verdict, hits };
  const reviewed = Array.isArray(verdict.messages_reviewed) ? verdict.messages_reviewed : (verdict.messages_reviewed = []);
  for (const h of hits) {
    let m = reviewed.find((x) => Number(x?.touchpoint_number) === h.touchpoint_number);
    if (!m) { m = { touchpoint_number: h.touchpoint_number }; reviewed.push(m); }
    m.verdict = 'НА ДОРАБОТКУ';
    m.code_checked = true;
    m.failed_criteria = [...new Set([...(m.failed_criteria || []), 'hook'])];
    m.fix_instructions = [m.fix_instructions, ...h.fixes].filter(Boolean).join(' ');
  }
  verdict.verdict = 'НА ДОРАБОТКУ';
  return { verdict, hits };
}

module.exports = { findHookIssues, applyHookCheck, quoteInSource, openingAtStart, PHYSICAL_RE };

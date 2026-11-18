/**
 * engine/notes.js — порядок в подсказках писателю на касание (`how`).
 *
 * Разбор 18.11 (причина 5 — «перегрузка писателя»): на одно касание код складывал до 3,7 тыс. символов
 * подсказок: два сценария с разным ходом, инструмент доверия, которому клиент уже не поверил, дубли
 * («кто проводит встречу на производстве» — и в заметке, и в карточке), follow-up, предвосхищение,
 * СОПРАНО и служебные пометки «(владелец 18.11, …)». Писатель выполнял одно и терял другое.
 *
 * Здесь — один проход после того, как все подсказки собраны:
 *   1. служебные пометки (кто и когда решил) убираются — писателю нужны ход и ссылка на файл методики;
 *   2. дубли и противоречия снимаются по правилам (DROP_IF);
 *   3. лимит на касание: сверх него отбрасываются самые необязательные подсказки (по приоритету).
 * Обязательные подсказки (сценарий, последний шанс, итог разговора, идея кружка, производство, Zoom) не режутся.
 */

// Приоритет: чем больше, тем важнее. keep — не отбрасывать по лимиту.
const KINDS = [
  { key: 'scenario', re: /^СЦЕНАРИЙ «/, prio: 10, keep: true },
  { key: 'last_chance', re: /^Последний шанс/, prio: 10, keep: true },
  { key: 'followup_real', re: /^FOLLOW-UP прошедшего/, prio: 9, keep: true },
  { key: 'torg_price', re: /^Цена клиента «/, prio: 9, keep: true },
  { key: 'krug_idea', re: /^ИДЕЯ ИЗ КРУЖКА/, prio: 8, keep: true },
  { key: 'krug', re: /^Кружок-интрига/, prio: 8, keep: true },
  { key: 'production_goal', re: /^Через выгоду ЛПР.*производств/, prio: 8, keep: true },
  { key: 'zoom_meeting', re: /^СЦЕНАРИЙ ZOOM/, prio: 8, keep: true },
  { key: 'zoom_invite', re: /^ПРИГЛАШЕНИЕ В ZOOM/, prio: 7, keep: true },
  { key: 'followup_call', re: /^FOLLOW-UP после звонка/, prio: 7, keep: true },
  { key: 'followup', re: /^FOLLOW-UP/, prio: 6, keep: true },
  { key: 'meeting_after', re: /^Итог ЭТОЙ встречи/, prio: 6 },
  { key: 'zoom_moscow', re: /^Москва: в подготовке/, prio: 5 },
  { key: 'production_who', re: /^Встречу на производстве проводит/, prio: 5 },
  { key: 'production_big', re: /^Личная встреча с менеджером/, prio: 4 },
  { key: 'trust_tool', re: /^Инструмент доверия этого касания/, prio: 4 },
  { key: 'ldpr', re: /^ЛДПР/, prio: 3 },
  { key: 'soprano', re: /^СОПРАНО/, prio: 2 },
  { key: 'pre', re: /^ПРЕДВОСХИЩЕНИЕ/, prio: 1 }
];
function kindOfNote(text) {
  const t = String(text || '').trim();
  return KINDS.find((k) => k.re.test(t)) || { key: 'other', prio: 5 };
}

// Служебная пометка внутри скобок: кто и когда решил, откуда правило. Ссылка на файл методики остаётся.
const PROVENANCE_RE = /владел|экзамен|разбор|живо[йм]|шероховат|прогон|правило \d|\b\d{1,2}\.11\b|«как сделать 10»/i;
function stripProvenance(text) {
  return String(text || '').replace(/\s*\(([^()]*)\)/g, (all, inner) => {
    if (!PROVENANCE_RE.test(inner)) return all;
    const keep = inner.split(/[,;]\s*/).map((s) => s.trim()).filter((s) => s && !PROVENANCE_RE.test(s));
    return keep.length ? ` (${keep.join(', ')})` : '';
  }).replace(/\s{2,}/g, ' ').trim();
}

// Дубли и противоречия: подсказку убираем, если в касании уже есть то, что её перекрывает.
const DROP_IF = {
  // Кто проводит встречу на производстве — уже сказано в карточке / цели / идее кружка.
  production_who: (others) => others.some((o) => /заведующ/i.test(o.text)),
  // Инструмент доверия в касании-отстройке или приглашении на производство — второй довод, спорит с «показать делом».
  trust_tool: (others, step) => others.some((o) => o.key === 'production_goal' || o.key === 'krug_idea')
    || (step.scenarios || []).some((s) => s === 'why_us' || s === 'negative' || s === 'want_see')
    || !!step.production_meeting,
  // Предвосхищение — к сценариям «дорого / я подумаю / просто цену / почему мы»; в негативе не к месту, после тишины
  // касание начинается с «мы договаривались…» — второй вход в начале лишний.
  pre: (others, step) => (step.scenarios || []).some((s) => s === 'negative' || s === 'think_silence')
};

const MAX_HOW = 2200; // символов подсказок на касание (замер 18.11: было до 3 700)

// notes — массив строк how одного касания; step — касание плана (scenarios, production_meeting).
function compactNotes(notes, step = {}) {
  let items = [];
  for (const raw of [].concat(notes || [])) {
    const text = stripProvenance(raw);
    if (!text || items.some((x) => x.text === text)) continue;
    const k = kindOfNote(text);
    items.push({ text, key: k.key, prio: k.prio, keep: !!k.keep });
  }
  const dropped = [];
  items = items.filter((x) => {
    const rule = DROP_IF[x.key];
    const others = items.filter((o) => o !== x);
    if (rule && rule(others, step)) { dropped.push(x.key); return false; }
    return true;
  });
  const size = () => items.reduce((s, x) => s + x.text.length + 1, 0);
  while (size() > MAX_HOW) {
    const cut = items.filter((x) => !x.keep).sort((a, b) => a.prio - b.prio)[0];
    if (!cut) break;
    items = items.filter((x) => x !== cut);
    dropped.push(cut.key);
  }
  // Порядок для писателя: сначала главное (ход касания), потом детали.
  items.sort((a, b) => b.prio - a.prio);
  return { notes: items.map((x) => x.text), dropped };
}

module.exports = { compactNotes, stripProvenance, kindOfNote, MAX_HOW };

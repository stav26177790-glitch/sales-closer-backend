/**
 * engine/phraseCheck.js — программная проверка касаний на запрещённые фразы.
 *
 * Reviewer — модель и иногда пропускает то, что прямо запрещено правилами
 * (живой тест 2026-11-12: «сроки зависят только от нас» рядом с опозданием
 * одобрялось несколько раундов подряд). Эти фразы ловим кодом: касание с ними
 * не может быть одобрено и не сохраняется «как одобренное» при доработке.
 */
const BANNED = [
  {
    re: /зависит только от нас|зависят только от нас/i,
    fix: 'Убрать «сроки зависят только от нас» — рядом с опозданием звучит как признание вины. Вместо: «от поставщиков не зависим — дату, которую назвали, держим».'
  },
  {
    re: /гарантированн(о|ый|ая) (успе|сдел|смонтир|будет)|точно успеем|успеем на 100|100\s?% успе/i,
    fix: 'Убрать обещание «гарантированно / точно успеем» — сроки только из расчёта, без гарантий.'
  },
  {
    // Владелец 2026-11-13: просьба прислать обещанное — по его шаблону, без упрёка.
    re: /вы (же )?(говорили|обещали|писали|сказали),? что (при|вы)?шл[её]те|(как )?вы обещали/i,
    fix: 'Убрать упрёк «вы говорили / обещали, что пришлёте». По шаблону владельца: «Помните, мы проговаривали, что пришлёте [что]? Скинете сейчас — [что мы сразу сделаем], и вы получите [результат для клиента]».'
  },
  {
    re: /отдадим (ваш )?слот|слот (уйд|займ)[её]т друг|отдадим другому/i,
    fix: 'Убрать угрозу отдать слот другому — слот подаётся как забота о дате клиента.'
  }
];

function touchText(m) {
  return [m?.subject, m?.body, m?.attachment?.content].filter(Boolean).join('\n');
}

// [{ touchpoint_number, fixes: [..] }] — только касания с нарушениями.
function findBannedPhrases(messages) {
  const out = [];
  (messages || []).forEach((m, i) => {
    const text = touchText(m);
    const fixes = BANNED.filter((b) => b.re.test(text)).map((b) => b.fix);
    if (fixes.length) out.push({ touchpoint_number: Number(m?.touchpoint_number ?? i + 1), fixes });
  });
  return out;
}

// Накладывает программную проверку на ответ reviewer'а: касание с запрещённой
// фразой — НА ДОРАБОТКУ, общий вердикт — не ОДОБРЕНО.
function applyPhraseCheck(reviewerOutput, messages) {
  const hits = findBannedPhrases(messages);
  if (!hits.length || !reviewerOutput || typeof reviewerOutput !== 'object') return { reviewerOutput, hits };
  const r = reviewerOutput.reviewer_output && !reviewerOutput.messages_reviewed ? reviewerOutput.reviewer_output : reviewerOutput;
  const reviewed = Array.isArray(r.messages_reviewed) ? r.messages_reviewed : (r.messages_reviewed = []);
  for (const h of hits) {
    let m = reviewed.find((x) => Number(x?.touchpoint_number) === h.touchpoint_number);
    if (!m) { m = { touchpoint_number: h.touchpoint_number }; reviewed.push(m); }
    if (m.verdict === 'ОДОБРЕНО' || !m.verdict) m.verdict = 'НА ДОРАБОТКУ';
    m.failed_criteria = [...new Set([...(m.failed_criteria || []), 'client_value'])];
    m.fix_instructions = [m.fix_instructions, ...h.fixes].filter(Boolean).join(' ');
  }
  if (r.verdict === 'ОДОБРЕНО' || !r.verdict) r.verdict = 'НА ДОРАБОТКУ';
  return { reviewerOutput, hits };
}

module.exports = { findBannedPhrases, applyPhraseCheck, BANNED };

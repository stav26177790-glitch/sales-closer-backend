/**
 * engine/diagnosticCleanup.js — правила владельца для текста оценки, кодом.
 *
 * Живые «Зерно 4» и «Зерно 5» (2026-11-13): в выводе оценки дважды было
 * «предложить Андрею напрямую, не через Марину» — совет обойти контактное
 * лицо. Оценка советов не даёт, а выход на ЛПР — только с согласия
 * контактного лица. Инструкцией это не удержалось → убираем кодом.
 * Заодно старое «срочность» в выводе → «ЗС (здесь и сейчас)».
 */
// Предложение с советом обойти контактное лицо.
const BYPASS_RE = /(не через\s+[А-ЯЁ][а-яё]+|в обход\s+[А-ЯЁа-яё]+|напрямую,?\s+минуя|минуя\s+[А-ЯЁ][а-яё]+)/;

function splitSentences(text) {
  return String(text || '').match(/[^.!?\n]+[.!?]*\n*|\n+/g) || [];
}

function cleanSummary(text) {
  if (!text) return { text, removed: 0 };
  let removed = 0;
  let out = splitSentences(text).filter((s) => {
    if (BYPASS_RE.test(s)) { removed++; return false; }
    return true;
  }).join('');
  // «через Марину или напрямую» → с согласия
  out = out.replace(/или напрямую(?![^.]*соглас)/g, () => { removed++; return 'или напрямую — с её согласия'; });
  out = out.replace(/(блокер|фактор)\s+—\s+срочность/gi, '$1 — ЗС (здесь и сейчас)');
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), removed };
}

function cleanDiagnostic(diag) {
  if (!diag || typeof diag !== 'object' || typeof diag.diagnostic_summary !== 'string') return 0;
  const { text, removed } = cleanSummary(diag.diagnostic_summary);
  diag.diagnostic_summary = text;
  if (removed) console.warn(`[diagnosticCleanup] Убраны советы обойти контактное лицо: ${removed}`);
  return removed;
}

// СОПРАНО «О — Ограничения» (владелец, 14.11): бюджет менеджер должен был выяснить,
// но получается не всегда. Если в переписке возражение по цене, а среди рекомендаций
// нет бюджета — добавляем рекомендацию кодом (она ведёт к ответу на «дорого»).
const PRICE_OBJECTION_RE = /(дорог|дороговат|дешевле|не укладыва|бюджет(а)? не хват|предлагают за|у других (дешевле|за))/i;
function ensureBudgetRecommendation(diag, sourceText) {
  if (!diag || typeof diag !== 'object') return false;
  if (!PRICE_OBJECTION_RE.test(String(sourceText || ''))) return false;
  // Клиент уже назвал цифру («у других 480», «давайте 550») — ориентир есть, рекомендация «уточнить бюджет» лишняя
  // (симулятор 16.11 «Дента Плюс»).
  if (/(давайте|хотя бы|за|предлагают|нашли|бюджет|рассчитыва[а-яё]*)[^.!?\n]{0,25}\d{2,3}\s*(тыс|000|к\b)|\d{2,3}\s*тысяч/i.test(String(sourceText || ''))) return false;
  const recs = Array.isArray(diag.soprano_recommendations) ? diag.soprano_recommendations : [];
  if (recs.some((r) => /бюджет|сколько заложил|ориентир по (цене|стоимости)/i.test(String(r)))) return false;
  const rec = 'Бюджет (СОПРАНО: Ограничения): клиент говорит о цене — уточнить ориентир по бюджету и с чем сравнивает. ' +
    '«Чтобы предложить подходящий вариант — какой бюджет заложили на вывеску и с чем сравниваете?» ' +
    'Без этого ответ на «дорого» — гадание; скидку не предлагать.';
  diag.soprano_recommendations = [rec, ...recs].slice(0, 3);
  return true;
}

// СОПРАНО «А — Аналоги» (владелец, 14.11): «на этапе СОПРАНО менеджер должен уточнить об
// альтернативах — это даёт ему преимущество при отработке возражений», «должен был заранее»
// (до КП). Не собрано —
// добавляем рекомендацию кодом: что клиент готов изменить, если бюджет не сойдётся, и с чем
// сравнивает. Это задел для «дорого»: альтернативы (логика компромисса) клиент назвал сам.
function ensureAlternativesRecommendation(diag) {
  if (!diag || typeof diag !== 'object') return false;
  const a = diag.soprano && typeof diag.soprano === 'object' ? diag.soprano['А'] : null;
  if (a && /^собран/i.test(String(a.status || ''))) return false;
  const recs = Array.isArray(diag.soprano_recommendations) ? diag.soprano_recommendations : [];
  if (recs.some((r) => /альтернатив|пожертвова|можно (изменить|упростить)|готов[ы]? (изменить|поменять)/i.test(String(r)))) return false;
  const rec = 'Альтернативы (СОПРАНО: Аналоги): это нужно было выяснить заранее, до КП — не выяснено, уточнить сейчас: что клиент готов изменить, если бюджет не сойдётся, и с чем ещё сравнивает. ' +
    '«Если по бюджету не сойдётся — что для вас важно сохранить обязательно, а чем можно пожертвовать: размером, подсветкой, материалом?» ' +
    'Это задел для ответа на «дорого»: альтернативы клиент назовёт сам.';
  // Бюджет (если есть) — первым, альтернативы — вторыми.
  const budgetFirst = recs.length && /бюджет/i.test(String(recs[0])) ? [recs[0], rec, ...recs.slice(1)] : [rec, ...recs];
  diag.soprano_recommendations = budgetFirst.slice(0, 3);
  return true;
}

// Оценки по явным фактам (владелец 15.11, живой прогон «Fresh Bowl»): модель держала Риск там,
// где клиент прямо показал обратное.
// — ФВ: «сделаете на 20% дешевле — подпишем сразу» = деньги есть (± цена − N%) → Подтверждено.
// — ЛПР: ЛПР назван и вышел на прямой контакт («Сергей готов созвониться», «созвонились в Zoom:
//   Сергею…») → Подтверждено.
// — Д: «понравились наши работы», «устраивает» → минимум Вероятно.
// Не поднимаем, если после факта — отказ («выбрали других», «передумали», «денег нет»).
const RANK = { 'Риск': 0, 'Неизвестно': 1, 'Вероятно': 2, 'Подтверждено': 3 };
const BARGAIN_BUY_RE = /(сделаете|сделайте|скинете|скиньте|уступите|дадите|снизите|будет)[^.!?\n]{0,40}(на \d+|\d+\s*%|процент|дешевле|скидк)[^.!?\n]{0,50}(закаж|подпиш|бер[её]м|возьм|оплат|заключ|договорились)|(закаж|подпиш|бер[её]м|возьм|заключ)[^.!?\n]{0,30}если[^.!?\n]{0,40}(скидк|дешевле|\d+\s*%)/i;
const TRUST_RE = /(понравил\w*|устраива\w*|впечатлил\w*)[^.!?\n]{0,30}(наш|ваш|работ|кейс|предложени|визуализац|макет)/i;
const NEG_RE = /(выбрали других|выбрали друг|ушли к|отказал\w*|передумал\w*|денег нет|бюджет(а)? нет|бюджет урезал|не будем заказ|не актуальн)/i;
const LPR_NAME_RE = /(?:[Рр]ешени[ея][^.!?\n]{0,60}?принима[а-яё]+|ЛПР[^.!?\n]{0,10}?|[Рр]ешает)\s+(?:собственник|директор|владел[а-яё]*|руководител[а-яё]*|сам[аи]?)?\s*([А-ЯЁ][а-яё]{2,})/;
const BUDGET_NUM_RE = /бюджет[^.!?\n]{0,40}?(\d{2,3}(?:[\s\u00a0]?\d{3})?)\s*(тыс[а-яё]*|к(?![а-яё])|000|₽|руб)/i;
const KP_SUM_RE = /КП[^.!?\n]{0,25}?(\d{2,3}(?:[\s\u00a0]?\d{3})?)\s*(тыс[а-яё]*|₽|руб)/i;
const NO_MONEY_RE = /(денег нет|нет денег|бюджета нет|нет бюджета|заморож|бюджет (урезали|сократили|сняли))/i;
const LPR_KNOWN_RE = /(отвечает за (деньги|бюджет|финанс)|по деньгам решает|решает (он|она)(?![а-яё])|решение (за ним|за ней|принимает (он|она))|деньги (решает|на) [А-ЯЁ])/i;
const LPR_BLOCK_RE = /(не дам[а-яё]* (его |её |ее )?(контакт|телефон|номер)|(ему|ей) (не надо|не нужно|не стоит) (звонить|писать)|напрямую (не|нельзя)|не выходите на)/i;
const CONTACT_RE = /(созвон\w*|zoom|зум|встрет\w*|встреч\w*|поговорил\w*|переговорил\w*|на связь|позвонил\w*|звонок)/i;
function raise(diag, key, to, why) {
  const sc = diag?.scores?.[key];
  if (!sc || typeof sc !== 'object') return false;
  if ((RANK[sc.status] ?? 1) >= RANK[to]) return false;
  sc.status = to;
  sc.evidence = [why, ...(Array.isArray(sc.evidence) ? sc.evidence : [])].slice(0, 5);
  return true;
}
function afterIs(text, idx, re) { return idx >= 0 && re.test(text.slice(idx)); }
// Принцип (владелец 15.11: «бери в работу не шлифовку, а сам принцип»): путь = разрыв между тем,
// что УЖЕ случилось, и закрытием. Факты клиента двигают оценку, а стратег получает список
// «уже случилось» (deal_events) — не планирует это заново, строит следующий шаг от итога.
const MEETING_RE = /(созвонились|встретились|провели (zoom|зум|встречу|созвон)|был[аи]? на встрече|поговорили (с|в)|переговорили)/i;
const sentenceAt = (t, idx) => {
  const start = Math.max(t.lastIndexOf('\n', idx), t.lastIndexOf('. ', idx)) + 1;
  const endRel = t.slice(idx).search(/[.!?\n]/);
  return t.slice(start, endRel < 0 ? undefined : idx + endRel + 1).trim().slice(0, 180);
};
// СОПРАНО по фактам переписки (владелец 16.11): негативный опыт с прошлым подрядчиком — это Опыт и
// Проблемы (собрано); появилась альтернатива (другой подрядчик, «у других дешевле») — Аналоги (собрано).
const NEG_EXPERIENCE_RE = /(обожгл[а-яё]*|подв[её]л[а-яё]*|подвели|погасл[а-яё]*|перестал[а-яё]* брать трубку|пропал[а-яё]*|негативн[а-яё]* опыт|плох[а-яё]* опыт|кинул[а-яё]*|сорвал[а-яё]* срок)/i;
const ALTERNATIVE_RE = /(други[ея] (предлага|компани|подрядчик)|у других|конкурент[а-яё]*|ещё (одн[а-яё]* )?(компани|подрядчик|вариант)|дешевле у|предлагают (на \d+\s*% дешевле|за \d)|нашли за \d|сравнива[а-яё]* с)/i;
// Клиент сам назвал, чем заменить / что упростить (живой тест 18.11: «давайте без подсветки, или баннер сами повесим
// за 15 тысяч») — Аналоги собраны: альтернативы клиент уже назвал, спрашивать «чем пожертвовать?» поздно.
const OWN_ALTERNATIVE_RE = /(давайте[^.!?\n]{0,30}без (подсветк|монтаж)|без подсветки[^.!?\n]{0,20}(давайте|можно|сделаем)|(баннер|наклейк|плёнк|пленк|печать)[^.!?\n]{0,40}(сами|за \d)|сами (повесим|смонтируем|поставим|сделаем)|а если (без|попроще|поменьше)|попроще вариант|вариант подешевле)/i;
// Ограничения: бюджет назван цифрой и есть дата клиента.
const LIMIT_BUDGET_RE = /бюджет[^.!?\n]{0,40}?\d/i;
const LIMIT_DATE_RE = /(открыти[ея]|открываемся|нужно к|к \d{1,2}[ .](декабр|январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|\d))/i;
function markSoprano(diag, key, note) {
  if (!diag.soprano || typeof diag.soprano !== 'object') return false;
  const cur = diag.soprano[key];
  if (cur && /^собран/i.test(String(cur.status || ''))) return false;
  diag.soprano[key] = { ...(cur && typeof cur === 'object' ? cur : {}), status: 'собрано', note };
  return true;
}
const sentenceOf = (t, idx) => {
  if (idx < 0) return '';
  const start = Math.max(t.lastIndexOf('\n', idx), t.lastIndexOf('. ', idx)) + 1;
  const endRel = t.slice(idx).search(/[.!?\n]/);
  return t.slice(start, endRel < 0 ? undefined : idx + endRel).trim().slice(0, 160);
};
function ensureSopranoFromFacts(diag, sourceText) {
  const t = String(sourceText || '');
  if (!diag || typeof diag !== 'object' || !t) return [];
  const out = [];
  if (NEG_EXPERIENCE_RE.test(t)) {
    if (markSoprano(diag, 'О1', 'негативный опыт с прошлым подрядчиком')) out.push('О1');
    if (markSoprano(diag, 'П', 'проблема — страх повторения прошлого негативного опыта')) out.push('П');
  }
  if (ALTERNATIVE_RE.test(t) && markSoprano(diag, 'А', 'клиент сравнивает с другим подрядчиком / вариантом')) out.push('А');
  else if (OWN_ALTERNATIVE_RE.test(t) && markSoprano(diag, 'А', 'клиент сам назвал, чем заменить / что упростить')) {
    out.push('А');
    const q = sentenceOf(t, t.search(OWN_ALTERNATIVE_RE));
    const msk = /москв|м\.\s?[А-ЯЁ]|902/i.test(t) && /без подсветк|баннер/i.test(q);
    const rec = `Клиент сам назвал, что готов упростить: «${q}». Выяснить, что стоит за «дорого» — жёсткий потолок бюджета или непонятно, за что платить; предложить упрощение, которое не ломает результат, с честным риском отхода от ТЗ` +
      (msk ? '. В Москве буквы без подсветки и баннер на фасаде — нельзя по 902-ПП: сказать как защиту от штрафа и демонтажа, временная вывеска — только внутри.' : '.');
    if (Array.isArray(diag.soprano_recommendations)) diag.soprano_recommendations = [rec, ...diag.soprano_recommendations];
  }
  if (LIMIT_BUDGET_RE.test(t) && LIMIT_DATE_RE.test(t) && markSoprano(diag, 'О2', 'бюджет назван, дата клиента известна')) out.push('О2');
  // Рекомендация «Аналоги: уточнить» больше не нужна, если Аналоги собраны.
  if (out.includes('А') && Array.isArray(diag.soprano_recommendations))
    diag.soprano_recommendations = diag.soprano_recommendations.filter((r) => !/СОПРАНО: Аналоги|други[ех] (вариант|компани)|с чем (ещё |еще )?сравнива|чем (можно )?пожертвова/i.test(String(r))).slice(0, 3);
  return out;
}

function ensureEvidenceScores(diag, sourceText, timeline) {
  const t = String(sourceText || '');
  if (!diag || typeof diag !== 'object' || !diag.scores || !t) return [];
  const changed = [];
  const events = [];
  const b0 = t.search(BARGAIN_BUY_RE);
  if (b0 >= 0 && !afterIs(t, b0, NEG_RE)) events.push(`Клиент торгуется с условием покупки: «${sentenceAt(t, b0)}» — деньги есть (ориентир ≈ цена КП минус процент). Дальше — не доказывать заново, а голосом через полномочия: небольшая уступка только в обмен на подписание / оплату.`);
  const mt = t.search(MEETING_RE);
  if (mt >= 0) events.push(`Встреча / созвон уже состоялись: «${sentenceAt(t, mt)}» — не предлагать эту встречу заново как первую; следующее касание — от её итога (что сказали, что мешает решить).`);
  const tr0 = t.search(TRUST_RE);
  if (tr0 >= 0 && !afterIs(t, tr0, NEG_RE)) events.push(`Клиенту понравилось: «${sentenceAt(t, tr0)}» — не повторять тот же набор доказательств (кейс + гарантии + «чем мы лучше»).`);
  const b = t.search(BARGAIN_BUY_RE);
  if (b >= 0 && !afterIs(t, b, NEG_RE) && raise(diag, 'financial', 'Подтверждено',
    'Клиент назвал условие покупки через скидку — деньги есть, ориентир ≈ цена КП минус названный процент (торг — сигнал к покупке)')) changed.push('financial');
  const nm = t.match(LPR_NAME_RE)?.[1];
  if (nm) {
    const stem = nm.slice(0, Math.max(4, nm.length - 2));
    const sent = t.split(/(?<=[.!?\n])/).map((x, i) => ({ x, i })).filter(({ x }) => x.includes(stem) && CONTACT_RE.test(x) && !LPR_NAME_RE.test(x));
    if (sent.length && !NEG_RE.test(t.slice(t.indexOf(sent[sent.length - 1].x)))) {
      events.push(`ЛПР (${nm}) уже на прямом контакте: «${sent[sent.length - 1].x.trim().slice(0, 180)}» — не планировать выход на него через посредника; касания — к его решению.`);
      if (raise(diag, 'authority', 'Подтверждено', `ЛПР (${nm}) вышел на прямой контакт с менеджером`)) changed.push('authority');
    }
  }
  // Владелец 18.11 (живой тест «Гибкость»): «бюджет до 100 тыс.» при КП 128 — деньги есть, сумма не сошлась:
  // ФВ «Вероятно», а не «Риск». Риск — «денег нет», заморозка, разрыв в разы.
  const bud = t.match(BUDGET_NUM_RE);
  if (bud && !NEG_RE.test(t) && !NO_MONEY_RE.test(t)) {
    const toRub = (x, unit) => { const n = Number(String(x).replace(/\s/g, '')); return /тыс|к$/i.test(unit || '') || n < 1000 ? n * 1000 : n; };
    const budget = toRub(bud[1], bud[2]);
    const kpM = t.match(KP_SUM_RE);
    const kp = kpM ? toRub(kpM[1], kpM[2]) : null;
    if (budget > 0 && (!kp || kp <= budget * 1.6) && raise(diag, 'financial', 'Вероятно',
      `Бюджет назван (${Math.round(budget / 1000)} тыс.)${kp && kp > budget ? ` — ниже КП (${Math.round(kp / 1000)} тыс.): деньги есть, сумма не сошлась — вопрос ценности и вариантов, не отсутствия денег` : ''}`)) changed.push('financial');
  }
  // ЛПР назван по имени / роли, контакт сотрудничает (передаёт, присылает данные) — ЛПР определён, выхода пока нет:
  // «Вероятно», а не «Риск» (владелец 18.11). Риск — ЛПР неизвестен, контакт блокирует выход, ЛПР месяцами не появляется.
  if (LPR_KNOWN_RE.test(t) && !LPR_BLOCK_RE.test(t) && raise(diag, 'authority', 'Вероятно',
    'ЛПР определён (назван контактом), контакт сотрудничает — выхода на ЛПР пока нет; путь — через контакт, аккуратно')) changed.push('authority');
  const tr = t.search(TRUST_RE);
  if (tr >= 0 && !afterIs(t, tr, NEG_RE) && raise(diag, 'trust', 'Вероятно', 'Клиенту понравились наши работы / предложение')) changed.push('trust');
  // Д открыт, клиент прогрет (деньги есть / ЛПР на связи) → встреча на производстве (владелец 15.11).
  // Прогрет — по событиям (торг с условием, ЛПР на связи, встреча была, «понравилось»), а не по
  // оценке модели: «бюджет 200 тыс.» в первом сообщении — ещё не прогрев (владелец: «довести, прогреть»).
  const stOf = (k) => String(diag.scores?.[k]?.status || '');
  const warm = events.length > 0;
  if (diag.scores.trust && typeof diag.scores.trust === 'object') delete diag.scores.trust.next_step;
  if (warm && !/подтвержд/i.test(stOf('trust')) && diag.scores.trust && typeof diag.scores.trust === 'object') diag.scores.trust.next_step = 'production';
  if (warm && !/подтвержд/i.test(stOf('trust')))
    events.push('Открыт главный критерий — Д. Клиент прогрет (деньги есть / ЛПР на связи) — сильнейший шаг доверия: пригласить ЛПР на встречу на нашем производстве — через его выгоду: своими глазами увидит, кто и как делает его вывеску и как ОТК проверяет её до отгрузки на неисправности и соответствие ТЗ, и решит без риска повторить прошлый опыт. Кейсы и «чем мы лучше» заново не повторять.');
  // ЗС: клиент назвал дату, а запас 10 рабочих дней и меньше — «СРОК БЛИЗКО» (не путать с «срок горит» ≤ 5 раб. дн.
  // в touchPlan — там другая ситуация: касания чаще; владелец 16.11: «разные пороги, называем по-разному»). (владелец 15.11: «ЗС тоже
  // есть, сроки же горят — хотя это можно проверить вопросом к клиенту»).
  const tl = timeline && typeof timeline === 'object' ? timeline : null;
  // «не успеваем» / «дата прошла» — ЗС не закрыт: нужна новая договорённость (временная вывеска, новая дата).
  if (tl && (tl.status === 'впритык' || (tl.status === 'с запасом' && Number(tl.buffer_working_days) <= 10))) {
    if (raise(diag, 'urgency', 'Подтверждено', `Срок близко: ${tl.status}${tl.buffer_working_days != null ? `, запас ${tl.buffer_working_days} раб. дн.` : ''}`)) changed.push('urgency');
    events.push('ЗС закрыт — срок близко (дата клиента, запас ≤ 10 рабочих дней): отдельных касаний на срочность не тратить — одним вопросом сверить «дата открытия в силе?» и держать слот как заботу о дате.');
  }
  if (events.length) diag.deal_events = events; else delete diag.deal_events;
  return changed;
}

module.exports = { cleanDiagnostic, cleanSummary, ensureBudgetRecommendation, ensureAlternativesRecommendation, ensureEvidenceScores, ensureSopranoFromFacts };

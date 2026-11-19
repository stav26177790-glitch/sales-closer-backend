/**
 * engine/touchPlan.js — план касаний считает КОД, агент только пишет текст.
 *
 * Перестройка 2026-11-13 (владелец: «Клоузер должен сам выдать классный
 * результат»). Раньше composer сам решал даты отправки, какие сроки ещё
 * актуальны на день отправки, где кружок, куда положить обязательный пункт —
 * и ошибался; код ловил ошибки после, по кругу, 3–6 минут.
 *
 * Теперь стратегия отдаёт шаги (`touchpoint_sequence`: кому, цель, тип,
 * канал, через сколько рабочих дней или при каком условии), а код:
 *   - считает дату отправки по рабочему календарю;
 *   - для каждого касания готовит ФАКТЫ на день отправки: когда будет готово
 *     при старте в этот день, актуальна ли ещё временная вывеска;
 *   - чинит чередование экспертное / эмпатичное (вставляет кружок);
 *   - раскладывает пункты «Обязательно в касаниях» по касаниям.
 * Writer пишет по этому плану; канал, дата и тип после него закрепляются кодом.
 */
const { addWorkingDays, humanDate, computeTimeline, isWorkingDay } = require('./timeline');
const { compactNotes } = require('./notes');
// Тексты подсказок и целей — справочник engine/notesText.js (аудит 18.11).
const {
  PRODUCTION_GOAL, PRODUCTION_BIG_NOTE, LDPR_NOTE, ZOOM_MEETING_NOTE, ZOOM_MOSCOW_NOTE, ZOOM_INVITE_NOTE, FOLLOWUP_NOTE, FOLLOWUP_IN_CALL_NOTE, FOLLOWUP_REAL_NOTE, KRUG_IDEA_NOTE, KRUG_IDEA_FAR_NOTE, SOPRANO_Q, PRODUCTION_WHO_NOTE, TRUST_SHORT, TRUST_TOOLS, LAST_CHANCE_SHORT, LAST_CHANCE_GOAL, ARGUMENT_ANGLES
} = require('./notesText');
const { MOSCOW_RE, NOT_MOSCOW_RE } = require('./geo');

const DEFAULT_DAYS = [0, 1, 3, 5, 8, 11, 15];

// Формула 100% закрытия (владелец 14.11, «Зерно 7»: «Клоузер бьёт только по ЛПР»).
// Каждый критерий, который ещё не «Подтверждено», двигает хотя бы одно касание.
// Ключи оценки — прежние (diagnostic_output.scores).
const CRITERIA = {
  ФВ: { key: 'financial', label: 'ФВ — финансовая возможность',
    goal: 'Снять вопрос денег персональным предложением: что стоит за ценой (бюджет, с чем сравнивают), что входит в цену КП; при «дорого» — варианты под бюджет с честным «это отход от ТЗ, вот риск». Скидку сами не предлагаем и сопротивляемся ей; если клиент ожил и торгуется («сделаете на N% — закажу») — голосом, через полномочия, небольшая уступка только в обмен на решение (файл 28).' },
  ОП: { key: 'need', label: 'ОП — осознанная потребность',
    goal: 'Укрепить потребность: что клиент получает с вывеской к своей дате — через его триггер.' },
  ЛПР: { key: 'authority', label: 'ЛПР — определён',
    goal: 'Дать контактному лицу готовый материал для ЛПР или предложить короткий совместный звонок — только с его согласия.' },
  Д: { key: 'trust', label: 'Д — доверие',
    goal: 'Добавить доверия через КЕЙС, в котором клиент увидит себя: под его слова (бюджет → бюджетный, качество → металл, «как на первой точке» → та же конструкция) и тот же тип бизнеса — из кейсов компании (файл отрасли): название, что сделали, где посмотреть.' },
  ЗС: { key: 'urgency', label: 'ЗС — здесь и сейчас',
    goal: 'Перевести в «здесь и сейчас» как заботу о планах клиента: сроки на день отправки, предложить забронировать слот на производстве, один конкретный шаг (Давайте / Чтобы / Если / То).' }
};
// Крупный проект (от 500 тыс.): менеджер может приехать сам — на производство или на объект клиента
// (владелец 16.11: «сильный шаг, но затратный»).
const BIG_DEAL = 500000;
// Zoom (владелец 17.11, knowledge/29_zoom.md): касание «Zoom» — сценарий встречи с подготовкой, касание с
// приглашением в Zoom — по скелету приглашения. В «Сулико» Zoom выскочил, а процесс был невнятным.
// Владелец 17.11 (скрин плана «Сулико»): «текст тяжело читается, прям стена текста». Методичка для writer
// (как делать касание) — в поле `how`, менеджеру в плане — короткая цель `goal`.
const KRUG_RE = /кружок|видео/i;
const JUST_PRICE_RE = /просто (скиньте|дайте|пришлите|назовите|напишите) (цену|стоимость|сумму)|(зачем|не нужен|не нужно)[^.!?\n]{0,20}(zoom|зум)|(zoom|зум)[^.!?\n]{0,20}(долго|неудобно|не практику)/i;
// Один и тот же человек: «Тамара (управляющая)» = «Тамара».
function sameWho(a, b) { const f = (x) => String(x || '').toLowerCase().match(/[а-яёa-z]+/)?.[0] || ''; return f(a) === f(b); }
function addHow(x, t) { const v = String(t || '').trim(); if (v && !(x.how || []).includes(v)) x.how = [...(x.how || []), v]; }
const ZOOM_CH_RE = /zoom|зум/i;
const ZOOM_INVITE_RE = /(пригла|договор|организ|назнач|предлож|позвать|созвон)[^.]{0,40}(zoom|зум)|(zoom|зум)[^.]{0,30}(встреч|созвон)/i;
// Звонок / встреча УЖЕ были (менеджер описал результат) — первым касанием готовый итог ЭТОГО разговора по фактам.
const REAL_CALL_RE = /(созвонил[аи]?с[ья]?|поговорил[аи]?|переговорил[аи]?|провел[аи]? (zoom|зум|встречу|созвон)|был[аи]? на встрече|встретил[аи]?с[ья]?|дозвонил[аи]?с[ья]?)/i;
function lastManagerEvent(src) {
  const parts = String(src || '').split(/\[Сообщение менеджера \d+\]\s*/).map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}
// Владелец 18.11 (живой «Гараж 77»): клиент просит «покажите, чем отличаетесь» / доверие не открыто — после кружка
// «появилась идея» звонок раскрывает идею: приглашение на производство (Москва и МО). Регион далеко — Zoom с показом.
const FAR_RE = /(санкт-петербург|спб|петербург|казан|екатеринбург|новосибирск|краснодар|нижн[а-яё]* новгород|самар|ростов|уф[аеы](?![а-яё])|перм|воронеж|твер|ярослав|владимир|рязан|тул[аеы](?![а-яё])|калуг|край(?![а-яё])|республик)/i;
function noteKrugIdea(steps, source, scores) {
  const t = String(source || '');
  const askShow = /покажите|чем вы (отличаетесь|лучше)|очки втираете|не верю|у всех (вс[её] )?одинаков/i.test(t);
  const trust = String(scores?.trust?.status || '');
  if (!askShow && !/риск|неизвестно/i.test(trust)) return steps;
  steps.forEach((x, i) => {
    if (!/кружок/i.test(String(x.channel || ''))) return;
    const call = steps.slice(i + 1).find((y) => !y.conditional && VOICE_STEP_RE.test(String(y.channel || '')));
    if (!call || call.lastChance) return;
    addHow(call, FAR_RE.test(t) ? KRUG_IDEA_FAR_NOTE : KRUG_IDEA_NOTE);
    if (!FAR_RE.test(t)) call.production_meeting = true;
  });
  return steps;
}
const SOPRANO_ORDER = ['Р', 'О2', 'А', 'П', 'О1', 'Н', 'С'];
function noteSoprano(steps, soprano, source) {
  if (!soprano || typeof soprano !== 'object') return steps;
  const missing = SOPRANO_ORDER.filter((k) => soprano[k] && !/^собран/i.test(String(soprano[k].status || soprano[k] || '')));
  if (!missing.length) return steps;
  const tailText = String(source || '').slice(-1200);
  const irritated = /раздраж|надоел|отнимаете|!!!|без воды|некогда мне|хамит|злится/i.test(tailText);
  const voiceOff = require('./voice').voiceBlocked(source);
  const used = new Set();
  for (const x of steps) {
    if (x.lastChance || (x.scenarios || []).includes('negative')) continue;
    if (/кружок|видео/i.test(String(x.channel || ''))) continue;
    const voice = VOICE_STEP_RE.test(String(x.channel || ''));
    // Разбор 18.11 (перегрузка писателя): у сценария свои вопросы (температура, «какое „дорого“»). В его касании —
    // голосом не больше одного вопроса СОПРАНО, в переписке — ни одного (одно сообщение — один вопрос).
    const busy = (x.scenarios || []).length > 0;
    if (busy && (!voice || irritated)) continue;
    const limit = busy ? 1 : voice ? (irritated ? 1 : 3) : 1;
    // Полный прогон 18.11: вопрос о бюджете («в какую сумму…», «если по бюджету не сойдётся…») код ставил и в переписку —
    // судья: «деньги письменно при доступном голосе» (3 из 22). Деньги — голосом: такие блоки — только звонку / Zoom.
    const moneyQ = (k) => /сумм|бюджет|цен|стоимост/i.test(SOPRANO_Q[k].q);
    const pool = missing.filter((k) => !used.has(k) && (voice || voiceOff || !moneyQ(k)));
    if (!pool.length) continue;
    const mine = pool.filter((k) => SOPRANO_Q[k].crit.includes(x.criterion));
    const pick = [...mine, ...pool.filter((k) => !mine.includes(k))].slice(0, limit);
    pick.forEach((k) => used.add(k));
    addHow(x, ` СОПРАНО (владелец 18.11): вплести ${pick.length > 1 ? `до ${pick.length} вопросов` : 'один вопрос'} по несобранным блокам — ${pick.map((k) => `${SOPRANO_Q[k].name}: ${SOPRANO_Q[k].q}`).join('; ')}. Аккуратно и созидательно — как забота о результате, вытекая из разговора, своими словами; ${voice ? 'после каждого — [выслушать]' : 'один вопрос в конце сообщения'}; клиент уже ответил — не переспрашивать.`);
  }
  return steps;
}
// «План как договор» (владелец 18.11): у каждого касания — ОДИН угол довода, без повторов смысла между касаниями
// сделки (в т. ч. в тексте для пересылки ЛПР). Порядок выбора: триггеры клиента из диагностики (ведущий первым) → критерий касания → остальное.
// Не трогаем: кружок (интрига), последний шанс, касания со сценарием (у сценария свой ход), приглашение на производство
// (его довод — «своими глазами»). Инструмент доверия касания = его угол (второй не добавляем).
function assignArguments(steps, triggers, source) {
  const order = (Array.isArray(triggers) ? triggers : []).map((t) => String(t?.trigger || t || '').trim()).filter(Boolean);
  const moscowKnown = MOSCOW_RE.test(String(source || '')) || /обл|подмосков|мытищ|химк|люберц|балаших|подольск|королев|королёв|красногорск|одинцов/i.test(String(source || ''));
  const usedBy = new Map(); // адресат → Set(key)
  // Прицельный прогон 18.11 («МедЛайн»): «выглядит достойно» — в звонке контактному и в письме для пересылки ЛПР;
  // судья — повтор. Доводы не повторяем в пределах сделки (углов 12, касаний 3–6 — хватает).
  const who = () => 'deal';
  const used = (x) => { if (!usedBy.has(who(x))) usedBy.set(who(x), new Set()); return usedBy.get(who(x)); };
  const byTrust = (i) => ARGUMENT_ANGLES.find((a) => a.trust === i);
  // Сначала — что уже занято: инструменты доверия и приглашения на производство.
  for (const x of steps) {
    if (Number.isInteger(x.trust_idx) && byTrust(x.trust_idx)) { x.argument = byTrust(x.trust_idx).key; used(x).add(x.argument); }
    if (x.production_meeting || (PRODUCTION_RE.test(`${x.goal || ''} ${x.key_message || ''}`) && INVITE_RE.test(`${x.goal || ''} ${x.key_message || ''}`))) { x.argument = 'see_yourself'; used(x).add('see_yourself'); }
  }
  for (const x of steps) {
    if (x.argument || x.lastChance || /кружок|видео/i.test(String(x.channel || '')) || (x.scenarios || []).length) continue;
    const u = used(x);
    const ok = (a) => !u.has(a.key) && (a.key !== 'law' || moscowKnown);
    const crit = [x.criterion, ...(x.also || [])].filter(Boolean);
    const pick = order.map((t) => ARGUMENT_ANGLES.find((a) => a.trigger === t && ok(a) && a.crit.some((c) => crit.includes(c))) || ARGUMENT_ANGLES.find((a) => a.trigger === t && ok(a))).find(Boolean)
      || ARGUMENT_ANGLES.find((a) => ok(a) && a.crit.some((c) => crit.includes(c)))
      || ARGUMENT_ANGLES.find(ok);
    if (!pick) continue;
    x.argument = pick.key; u.add(pick.key);
  }
  // Подсказка писателю: свой угол + чужие (не повторять).
  for (const x of steps) {
    // у инструмента доверия — своя подсказка; у сценария — свой ход (в «Почему мы» производство уже есть)
    if (!x.argument || Number.isInteger(x.trust_idx) || (x.scenarios || []).length) continue;
    const me = ARGUMENT_ANGLES.find((a) => a.key === x.argument);
    const others = [...used(x)].filter((k) => k !== x.argument).map((k) => `«${ARGUMENT_ANGLES.find((a) => a.key === k)?.name}»`);
    addHow(x, `ДОВОД ЭТОГО КАСАНИЯ (договор плана): «${me.name}» — ${me.meaning}. Своими словами, через его ситуацию; один довод, не перечень.${others.length ? ` Доводы других касаний (${others.join(', ')}) здесь не повторять ни словами, ни смыслом.` : ''}`);
  }
  return steps;
}
function noteFollowUp(steps, source) {
  const first = steps.find((x) => !x.conditional && !x.lastChance) || steps[0];
  if (first && REAL_CALL_RE.test(lastManagerEvent(source))) addHow(first, FOLLOWUP_REAL_NOTE);
  steps.forEach((x, i) => {
    const next = steps[i + 1];
    if (!VOICE_STEP_RE.test(x.channel || '') || x.lastChance) return;
    if (next && next.sameContact && !VOICE_STEP_RE.test(next.channel || '') && !/кружок|видео/i.test(next.channel || '')) return;
    addHow(x, FOLLOWUP_IN_CALL_NOTE);
    // Разбор 18.11: после визита в цех итог звал «ждём вас в пятницу в цехе» — клиент уже там. Итог встречи — о шаге ПОСЛЕ неё.
    if (/встреч/i.test(String(x.channel || '')) || x.production_meeting) addHow(x, ' Итог ЭТОЙ встречи — о следующем шаге после неё (макет, расчёт, запуск, дата монтажа), а не повторное приглашение на ту же встречу.');
  });
  steps.forEach((x, i) => {
    const prev = steps[i - 1];
    if (!x.sameContact || x.conditional || x.lastChance || !prev) return;
    if (VOICE_STEP_RE.test(x.channel || '') || !VOICE_STEP_RE.test(prev.channel || '')) return;
    if (/кружок|видео/i.test(x.channel || '')) return;
    addHow(x, FOLLOWUP_NOTE);
  });
  return steps;
}
const VOICE_STEP_RE = /звонок|zoom|зум|встреч|видеозвон/i;
function noteZoom(steps, source) {
  const msk = MOSCOW_RE.test(String(source || '')) && !NOT_MOSCOW_RE.test(String(source || ''));
  for (const x of steps) {
    if (x.lastChance) continue;
    const g = x.goal || '';
    if (ZOOM_CH_RE.test(x.channel || '')) {
      addHow(x, ZOOM_MEETING_NOTE); if (msk) addHow(x, ZOOM_MOSCOW_NOTE);
    } else if (ZOOM_INVITE_RE.test(`${g} ${x.key_message || ''}`)) {
      addHow(x, ZOOM_INVITE_NOTE);
    }
  }
  return steps;
}
// Любое приглашение на производство в плане (не только от aimTrustAtProduction — стратег ставит его и сам):
// кто проводит и, от 500 тыс., личная встреча с менеджером. Живой «Дента Плюс» 16.11: 620 тыс., стратег сам
// позвал на производство — про выезд менеджера не сказано (владелец: «абсолютно верно»).
const PRODUCTION_RE = /производств|цех/i;
const INVITE_RE = /пригла|встреч|приех|показа|экскурс|увидеть|визит/i;
function noteProductionMeetings(steps, dealSize) {
  const big = Number(dealSize) >= BIG_DEAL;
  for (const x of steps) {
    const t = `${x.goal || ''} ${x.key_message || ''}`;
    // Живой «Сулико» 17.11: в «последнем шансе» звали на производство, а кто проводит — не сказано → и там тоже.
    if (!PRODUCTION_RE.test(t) || !INVITE_RE.test(t)) continue;
    if (!/заведующ/i.test(x.goal || '')) addHow(x, PRODUCTION_WHO_NOTE);
    if (big) addHow(x, PRODUCTION_BIG_NOTE);
  }
  return steps;
}
// Признак ставит diagnosticCleanup по событиям сделки (scores.trust.next_step = 'production').
function warmForProduction(scores) {
  return scores?.trust?.next_step === 'production' && !/подтвержд/i.test(String(scores?.trust?.status || ''));
}
function aimTrustAtProduction(steps, scores, dealSize) {
  if (!warmForProduction(scores)) return steps;
  const target = steps.find((x) => !x.conditional && !x.sameContact && x.criterion === 'Д')
    || steps.find((x) => !x.conditional && !x.sameContact && (x.also || []).includes('Д'));
  if (!target) return steps;
  if (target.criterion !== 'Д') { target.also = target.also.filter((c) => c !== 'Д'); target.also.push(target.criterion); target.criterion = 'Д'; }
  target.goal = 'Пригласить на встречу на производстве — через выгоду ЛПР';
  addHow(target, PRODUCTION_GOAL); if (Number(dealSize) >= BIG_DEAL) addHow(target, PRODUCTION_BIG_NOTE);
  target.production_meeting = true;
  if (/кружок/i.test(String(target.channel || ''))) target.channel = 'WhatsApp';
  target.kind = 'экспертное';
  return steps;
}

// Разбор 18.11 (перегрузка писателя, «Гараж 77»): клиент сказал «очки втираете со своим ОТК, гарантиями и
// визуализациями» — а касанию подставлялся инструмент «визуализация на фасаде». Инструмент, которому клиент
// не поверил, не берём; в приглашении на производство второй инструмент не нужен — доказательство делом.
const TRUST_DISTRUST = [/визуализ/i, /отк|гаранти|договор/i, /70\s*\/\s*30|частями|рассрочк/i, /слот|срок/i, /кейс|пример/i];
function distrustedTools(source) {
  const m = String(source || '').match(/(очки втираете|не верю|сказки|лапшу|все так говорят)[^.!?\n]{0,120}/i);
  if (!m) return new Set();
  return new Set(TRUST_DISTRUST.map((re, i) => (re.test(m[0]) ? i : -1)).filter((i) => i >= 0));
}
function diversifyTrust(steps, source) {
  let k = 0;
  const skip = distrustedTools(source);
  for (const x of steps) {
    if (x.conditional || x.production_meeting || x.lastChance) continue;
    if (x.criterion !== 'Д' && !(x.also || []).includes('Д')) continue;
    if (/кружок/i.test(String(x.channel || ''))) continue; // кружок — интрига, не довод
    if (PRODUCTION_RE.test(`${x.goal || ''} ${x.key_message || ''}`) && INVITE_RE.test(`${x.goal || ''} ${x.key_message || ''}`)) continue;
    const free = TRUST_TOOLS.map((_, j) => j).filter((j) => !skip.has(j));
    if (!free.length) continue;
    const i = free[k++ % free.length]; const tool = TRUST_TOOLS[i];
    x.goal = `${x.goal ? `${x.goal}. ` : ''}Инструмент доверия: ${TRUST_SHORT[i]}`;
    addHow(x, `Инструмент доверия этого касания: ${tool}. Доводы других касаний не повторять.`);
    x.trust_tool = tool;
    x.trust_idx = i;
  }
  return steps;
}

// Порядок как в «Правиле 7 касаний» владельца: кейсы (Д) → дедлайн (ЗС) → персональное (ФВ).
const CRITERIA_ORDER = ['ЛПР', 'Д', 'ЗС', 'ФВ', 'ОП'];
const MAX_TOUCHES = 7; // спящий режим — после 7 касаний без ответа
const CALM_GAP = 3;    // рабочих дней между касаниями, когда срок не горит («срок горит» — запас ≤ 5 раб. дн.;
                      // не путать с «срок близко» ≤ 10 в diagnosticCleanup — ЗС закрыт; владелец 16.11)
// Срочно: есть дата клиента и запас не больше 5 рабочих дней (или уже не успеваем).
const isUrgent = (tl) => !!tl && (tl.status !== 'с запасом' || Number(tl.buffer_working_days) <= 5);

function criterionOf(v) {
  const t = String(v || '').toUpperCase().replace(/Ё/g, 'Е');
  if (/ЛПР|AUTHORITY|ПОЛНОМОЧ/.test(t)) return 'ЛПР';
  if (/ФВ|FINANC|ФИНАНС|БЮДЖЕТ/.test(t)) return 'ФВ';
  if (/ЗС|URGEN|ЗДЕСЬ|СРОЧН/.test(t)) return 'ЗС';
  if (/ОП|NEED|ПОТРЕБН/.test(t)) return 'ОП';
  if (/(^|[^А-Я])Д([^А-Я]|$)|TRUST|ДОВЕР/.test(t)) return 'Д';
  return null;
}

// Стратегия не указала критерий (старые сделки, пропуск модели) — по цели касания.
const GOAL_HINTS = [
  ['ЛПР', /андре|лпр|собственник|руководител|директор|пересыл|контакт|совместн|напрямую/i],
  ['ФВ', /бюджет|цен|дорог|деньг|оплат|стоимост|скидк/i],
  ['ЗС', /срок|дат[аеуы]|последн|баннер|временн|запуск|старт|сегодня/i],
  ['Д', /довери|гаранти|кейс|производств|договор|фото|отзыв|надёжн|надежн/i],
  ['ОП', /потребност|открыти|гост|клиент[ыа] найдут|результат/i]
];
function guessCriterion(step) {
  const t = [step?.goal, step?.key_message].filter(Boolean).join(' ');
  for (const [c, re] of GOAL_HINTS) if (re.test(t)) return c;
  return null;
}

// Экспертные поводы, которые видны прямо из переписки (Москва — 902-ПП; латиница — 168-ФЗ).
function contextHints(context) {
  const src = String(context?.source || '');
  const client = String(context?.client || '');
  const out = [];
  const moscow = !NOT_MOSCOW_RE.test(src);
  if (moscow && /козыр[её]к|козырьк/i.test(src)) {
    out.push('Экспертный повод (902-ПП): клиент писал про козырёк — по правилам Москвы на козырьке вывеску размещают во фризе козырька (п. 18.3.4); говорить так, а не «на козырьке нельзя». Спросить, есть ли у козырька фриз и какой высоты, — как заботу, чтобы вывеску не пришлось снимать. Без пугалок.');
  } else if (moscow && /фриз/i.test(src)) {
    out.push('Экспертный повод (902-ПП): у фасада есть фриз — вывеска только на нём, буквы до 70% высоты фриза (п. 18.3). Уточнить высоту фриза — как заботу.');
  }
  // Методика переписки владельца: зависло больше 2 недель — обязательно кружок с новой идеей.
  if (Number(context?.daysSilent) >= 14) {
    out.push({ kind: 'эмпатичное', text: 'Реанимация (тишина больше 2 недель): кружок-интрига по образцу владельца — «[Имя], как вы? Решил записать короткое видео в связи с [повод: забота о дате / экспертный момент по проекту] — и у меня появилась идея, уверен, она вас точно заинтересует! Можем коротко набраться — всё объясню по телефону?» Саму идею в кружке НЕ рассказывать — по телефону (идея при этом реальная: кейс, повод из переписки).' });
  }
  // Латиница — только в названии клиента или в названии «в ёлочках». Раньше ловилось и любое
  // слово из 3+ заглавных латинских букв — «акрил + LED» в КП давал выдуманный повод про
  // латиницу в названии «Зерно» (прогон DeepSeek, 15.11).
  if (/[A-Za-z]{2,}/.test(client) || /«[^»]*[A-Za-z]{2,}[^»]*»/.test(src)) {
    out.push('Экспертный повод (закон о русском языке, 168-ФЗ, с 1.03.2026): в названии латиница — спросить, зарегистрировано ли название как товарный знак (тогда можно как есть; иначе нужен русский текст). Как вопрос, без пугалок и штрафов.');
  }
  return out;
}

// Какие критерии касания должны сдвинуть: всё, что не «Подтверждено».
function criteriaToMove(scores) {
  if (!scores || typeof scores !== 'object') return [];
  return CRITERIA_ORDER.filter((c) => {
    const st = String(scores[CRITERIA[c].key]?.status || '').toLowerCase();
    return st && !/подтвержд/.test(st);
  });
}

// Закрытое не трогаем (владелец 15.11, принцип): касание, чей критерий уже «Подтверждено», —
// лишнее. Если у него есть открытый критерий «заодно» — он становится главным; иначе касание
// убираем (последнее обычное касание пути — не трогаем, на нём «последний шанс»).
function dropClosed(steps, scores) {
  if (!scores || typeof scores !== 'object') return steps;
  const closed = new Set(CRITERIA_ORDER.filter((c) => /подтвержд/i.test(String(scores[CRITERIA[c].key]?.status || ''))));
  if (!closed.size) return steps;
  const regular = steps.filter((s) => !s.conditional && !s.sameContact);
  const lastRegular = regular[regular.length - 1];
  const out = [];
  let prevDropped = false;
  for (const s of steps) {
    // касание «сразу после» убранного — тоже уходит
    if (s.sameContact && prevDropped) continue;
    prevDropped = false;
    if (!s.criterion || !closed.has(s.criterion) || s === lastRegular) { out.push(s); continue; }
    const open = (s.also || []).find((c) => !closed.has(c));
    if (open) { s.criterion = open; s.also = (s.also || []).filter((c) => c !== open); out.push(s); continue; }
    if (!s.conditional && out.filter((x) => !x.conditional && !x.sameContact).length + regular.slice(regular.indexOf(s) + 1).length < 2) { out.push(s); continue; }
    prevDropped = true;
  }
  return out;
}

// Сколько касаний будет после чередования: два экспертных подряд → +кружок.
function projectedSize(regularSteps) {
  let size = 0; let prev = null;
  for (const s of regularSteps) {
    if (!s.sameContact && prev === 'экспертное' && s.kind === 'экспертное') size++;
    size++; prev = s.kind;
  }
  return size;
}

// Непокрытые критерии: сначала — шагам без критерия, потом новыми шагами (до 7 касаний),
// а если план уже полный — дополнительной целью к подходящему шагу.
function coverCriteria(steps, scores) {
  const need = criteriaToMove(scores);
  // Условные касания (звонок ЛПР «если даст контакт», текст «если не организовала») тоже
  // закрывают свой критерий — иначе код дописывал лишнее касание на ЛПР (прогон 14.11).
  const covered = new Set(steps.flatMap((s) => [s.criterion, ...(s.also || [])]).filter(Boolean));
  const missing = need.filter((c) => !covered.has(c));
  if (!missing.length) return steps;
  const out = [...steps];
  const regular = () => out.filter((s) => !s.conditional);
  for (const c of missing) {
    const free = regular().find((s) => !s.criterion && !s.sameContact && (c === 'ОП' || c === 'ЛПР' || s.kind === 'экспертное'));
    if (free) { free.criterion = c; continue; }
    // Деньги, доверие, сроки — экспертное касание (расчёт, факты); потребность — можно тепло.
    // Если перед ним тоже экспертное — чередование вставит кружок: учитываем в лимите 7.
    const last = regular().pop();
    const kind = c === 'ОП' && last?.kind === 'экспертное' ? 'эмпатичное' : 'экспертное';
    const candidate = { kind, sameContact: false };
    if (projectedSize([...regular(), candidate]) <= MAX_TOUCHES) {
      const lastDay = Math.max(0, ...regular().map((s) => s.day));
      out.push({ orig: null, day: lastDay + 2, conditional: false, sameContact: false, condition: '',
        channel: kind === 'эмпатичное' ? 'Кружок' : 'WhatsApp', kind,
        recipient: (out.find((s) => !s.conditional) || {}).recipient || '',
        goal: CRITERIA[c].goal, key_message: '', value: '', criterion: c, added_for_criterion: true });
      continue;
    }
    // Деньги, доверие, сроки — не в кружок (прогон 14.11: кружок стал списком компромиссов).
    const host = regular().filter((s) => !s.sameContact && (c === 'ОП' || c === 'ЛПР' || s.kind === 'экспертное')).pop();
    if (host) { host.also = [...(host.also || []), c]; host.goal = [host.goal, `Заодно (${CRITERIA[c].label}): ${CRITERIA[c].goal}`].filter(Boolean).join(' '); }
  }
  // Новые шаги — в конце (их день позже всех), порядок остальных не трогаем.
  return out;
}

// «Если нет ответа / не организовала» — не условие, а обычный путь молчащего клиента
// (прогон 14.11: такие шаги считались условными — ломались порядок дат и «последний шанс»).
// Условные — только шаги, которые случатся при согласии (даст контакт, согласится).
// + прогон 15.11 «Fresh Bowl»: «если после касания 4 нет движения», «Сергей не вышел на связь».
const SILENCE_RE = /нет ответа|не ответ|без ответа|не организ|не дал|не даст|молч|не получ|не согласовал|не вернул|нет движения|не вышел на связь|не вышла на связь|тишина|не отреагир|не перезвон|нет решения|не решил|не принял решени|всё ещё упира|все еще упира|движения нет|ничего не измен|оста[её]тся блокер|не подписал/i;
const isConditional = (s) => {
  const t = String(s?.condition || '') + ' ' + String(s?.timing || '');
  return /только если|если (марина|он|она|контакт)|после согласия/i.test(t) && !SILENCE_RE.test(t);
};
const isSameContact = (s) => s?.same_contact_as != null || /сразу после|в тот же день после|после звонка/i.test(String(s?.timing || ''));

function kindOf(s) {
  const k = String(s?.kind || '').toLowerCase();
  if (/эмпат/.test(k)) return 'эмпатичное';
  if (/экспер/.test(k)) return 'экспертное';
  return /кружок|видео|голосов/i.test(String(s?.channel || '')) ? 'эмпатичное' : 'экспертное';
}

// День отправки (рабочих дней от сегодня): поле day, иначе из timing, иначе по умолчанию.
function dayOf(step, i) {
  if (Number.isInteger(Number(step?.day)) && step.day !== '' && step.day !== null) return Math.max(0, Number(step.day));
  const t = String(step?.timing || '');
  if (/сегодня/i.test(t)) return 0;
  if (/завтра|на следующий день/i.test(t)) return 1;
  const m = t.match(/через\s+(\d+)\s+(раб|д)/i);
  if (m) return Number(m[1]);
  return DEFAULT_DAYS[Math.min(i, DEFAULT_DAYS.length - 1)];
}

function readyText(t) {
  const s = t?.if_start_today;
  if (!s) return null;
  return s.installed_earliest === s.installed_latest ? humanDate(s.installed_latest) : `${humanDate(s.installed_earliest)} – ${humanDate(s.installed_latest)}`;
}

// Полный прогон 18.11: в «Сообщении после звонка» писатель оставлял «[день, время]», «[дата]» (7 остатков, круги
// переписывания) — исход звонка не знает. Код даёт конкретный слот: его и предлагать в звонке, он же — в «Если договорились».
function slotNote(s, send) {
  if (!send || !(s.how || []).some((h) => /^\s*FOLLOW-UP после звонка/.test(h))) return [];
  const d = addWorkingDays(send, 1);
  return [`СЛОТ ДЛЯ ШАГА (код): в звонке предложить «${humanDate(d)} в 11:00 — удобно?» (не подходит — «а в 15:00?»); в «Если договорились» — ровно «${humanDate(d)} в 11:00». Сумма — из КП / вилки, даты готовности — из facts; квадратных скобок нет.`];
}
const b0 = (timeline) => !!(timeline?.temp_banner && timeline.temp_banner.fits_client_deadline);
// Факты по срокам на день отправки касания.
function factsFor(sendIso, timeline) {
  if (!timeline || !timeline.if_start_today || !sendIso) return { dates: 'Дат готовности не называть — сроки не посчитаны.' };
  const at = computeTimeline({
    today: sendIso,
    clientDeadline: timeline.client_deadline,
    productionDays: timeline.production_working_days,
    installDaysMin: Number(String(timeline.install_working_days).split('–')[0]),
    installDaysMax: Number(String(timeline.install_working_days).split('–').pop())
  });
  const out = {
    status_on_send_day: at?.status || null,
    permanent_ready_if_start_that_day: readyText(at),
    note: 'Каждый рабочий день ожидания сдвигает готовность на рабочий день.'
  };
  // Полный прогон 18.11 («Зерно»: 5 из 11 «нет»): «готова 7–8 декабря» в ответ на «открываемся 1 декабря» без прямого
  // «не успеваем» читается как увиливание. Не успеваем — называем это прямо, одной фразой, рядом с датой.
  if (/не успева|прошла/i.test(String(at?.status || '')) && timeline.client_deadline) {
    out.honesty = `К ${humanDate(timeline.client_deadline)} (дата клиента) постоянную вывеску уже не успеваем. Называешь дату готовности — в той же фразе прямо: «к ${humanDate(timeline.client_deadline)} постоянную уже не успеваем — при старте сегодня готова ${readyText(at)}»${b0(timeline) ? '. Временную — только как вариант строго по `temp_banner` (в Москве — только внутри помещения), без «откроетесь с вывеской» и без «к открытию успеваем / будет готова к …»' : ''}. Не «к открытию», не «успеваем», не «в срок».`;
  }
  const b = timeline.temp_banner;
  if (b && b.fits_client_deadline) {
    out.temp_banner = sendIso <= b.latest_start_date
      ? `Временная вывеска к открытию ещё успевает: запустить не позже ${humanDate(b.latest_start_date)}. Эта дата — только для неё. В Москве — только внутри помещения (на фасаде 902-ПП запрещает баннерную ткань); не в Москве — на фасаде, если позволяют правила города. Её цена — ОТДЕЛЬНО от КП и в переписке не названа: сумму не называть, «без доплат» про неё не писать, «откроетесь с вывеской на фасаде» не обещать; можно «по стоимости временной сориентирую».`
      : `Временную вывеску к открытию уже не успеть (последний день запуска был ${humanDate(b.latest_start_date)}) — её и эту дату не упоминать.`;
  }
  return out;
}

// Пункт «Обязательно в касаниях» → номер касания (по исходной нумерации стратегии).
function targetOf(item, steps) {
  const m = String(item).match(/касани[ея]\s+(\d+)/i);
  if (m && steps.some((s) => s.orig === Number(m[1]))) return Number(m[1]);
  // Пункты для контактного лица (сроки, прежние условия, обещания) — в первое касание.
  const first = steps.find((s) => !s.conditional);
  return (first || steps[0])?.orig;
}

/**
 * @returns {Array} план: [{ touchpoint_number, send_date, timing, channel, kind, recipient,
 *   condition, goal, key_message, value, must_include: [...], facts: {...} }]
 */
function buildTouchPlan(strategyOutput, timeline, today, scores, context = {}) {
  const seq = Array.isArray(strategyOutput?.touchpoint_sequence) ? strategyOutput.touchpoint_sequence : [];
  if (!seq.length || !today) return null;
  let steps = seq.map((s, i) => ({
    orig: Number(s?.number ?? i + 1),
    day: dayOf(s, i),
    conditional: isConditional(s),
    sameContact: isSameContact(s),
    condition: s?.condition || (isConditional(s) ? String(s?.timing || '').trim() : ''),
    channel: s?.channel || 'WhatsApp',
    kind: kindOf(s),
    recipient: s?.recipient || '',
    goal: s?.goal || '',
    key_message: s?.key_message || '',
    value: s?.value_for_client || '',
    criterion: criterionOf(s?.criterion) || (s?.same_contact_as != null ? null : guessCriterion(s))
  }));

  // Ритм пути (симулятор 15.11 «Fresh Bowl»: стратег связал все 4 касания цепочкой «сразу после» —
  // путь схлопнулся в один день, «последнего шанса» нет). К основному касанию — не больше одного
  // «сразу после»; следующие в цепочке — обычные касания со своим днём.
  // Длинная цепочка: два и больше «сразу после» подряд. Пару «звонок + сразу текст» не трогаем.
  const chained = steps.map((x, i) => !!x.sameContact && !x.conditional && (!!steps[i - 1]?.sameContact || !!steps[i + 1]?.sameContact));
  for (let i = 1; i < steps.length; i++) {
    const x = steps[i]; const prev = steps[i - 1];
    if (x.sameContact && !x.conditional && (prev.sameContact || prev.conditional)) x.sameContact = false;
  }
  // Весь путь — до «последнего шанса»: нужно хотя бы 3 обычных касания. Не хватает — «сразу после»
  // из длинной цепочки (с конца) становятся обычными касаниями.
  if (context.mode !== 'step') {
    const regularCount = () => steps.filter((x) => !x.conditional && !x.sameContact).length;
    for (let i = steps.length - 1; i > 0 && regularCount() < 3; i--) if (chained[i] && steps[i].sameContact) steps[i].sameContact = false;
  }

  // По датам: обычные касания (вместе с текстом «сразу после» к ним) — по дню отправки;
  // условные остаются на своих местах. Иначе номера шли не по хронологии (прогон 14.11).
  {
    const units = [];
    for (const x of steps) {
      if (x.conditional) continue;
      if (x.sameContact && units.length) units[units.length - 1].push(x); else units.push([x]);
    }
    const sorted = units.slice().sort((a, b) => a[0].day - b[0].day);
    const out = [];
    let k = 0;
    let started = false;
    for (const x of steps) {
      if (x.conditional) { out.push(x); continue; }
      if (x.sameContact && started) continue; // уже вошёл в свою группу
      out.push(...sorted[k++]); started = true;
    }
    steps = out;
  }

  // «Сразу после / в тот же день после звонка» — тот же день, что предыдущий шаг.
  let lastDay = 0;
  let seenRegular = false;
  for (const s of steps) {
    if (s.conditional) continue;
    if (s.sameContact) { s.day = lastDay; continue; }
    // обычные касания — каждое в свой день (не раньше следующего дня после предыдущего)
    if (seenRegular && s.day <= lastDay) s.day = lastDay + 1;
    lastDay = s.day; seenRegular = true;
  }

  // «Есть ли шанс / честный ответ» в середине цепочки — убираем: это вопрос только
  // «последнего шанса», его код ставит последним сам (прогон 14.11, касание 6 «Зерна»).
  // + симулятор 15.11: «Попросить сказать как есть, чтобы не тратить время клиента» в середине пути.
  const LC_GOAL_RE = /шанс|честн[а-яё]* ответ|сделка потеряна|сказ[а-яё]* как есть|не тратить [а-яё ]{0,12}время|проект ещё (актуал|в приоритет)|актуален ли проект/i;
  const regularIdx = steps.map((x, i) => (!x.conditional && !x.sameContact ? i : -1)).filter((i) => i >= 0);
  const lastRegular = regularIdx[regularIdx.length - 1];
  steps = steps.filter((x, i) => x.conditional || x.sameContact || i === lastRegular || !LC_GOAL_RE.test(`${x.goal || ''} ${x.key_message || ''}`));

  // Режим «следующий шаг» (владелец 15.11, engine/pathMode.js): идёт разговор — только ближайший
  // шаг: первое обычное касание (+ «сразу после» тому же контакту и условные касания до
  // следующего обычного). Без добавочных касаний на критерии и без «последнего шанса».
  const stepMode = context.mode === 'step';
  if (stepMode) {
    const firstRegular = steps.findIndex((x) => !x.conditional && !x.sameContact);
    let nextRegular = steps.findIndex((x, i) => i > firstRegular && !x.conditional && !x.sameContact);
    // Владелец 18.11: кружок «появилась идея — наберёмся?» без звонка следом — интрига в пустоту. Звонок — в шаг.
    if (nextRegular > 0 && /кружок/i.test(String(steps[firstRegular]?.channel || '')) && VOICE_STEP_RE.test(String(steps[nextRegular]?.channel || ''))) {
      nextRegular = steps.findIndex((x, i) => i > nextRegular && !x.conditional && !x.sameContact);
    }
    if (firstRegular >= 0 && nextRegular > 0) steps = steps.slice(0, nextRegular);
  }

  // Все неподтверждённые критерии формулы закрытия — хотя бы в одном касании (весь путь).
  if (!stepMode) steps = aimTrustAtProduction(coverCriteria(dropClosed(steps, scores), scores), scores, context.dealSize);

  // Подсказки из переписки (прогон 14.11: повод про козырёк по 902-ПП не появился ни разу) —
  // в первое экспертное касание как обязательный пункт.
  for (const h of contextHints(context)) {
    const kind = typeof h === 'object' ? h.kind : 'экспертное';
    const text = typeof h === 'object' ? h.text : h;
    const target = steps.find((x) => !x.conditional && !x.sameContact && x.kind === kind);
    if (target) target.hints = [...(target.hints || []), text];
  }

  // Пункты «Обязательно» — по исходным номерам, до вставок.
  const items = Array.isArray(strategyOutput?.must_include) ? strategyOutput.must_include : [];
  const byOrig = {};
  items.forEach((it) => { const n = targetOf(it, steps); (byOrig[n] = byOrig[n] || []).push(it); });

  // Чередование: обычные шаги по порядку дней; два экспертных подряд → вставить кружок,
  // два эмпатичных подряд → второй сделать экспертным.
  const ordered = [];
  let prev = null;
  for (const s of steps) {
    // Условный шаг может не случиться — в чередовании не участвует.
    if (s.conditional) { ordered.push(s); continue; }
    // «Сразу после» тому же контакту — уходит наверняка: не правим его, но он задаёт тип
    // для следующего шага (иначе «звонок эмп → сообщение эксп → кружок эмп» ломался:
    // кружок превращался в WhatsApp и вставлялся лишний кружок).
    if (s.sameContact) { ordered.push(s); prev = s; continue; }
    if (prev && prev.kind === s.kind) {
      // Живой «Сулико» 17.11 (владелец: «сколько кружков по одному и тому же поводу — это плохо»): кружок одному
      // человеку — не больше одного за путь; уже есть — не вставляем, два экспертных подряд допустимы.
      const hasKrug = [...ordered, ...steps].some((o) => KRUG_RE.test(o.channel || ''));
      if (s.kind === 'экспертное' && hasKrug) { ordered.push(s); prev = s; continue; }
      if (s.kind === 'экспертное') {
        const day = s.day > prev.day + 1 ? Math.floor((prev.day + s.day) / 2) : prev.day + 1;
        if (s.day <= day) s.day = day + 1;
        ordered.push({ orig: null, day, conditional: false, sameContact: false, condition: '', channel: 'Кружок', kind: 'эмпатичное',
          recipient: prev.recipient, goal: 'Кружок-интрига: деталь проекта → «появилась идея» → созвон', how: ['Кружок-интрига (правило 73): повод — конкретная деталь проекта клиента → «появилась идея, уверен, вас заинтересует» → «можем коротко набраться — всё объясню по телефону?»; саму идею не раскрывать'], key_message: '', value: 'клиент видит, что о его проекте думают и работают', inserted: true });
      } else {
        s.kind = 'экспертное';
        if (/кружок|видео|голосов/i.test(s.channel)) s.channel = 'WhatsApp';
      }
    }
    ordered.push(s);
    prev = ordered[ordered.length - 1];
  }
  steps = ordered;
  // Кружок одному человеку — один за путь (условный тоже считается): остальные убираем.
  {
    const seen = [];
    steps = steps.filter((x) => {
      if (!KRUG_RE.test(x.channel || '')) return true;
      // Экзамен 17.11: Вике и Арсену (одна компания) — два кружка «появилась идея»: один повод. Один на путь.
      if (seen.length) return false;
      seen.push(x.recipient); return true;
    });
  }

  // Деньги — только звонок или Zoom (владелец 14.11, правило): касание, которое двигает ФВ
  // (бюджет, «дорого», варианты под бюджет), — звонок, если стратегия не поставила Zoom.
  // Голос недоступен (не берёт трубку, просит писать) — канал не меняем (владелец 15.11:
  // «голос в приоритете, если нет такой возможности — другие каналы»).
  const noVoice = require('./voice').voiceBlocked(context?.source);
  for (const x of noVoice ? [] : steps) {
    const money = x.criterion === 'ФВ' || (x.also || []).includes('ФВ');
    if (money && !/звонок|zoom|зум|видеозвон|встреч/i.test(String(x.channel || ''))) { x.channel = 'Звонок'; x.kind = 'экспертное'; }
  }
  // Живой прогон 15.11 «Fresh Bowl»: «не берёт трубку» — а первое касание снова звонок. Голос
  // недоступен — первое касание пишем (мессенджер), звонок — позже (владелец 15.11).
  if (noVoice) {
    const first = steps.find((x) => !isConditional(x));
    if (first && /^\s*звонок/i.test(String(first.channel || ''))) first.channel = 'WhatsApp';
  }

  // Интервал между касаниями — по ситуации (владелец 14.11: «от триггера, если есть
  // срочность — быстрее»). Срок не горит (нет даты клиента или запас больше недели) —
  // между касаниями не меньше 3 рабочих дней (документ владельца: 3–7 дней).
  if (!isUrgent(timeline)) {
    let lastDay = null;
    for (const s of steps) {
      if (s.conditional) continue;
      if (s.sameContact) { if (lastDay != null) s.day = lastDay; continue; }
      if (lastDay != null && s.day < lastDay + CALM_GAP) s.day = lastDay + CALM_GAP;
      lastDay = s.day;
    }
  }

  // «Последний шанс» (владелец 14.11): последнее касание цепочки — попросить сказать
  // как есть, чтобы не тратить время клиента. Только последним и только в цепочке
  // от трёх касаний (одно-два касания после ответа клиента — ещё не «последний шанс»).
  const own = steps.filter((s) => !s.conditional && !s.sameContact);
  // Весь путь (клиент молчит) — всегда до «последнего шанса» (живой «Дента Плюс» 16.11: стратег
  // поставил касания с условиями «если доверие остаётся блокером / если движения нет», путь вышел
  // из двух обычных касаний — без «последнего шанса»). Не хватает — код добавляет его сам.
  if (context.mode === 'full' && own.length && own.length < 3) {
    const prev = own[own.length - 1];
    const add = { orig: null, day: prev.day + (isUrgent(timeline) ? 1 : CALM_GAP), conditional: false, sameContact: false, condition: '',
      channel: require('./voice').voiceBlocked(context?.source) ? 'WhatsApp' : 'Звонок', kind: 'экспертное',
      recipient: prev.recipient, goal: '', key_message: '', value: '', criterion: 'ЗС', inserted: true };
    steps.push(add); own.push(add);
  }
  const lastChance = !stepMode && (own.length >= 3 || (context.mode === 'full' && own.length >= 2)) ? own[own.length - 1] : null;
  if (lastChance) {
    // Его критерий (если был) переносим на предыдущее касание — покрытие формулы не теряем.
    const lost = [lastChance.criterion, ...(lastChance.also || [])].filter((c) => c && c !== 'ЗС');
    for (const c of lost) {
      const host = own.slice(0, -1).filter((x) => c === 'ОП' || c === 'ЛПР' || x.kind === 'экспертное').pop();
      const coveredElsewhere = steps.some((x) => x !== lastChance && !x.conditional && (x.criterion === c || (x.also || []).includes(c)));
      if (!coveredElsewhere && host) { host.also = [...(host.also || []), c]; host.goal = [host.goal, `Заодно (${CRITERIA[c].label}): ${CRITERIA[c].goal}`].filter(Boolean).join(' '); }
    }
    lastChance.lastChance = true;
    // «Последний шанс» — прямой вопрос «скажите как есть», а кружок — интрига (правило 73):
    // в кружке выходила интрига вместо вопроса (прогон 16 ситуаций, «Арка», 15.11).
    if (/кружок|видео/i.test(String(lastChance.channel || ''))) { lastChance.channel = 'WhatsApp'; lastChance.kind = 'экспертное'; }
    lastChance.criterion = 'ЗС';
    lastChance.also = [];
    lastChance.goal = LAST_CHANCE_SHORT;
    addHow(lastChance, LAST_CHANCE_GOAL);
  }

  steps = noteFollowUp(noteZoom(noteProductionMeetings(diversifyTrust(steps, context.source), context.dealSize), context.source), context.source);
  noteKrugIdea(steps, context.source, scores);
  // Сценарии владельца для критичных ситуаций (торг, «дорого», «просто цену», «подумает → тишина», «хочет
  // посмотреть») — карточка в how касания-ответа, ход фиксирован (владелец 17.11, п. 2 «как сделать 10»).
  require('./scenarios').attachScenarios(steps, context.source, addHow, { step: stepMode, voiceOk: !require('./voice').voiceBlocked(context?.source) });
  noteSoprano(steps, context.soprano, context.source);
  assignArguments(steps, context.triggers, context.source);
  // Экзамен 17.11 (прогоны 4–5): стратег ставит цель «согласовать 650 через полномочия» (650 — цена клиента) →
  // writer пишет «650 — точно не смогу», а через фразу «по цене 650». Цель на цену клиента код переписывает.
  const ask = String(context.source || '').match(/сделаете (?:на |за )?(\d{2,3})(?:[ \u00a0]?(?:000|тыс))?/i);
  if (ask) {
    const n = ask[1];
    const aimRe = new RegExp(`(согласовать|зафиксировать|по цене|договор на|подписать на|принять|выбить)[^.]{0,25}\\b${n}\\b|\\b${n}\\b[^.]{0,30}(через полномочия|согласовать|уже уступка)`, 'i');
    for (const x of steps) {
      if (!aimRe.test(`${x.goal || ''} ${x.key_message || ''}`)) continue;
      x.goal = `Ответить на условие клиента «${n}»: ${n} — не сможем; небольшая уступка через полномочия в обмен на решение`;
      x.key_message = '';
      addHow(x, `Цена клиента «${n}» — торг, не договорённость (экзамен 17.11). Голосом: признать, напомнить, что входит в цену, «${n} — точно не смогу, у меня таких полномочий нет; попробую согласовать небольшую уступку (наличные 5–7% / табличка / слот / замер в счёт заказа), если подписываем …»; или оплата 70/30. Цену «${n}» не обещать и не называть ценой договора.`);
    }
  }
  // Владелец 17.11 (живой «Сулико»): «Клоузер не предложил выяснить влияние Тамары на сделку». ЛПР не подтверждён —
  // в первом касании контактному лицу выяснить его влияние (ЛДПР, файл 28).
  if (scores && criteriaToMove(scores).includes('ЛПР')) {
    const first = steps.find((x) => !x.conditional && !x.lastChance && !KRUG_RE.test(x.channel || ''));
    if (first) addHow(first, LDPR_NOTE);
  }

  // Кружок — одному человеку (владелец, живой «Зерно 10»): «Андрей + Марина» → тот, с кем уже
  // есть контакт (получатель первого касания), иначе первый из списка.
  const contact = String((steps.find((x) => !x.conditional) || {}).recipient || '').split(/\s*(?:\+|→| и )\s*/)[0].split(' (')[0].trim();
  for (const x of steps) {
    if (!/кружок|видео/i.test(String(x.channel || ''))) continue;
    const parts = String(x.recipient || '').split(/\s*(?:\+|→| и )\s*/).filter(Boolean);
    if (parts.length > 1) x.recipient = parts.find((p) => contact && p.startsWith(contact)) || parts[0];
  }

  // «Меняй время: утро → день → вечер» (документ владельца «Правило 7 касаний»):
  // клиент не отвечает — касания со 2-го в разное время суток. «Сегодня» и вдогонку — без времени.
  const DAYPARTS = ['утром', 'днём', 'вечером'];
  own.filter((s) => s.day > 0).forEach((s, k) => { s.daypart = DAYPARTS[k % DAYPARTS.length]; });

  // Разбор 18.11 (причина 5 — перегрузка писателя): подсказки касания — без служебных пометок, дублей и
  // противоречий, в лимите, главное первым (engine/notes.js).
  for (const s of steps) {
    const { notes, dropped } = compactNotes(s.how, s);
    s.how = notes;
    if (dropped.includes('trust_tool')) {
      s.goal = String(s.goal || '').replace(/\.?\s*Инструмент доверия: [^.]*$/, '');
      delete s.trust_tool;
    }
    if (dropped.length) console.log(`[touchPlan] касание ${s.orig ?? '+'}: подсказки сняты — ${dropped.join(', ')}`);
  }

  return steps.map((s, i) => {
    const send = s.conditional ? null : (s.day === 0 ? today : addWorkingDays(today, s.day));
    // Выходной или праздник (бывает только «сегодня»): владелец 14.11 — уточнять у клиента.
    const weekend = !!send && !isWorkingDay(send);
    const dateText = send ? humanDate(send) : null;
    // «После согласия, в тот же день» — только для условий-согласий (контакт, звонок).
    // Живой «Зерно 6»: «Только если Марина не ответила на касания 1–2 — после
    // согласия, в тот же день» — бессмыслица; для «не ответила» — дата из плана.
    // «не организовала / не дала / не ответила» — условие отказа/молчания, не согласия (живой «Зерно 6»).
    const consent = /контакт|соглас|организ|даст|разреш/i.test(String(s.condition || '')) && !/\bне\s+(организ|дал|даст|соглас|ответ|разреш)|не\s+(организ|дал|даст|соглас|ответ|разреш)/i.test(String(s.condition || ''));
    const condDate = !consent && s.day > 0 ? `, не раньше ${humanDate(addWorkingDays(today, s.day))}` : '';
    const timing = s.conditional
      ? `${s.condition || 'Только при условии'}${consent ? (/после согласия/i.test(String(s.condition || '')) ? '' : ' — после согласия, в тот же день') : condDate}`
      : s.sameContact ? `${dateText}, сразу после предыдущего касания`
        : `${s.day === 0 ? 'Сегодня, ' : ''}${dateText}${s.daypart ? `, ${s.daypart}` : ''}${weekend ? ` — выходной: уточните у клиента, удобно ли на связи; если нет — ${humanDate(addWorkingDays(today, 1))}` : ''}`;
    return {
      touchpoint_number: i + 1,
      send_date: send,
      timing,
      channel: s.channel,
      kind: s.kind,
      recipient: s.recipient,
      condition: s.conditional ? (s.condition || 'только при условии') : '',
      goal: s.goal,
      how: [...(s.how || []), ...slotNote(s, send)].join(' '),
      scenarios: s.scenarios || [],
      key_message: s.key_message,
      value: s.value,
      criterion: s.criterion ? CRITERIA[s.criterion].label : null,
      also_criteria: (s.also || []).map((c) => CRITERIA[c].label),
      must_include: [...(s.orig != null ? (byOrig[s.orig] || []) : []), ...(s.hints || [])],
      facts: factsFor(send || today, timeline),
      inserted: !!s.inserted,
      last_chance: !!s.lastChance,
      weekend,
      path_mode: stepMode ? 'step' : 'full'
    };
  });
}

// Для менеджера под стратегией: «1. 13 ноября (пт) · Звонок · экспертное — Марине: цель».
function formatTouchPlan(plan) {
  if (!Array.isArray(plan) || !plan.length) return '';
  // Владелец 17.11: «стена текста» → карточкой: когда · канал · тип · критерий; кому; цель; «заодно» — своей строкой.
  const lines = plan.map((p) => {
    const when = p.condition ? `Только если ${p.condition.replace(/^только если:?\s*/i, '')}` : p.timing;
    const head = `${p.touchpoint_number}. **${when} · ${p.channel}** · ${p.last_chance ? 'последний шанс' : p.kind}${p.criterion && !p.last_chance ? ` · ${p.criterion.split(' —')[0]}` : ''}`;
    const out = [head];
    if (p.recipient) out.push(`  Кому: ${p.recipient}`);
    const [main, ...also] = String(p.goal || '').split(/\s*Заодно \(/);
    if (main.trim()) out.push(`  ${main.trim()}`);
    for (const a of also) out.push(`  Заодно (${a.trim()}`);
    return out.join('\n');
  });
  const note = plan[0]?.path_mode === 'step'
    ? '_Показан следующий шаг — идёт разговор с клиентом. Если клиент снова замолчит, напишите «клиент молчит» — построю весь путь до «последнего шанса»._'
    : '_Показан весь путь. Если клиент ответил и нужен только следующий шаг — напишите «следующий шаг»._';
  return `### ${plan[0]?.path_mode === 'step' ? 'Следующий шаг' : 'План касаний'}\n\n${lines.join('\n')}\n\n${note}`;
}

// После writer: канал, дата и тип — из плана (модель их не меняет).
function pinToPlan(composerOutput, plan) {
  const msgs = composerOutput?.messages;
  if (!Array.isArray(msgs) || !Array.isArray(plan)) return composerOutput;
  const messages = msgs.map((m, i) => {
    const p = plan.find((x) => x.touchpoint_number === Number(m?.touchpoint_number ?? i + 1));
    // «Наставник» (владелец 18.11): почему касание такое — из плана, кодом.
    return p ? { ...m, channel: p.channel, timing: p.timing, kind: p.kind, criterion: p.criterion || null, last_chance: !!p.last_chance, mentor: require('./mentor').mentorWhy(p) } : m;
  });
  return { ...composerOutput, messages };
}

module.exports = { JUST_PRICE_RE, contextHints, NOT_MOSCOW_RE, buildTouchPlan, formatTouchPlan, pinToPlan, factsFor, criteriaToMove, criterionOf, CRITERIA };

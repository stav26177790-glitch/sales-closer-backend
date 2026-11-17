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
// Лестница доверия (владелец 15.11): кейсы и примеры → показ в Zoom → ВСТРЕЧА НА ПРОИЗВОДСТВЕ —
// сильнейший инструмент («по практике ~95% клиентов заключаются после встречи на производстве»,
// клиенту эту цифру не называть). Звать, когда клиент прогрет: деньги есть (торг) или ЛПР на связи,
// а Д ещё не подтверждено. До этого — прогрев касаниями.
const PRODUCTION_GOAL = 'Через выгоду ЛПР (владелец 15.11: «всё через выгоду для клиента»): пригласить на встречу на нашем производстве (акрил — Мытищи, сталь — Щёлково), чтобы он ПОЛУЧИЛ спокойствие за свой страх — своими глазами увидел, кто и как делает его вывеску и как ОТК проверяет её до отгрузки на неисправности и соответствие ТЗ, и решил без риска повторить прошлый опыт. Встречу на производстве проводит заведующий производством, менеджер — на связи по Zoom (владелец 16.11); не писать «я покажу цех» / «встречу вас» от лица менеджера. Начинать с того, что он получает («чтобы вы своими глазами увидели, почему прошлая история не повторится»), а не с «приглашаем на экскурсию». Результат — комплексный, не одна подсветка (владелец 16.11). Конкретное время на выбор («во вторник в 11 или в среду в 15?»). Кейсы и «чем мы лучше» заново не повторять. Цифру «после встречи заключаются» клиенту не называть.';
// Крупный проект (от 500 тыс.): менеджер может приехать сам — на производство или на объект клиента
// (владелец 16.11: «сильный шаг, но затратный»).
const BIG_DEAL = 500000;
const PRODUCTION_BIG_NOTE = ' Личная встреча с менеджером (проект от 500 тыс.) — только если по-другому не получается (клиент не может приехать на производство и Zoom не подходит; владелец 17.11) — тогда на производстве или на объекте, через то, что это даёт клиенту.';
// Zoom (владелец 17.11, knowledge/29_zoom.md): касание «Zoom» — сценарий встречи с подготовкой, касание с
// приглашением в Zoom — по скелету приглашения. В «Сулико» Zoom выскочил, а процесс был невнятным.
const ZOOM_CH_RE = /zoom|зум/i;
const ZOOM_INVITE_RE = /(пригла|договор|организ|назнач|предлож|позвать|созвон)[^.]{0,40}(zoom|зум)|(zoom|зум)[^.]{0,30}(встреч|созвон)/i;
const ZOOM_MEETING_NOTE = ' СЦЕНАРИЙ ZOOM (файл 29): рамка «пройдёмся → покажу варианты → предложу оптимальный, ок?» → показ (экран, макет, фото работ по свечению и материалу, образцы — включить подсветку, фотопривязка) → предварительный расчёт → ТЕМПЕРАТУРА «что вам больше откликнулось?» [выслушать] → итог «я правильно понял(а), что…? верно?» → ОДНА ветка по ситуации: замер (5 000 ₽, как экспертиза; не «бесплатно» — при торге в счёт заказа: предоплата, потом вычитаем) / выезд специалиста с образцами (только если лид целевой, СОПРАНО собрано, объект и бюджет известны, Москва или ближнее Подмосковье) / сразу в производство (слот и цена на 2 месяца — как забота о сроке) → фиксация даты и времени. В «Перед касанием» — подготовка: расчёт, технические моменты макета в Кореле (ножки, плёнки, борта), фото работ под материал сделки, образцы, фотопривязка или «Презентация проекта». После встречи — запись Zoom в сделку.';
const ZOOM_MOSCOW_NOTE = ' Москва: в подготовке и показе — 902-ПП по дому клиента (где можно ставить вывеску, допродажа по концепции) и вывески соседей на Яндекс Картах.';
const ZOOM_INVITE_NOTE = ' ПРИГЛАШЕНИЕ В ZOOM (файл 29): зацеп «не всё так просто, вслепую не считаем» → что даёт клиенту (15 минут вместо переписки, наглядно, разберём неточности макета, точный расчёт; связь сейчас нестабильна — Zoom надёжнее) → оффер с днём и временем → «камеру включать не обязательно» → усиление смыслом: клиент получает упакованное экспертное решение под свою ситуацию.';
const ZOOM_MSK_RE = /москв|мск([^а-яё]|$)|метро|м\.\s?[А-ЯЁ]|902-?пп/i;
function noteZoom(steps, source) {
  const msk = ZOOM_MSK_RE.test(String(source || '')) && !NOT_MOSCOW_RE.test(String(source || ''));
  for (const x of steps) {
    if (x.lastChance) continue;
    const g = x.goal || '';
    if (ZOOM_CH_RE.test(x.channel || '')) {
      if (!g.includes('СЦЕНАРИЙ ZOOM')) x.goal = `${g}${ZOOM_MEETING_NOTE}${msk ? ZOOM_MOSCOW_NOTE : ''}`;
    } else if (ZOOM_INVITE_RE.test(`${g} ${x.key_message || ''}`) && !g.includes('ПРИГЛАШЕНИЕ В ZOOM')) {
      x.goal = `${g}${ZOOM_INVITE_NOTE}`;
    }
  }
  return steps;
}
// Любое приглашение на производство в плане (не только от aimTrustAtProduction — стратег ставит его и сам):
// кто проводит и, от 500 тыс., личная встреча с менеджером. Живой «Дента Плюс» 16.11: 620 тыс., стратег сам
// позвал на производство — про выезд менеджера не сказано (владелец: «абсолютно верно»).
const PRODUCTION_RE = /производств|цех/i;
const INVITE_RE = /пригла|встреч|приех|показа|экскурс|увидеть/i;
const PRODUCTION_WHO_NOTE = ' Встречу на производстве проводит заведующий производством — ориентировать на него, он почти всегда на месте; менеджер всегда может подключиться по Zoom (владелец 17.11). Звать через то, что это даёт клиенту (смысл, своими словами): своими глазами видит, кто и как делает его вывеску и как её проверяют, — и решает без риска.';
function noteProductionMeetings(steps, dealSize) {
  const big = Number(dealSize) >= BIG_DEAL;
  for (const x of steps) {
    const t = `${x.goal || ''} ${x.key_message || ''}`;
    // Живой «Сулико» 17.11: в «последнем шансе» звали на производство, а кто проводит — не сказано → и там тоже.
    if (!PRODUCTION_RE.test(t) || !INVITE_RE.test(t)) continue;
    if (!/заведующ/i.test(x.goal || '')) x.goal = `${x.goal || ''}${PRODUCTION_WHO_NOTE}`;
    if (big && !(x.goal || '').includes(PRODUCTION_BIG_NOTE)) x.goal = `${x.goal}${PRODUCTION_BIG_NOTE}`;
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
  target.goal = PRODUCTION_GOAL + (Number(dealSize) >= BIG_DEAL ? PRODUCTION_BIG_NOTE : '');
  target.production_meeting = true;
  if (/кружок/i.test(String(target.channel || ''))) target.channel = 'WhatsApp';
  target.kind = 'экспертное';
  return steps;
}

// Разнообразие инструментов доверия (владелец 16.11: «не хватает вариативности — увидел только встречу
// на производстве; есть и другие инструменты — разбивка платежа 70/30 и т. д.; странно, если клиент не
// покупает, а менеджер повторяет одно и то же»). Каждое касание на Д — свой инструмент, без повтора.
// Все — факты из `industry/signage.md`, через выгоду клиента.
const TRUST_TOOLS = [
  'визуализация на фото фасада клиента бесплатно — он видит результат до оплаты',
  'ОТК и договор — комплексный результат: ОТК полностью проверяет вывеску на неисправности и соответствие ТЗ в договоре; вы получаете результат в срок и без переделок; гарантия — правило в договоре, выезд за 3 рабочих дня',
  'оплата частями 70/30 (по согласованию): остаток — перед отгрузкой, после проверки ОТК; клиент платит за уже готовую и проверенную вывеску, риск на нас',
  'слот на производстве под его дату открытия — дата держится, от поставщиков не зависим (своё производство)',
  'кейс из раздела «Кейсы» industry/signage.md, похожий по типу бизнеса — с названием, без выдумок'
];
function diversifyTrust(steps) {
  let k = 0;
  for (const x of steps) {
    if (x.conditional || x.production_meeting || x.lastChance) continue;
    if (x.criterion !== 'Д' && !(x.also || []).includes('Д')) continue;
    if (/кружок/i.test(String(x.channel || ''))) continue; // кружок — интрига, не довод
    const tool = TRUST_TOOLS[k++ % TRUST_TOOLS.length];
    x.goal = `${x.goal ? `${x.goal}. ` : ''}Инструмент доверия этого касания: ${tool}. Доводы других касаний не повторять.`;
    x.trust_tool = tool;
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
// Владелец 16.11 (живой «Дента Плюс»): в «последнем шансе» не хватает открытости и напора (в хорошем
// смысле) и сбора обратной связи — почему не купили. «Что я сделал не так? В открытую» оставляет дверь
// открытой, снова вовлекает в диалог и полезно компании. «В последний раз» → «финально».
const LAST_CHANCE_GOAL = 'Последний шанс (финальное касание): открыто и с напором в хорошем смысле — «решил финально набрать / написать, скажите как есть: проект актуален?». Если да — сразу конкретный шаг с датой и что это даёт клиенту (своими словами, напр. «договоримся сегодня — и вывеска у вас к открытию [дата]»). Если нет — собрать обратную связь: «Можете сказать в открытую, что я сделал не так? Мне правда важно — может, мы что-то упустили». Тепло, без обиды и давления; не отвлекать больше, чтобы не тратить время клиента; дверь открыта.';

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
const NOT_MOSCOW_RE = /(област|обл\.|подмосков|край\b|республик|санкт-петербург|спб|петербург|казан|екатеринбург|новосибирск|краснодар|нижн[а-яё]* новгород|самар|ростов|уф[аеы]\b|перм|воронеж|тул[аеы]\b|твер|калуг|ярослав|владимир|рязан|химк|подольск|люберц|мытищ|балаших|красногорск|одинцов|королёв|королев)/i;
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
    const nextRegular = steps.findIndex((x, i) => i > firstRegular && !x.conditional && !x.sameContact);
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
      if (s.kind === 'экспертное') {
        const day = s.day > prev.day + 1 ? Math.floor((prev.day + s.day) / 2) : prev.day + 1;
        if (s.day <= day) s.day = day + 1;
        ordered.push({ orig: null, day, conditional: false, sameContact: false, condition: '', channel: 'Кружок', kind: 'эмпатичное',
          recipient: prev.recipient, goal: 'Кружок-интрига (правило 73): повод — конкретная деталь проекта клиента → «появилась идея, уверен, вас заинтересует» → «можем коротко набраться — всё объясню по телефону?»; саму идею не раскрывать', key_message: '', value: 'клиент видит, что о его проекте думают и работают', inserted: true });
      } else {
        s.kind = 'экспертное';
        if (/кружок|видео|голосов/i.test(s.channel)) s.channel = 'WhatsApp';
      }
    }
    ordered.push(s);
    prev = ordered[ordered.length - 1];
  }
  steps = ordered;

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
    lastChance.goal = LAST_CHANCE_GOAL;
  }

  steps = noteZoom(noteProductionMeetings(diversifyTrust(steps), context.dealSize), context.source);

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
      ? `${s.condition || 'Только при условии'}${consent ? ' — после согласия, в тот же день' : condDate}`
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
  const lines = plan.map((p) => `${p.touchpoint_number}. ${p.condition ? `только если: ${p.condition.replace(/^только если\s*/i, '')}` : p.timing} · ${p.channel} · ${p.kind}${p.criterion ? ` · ${p.criterion.split(' —')[0]}` : ''}${p.recipient ? ` — ${p.recipient}` : ''}${p.goal ? `: ${p.goal}` : ''}`);
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
    return p ? { ...m, channel: p.channel, timing: p.timing, kind: p.kind, criterion: p.criterion || null, last_chance: !!p.last_chance } : m;
  });
  return { ...composerOutput, messages };
}

module.exports = { contextHints, NOT_MOSCOW_RE, buildTouchPlan, formatTouchPlan, pinToPlan, factsFor, criteriaToMove, criterionOf, CRITERIA };

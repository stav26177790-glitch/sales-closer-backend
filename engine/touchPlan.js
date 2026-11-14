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
    goal: 'Снять вопрос денег персональным предложением: что стоит за ценой (бюджет, с чем сравнивают), что входит в цену КП; при «дорого» — варианты под бюджет с честным «это отход от ТЗ, вот риск». Без скидки.' },
  ОП: { key: 'need', label: 'ОП — осознанная потребность',
    goal: 'Укрепить потребность: что клиент получает с вывеской к своей дате — через его триггер.' },
  ЛПР: { key: 'authority', label: 'ЛПР — определён',
    goal: 'Дать контактному лицу готовый материал для ЛПР или предложить короткий совместный звонок — только с его согласия.' },
  Д: { key: 'trust', label: 'Д — доверие',
    goal: 'Добавить доверия через КЕЙС, в котором клиент увидит себя: под его слова (бюджет → бюджетный, качество → металл, «как на первой точке» → та же конструкция) и тот же тип бизнеса — из кейсов компании (файл отрасли): название, что сделали, где посмотреть.' },
  ЗС: { key: 'urgency', label: 'ЗС — здесь и сейчас',
    goal: 'Перевести в «здесь и сейчас» как заботу о планах клиента: сроки на день отправки, предложить забронировать слот на производстве, один конкретный шаг (Давайте / Чтобы / Если / То).' }
};
// Порядок как в «Правиле 7 касаний» владельца: кейсы (Д) → дедлайн (ЗС) → персональное (ФВ).
const CRITERIA_ORDER = ['ЛПР', 'Д', 'ЗС', 'ФВ', 'ОП'];
const MAX_TOUCHES = 7; // спящий режим — после 7 касаний без ответа
const CALM_GAP = 3;    // рабочих дней между касаниями, когда срок не горит
// Срочно: есть дата клиента и запас не больше 5 рабочих дней (или уже не успеваем).
const isUrgent = (tl) => !!tl && (tl.status !== 'с запасом' || Number(tl.buffer_working_days) <= 5);
const LAST_CHANCE_GOAL = 'Последний шанс: попросить клиента сказать как есть — актуален ли проект, и если нет, не отвлекать его больше, чтобы не тратить его время. Тепло, без давления и без обиды; дверь открыта.';

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
    out.push('Экспертный повод (902-ПП): клиент писал про козырёк — в Москве на самом козырьке вывеску нельзя, только во фризе козырька (п. 18.3.4). Спросить, есть ли у козырька фриз и какой высоты, — как заботу, чтобы вывеску не пришлось снимать. Без пугалок.');
  } else if (moscow && /фриз/i.test(src)) {
    out.push('Экспертный повод (902-ПП): у фасада есть фриз — вывеска только на нём, буквы до 70% высоты фриза (п. 18.3). Уточнить высоту фриза — как заботу.');
  }
  // Методика переписки владельца: зависло больше 2 недель — обязательно кружок с новой идеей.
  if (Number(context?.daysSilent) >= 14) {
    out.push({ kind: 'эмпатичное', text: 'Реанимация (тишина больше 2 недель): кружок с новой идеей по проекту — «появилась пара идей по вашему проекту, уверен, вам будет интересно». Идея — реальная (кейс, повод из переписки), не выдуманная.' });
  }
  if (/«[^»]*[A-Za-z]{2,}[^»]*»|\b[A-Z]{3,}\b/.test(`${client}\n${src}`)) {
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
const SILENCE_RE = /нет ответа|не ответ|без ответа|не организ|не дал|не даст|молч|не получ|не согласовал|не вернул/i;
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
      ? `Временная вывеска к открытию ещё успевает: запустить не позже ${humanDate(b.latest_start_date)}. Эта дата — только для неё. В Москве — только внутри помещения (на фасаде 902-ПП запрещает баннерную ткань); не в Москве — на фасаде, если позволяют правила города.`
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
  for (const s of steps) {
    if (s.conditional) continue;
    if (s.sameContact) s.day = lastDay; else lastDay = s.day;
  }

  // «Есть ли шанс / честный ответ» в середине цепочки — убираем: это вопрос только
  // «последнего шанса», его код ставит последним сам (прогон 14.11, касание 6 «Зерна»).
  const LC_GOAL_RE = /шанс|честн[а-яё]* ответ|сделка потеряна|скажите как есть|проект ещё (актуал|в приоритет)/i;
  const regularIdx = steps.map((x, i) => (!x.conditional && !x.sameContact ? i : -1)).filter((i) => i >= 0);
  const lastRegular = regularIdx[regularIdx.length - 1];
  steps = steps.filter((x, i) => x.conditional || x.sameContact || i === lastRegular || !LC_GOAL_RE.test(`${x.goal || ''} ${x.key_message || ''}`));

  // Все неподтверждённые критерии формулы закрытия — хотя бы в одном касании.
  steps = coverCriteria(steps, scores);

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
          recipient: prev.recipient, goal: 'Кружок с поводом: реальная деталь проекта клиента или новая идея по нему (кейс, вопрос по макету, звонок на производство) — тепло, 20–40 секунд, один шаг, без продажи в лоб', key_message: '', value: 'клиент видит, что о его проекте думают и работают', inserted: true });
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
  for (const x of steps) {
    const money = x.criterion === 'ФВ' || (x.also || []).includes('ФВ');
    if (money && !/звонок|zoom|зум|видеозвон|встреч/i.test(String(x.channel || ''))) { x.channel = 'Звонок'; x.kind = 'экспертное'; }
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
  const lastChance = own.length >= 3 ? own[own.length - 1] : null;
  if (lastChance) {
    // Его критерий (если был) переносим на предыдущее касание — покрытие формулы не теряем.
    const lost = [lastChance.criterion, ...(lastChance.also || [])].filter((c) => c && c !== 'ЗС');
    for (const c of lost) {
      const host = own.slice(0, -1).filter((x) => c === 'ОП' || c === 'ЛПР' || x.kind === 'экспертное').pop();
      const coveredElsewhere = steps.some((x) => x !== lastChance && !x.conditional && (x.criterion === c || (x.also || []).includes(c)));
      if (!coveredElsewhere && host) { host.also = [...(host.also || []), c]; host.goal = [host.goal, `Заодно (${CRITERIA[c].label}): ${CRITERIA[c].goal}`].filter(Boolean).join(' '); }
    }
    lastChance.lastChance = true;
    lastChance.criterion = 'ЗС';
    lastChance.also = [];
    lastChance.goal = LAST_CHANCE_GOAL;
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
      weekend
    };
  });
}

// Для менеджера под стратегией: «1. 13 ноября (пт) · Звонок · экспертное — Марине: цель».
function formatTouchPlan(plan) {
  if (!Array.isArray(plan) || !plan.length) return '';
  const lines = plan.map((p) => `${p.touchpoint_number}. ${p.condition ? `только если: ${p.condition.replace(/^только если\s*/i, '')}` : p.timing} · ${p.channel} · ${p.kind}${p.criterion ? ` · ${p.criterion.split(' —')[0]}` : ''}${p.recipient ? ` — ${p.recipient}` : ''}${p.goal ? `: ${p.goal}` : ''}`);
  return `### План касаний\n\n${lines.join('\n')}`;
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

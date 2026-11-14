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
const { addWorkingDays, humanDate, computeTimeline } = require('./timeline');

const DEFAULT_DAYS = [0, 1, 3, 5, 8, 11, 15];

const isConditional = (s) => /только если|если (марина|он|она|контакт)|после согласия/i.test(String(s?.condition || '') + ' ' + String(s?.timing || ''));
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
      ? `Временная вывеска к открытию ещё успевает: запустить не позже ${humanDate(b.latest_start_date)}. Эта дата — только для неё.`
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
function buildTouchPlan(strategyOutput, timeline, today) {
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
    value: s?.value_for_client || ''
  }));

  // «Сразу после / в тот же день после звонка» — тот же день, что предыдущий шаг.
  let lastDay = 0;
  for (const s of steps) {
    if (s.conditional) continue;
    if (s.sameContact) s.day = lastDay; else lastDay = s.day;
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
          recipient: prev.recipient, goal: 'Коротко и тепло поддержать: участие в ситуации клиента, главный шаг — без давления', key_message: '', value: 'клиенту спокойнее: о нём помнят и помогают', inserted: true });
      } else {
        s.kind = 'экспертное';
        if (/кружок|видео|голосов/i.test(s.channel)) s.channel = 'WhatsApp';
      }
    }
    ordered.push(s);
    prev = ordered[ordered.length - 1];
  }
  steps = ordered;

  return steps.map((s, i) => {
    const send = s.conditional ? null : (s.day === 0 ? today : addWorkingDays(today, s.day));
    const dateText = send ? humanDate(send) : null;
    // «После согласия, в тот же день» — только для условий-согласий (контакт, звонок).
    // Живой «Зерно 6»: «Только если Марина не ответила на касания 1–2 — после
    // согласия, в тот же день» — бессмыслица; для «не ответила» — дата из плана.
    // «не организовала / не дала / не ответила» — условие отказа/молчания, не согласия (живой «Зерно 6»).
    const consent = /контакт|соглас|организ|даст|разреш/i.test(String(s.condition || '')) && !/\bне\s+(организ|дал|даст|соглас|ответ|разреш)|не\s+(организ|дал|даст|соглас|ответ|разреш)/i.test(String(s.condition || ''));
    const condDate = !consent && s.day > 0 ? `, не раньше ${humanDate(addWorkingDays(today, s.day))}` : '';
    const timing = s.conditional
      ? `${s.condition || 'Только при условии'}${consent ? ' — после согласия, в тот же день' : condDate}`
      : s.sameContact ? `${dateText}, сразу после предыдущего касания` : `${s.day === 0 ? 'Сегодня, ' : ''}${dateText}`;
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
      must_include: s.orig != null ? (byOrig[s.orig] || []) : [],
      facts: factsFor(send || today, timeline),
      inserted: !!s.inserted
    };
  });
}

// Для менеджера под стратегией: «1. 13 ноября (пт) · Звонок · экспертное — Марине: цель».
function formatTouchPlan(plan) {
  if (!Array.isArray(plan) || !plan.length) return '';
  const lines = plan.map((p) => `${p.touchpoint_number}. ${p.condition ? `только если: ${p.condition.replace(/^только если\s*/i, '')}` : p.timing} · ${p.channel} · ${p.kind}${p.recipient ? ` — ${p.recipient}` : ''}${p.goal ? `: ${p.goal}` : ''}`);
  return `### План касаний\n\n${lines.join('\n')}`;
}

// После writer: канал, дата и тип — из плана (модель их не меняет).
function pinToPlan(composerOutput, plan) {
  const msgs = composerOutput?.messages;
  if (!Array.isArray(msgs) || !Array.isArray(plan)) return composerOutput;
  const messages = msgs.map((m, i) => {
    const p = plan.find((x) => x.touchpoint_number === Number(m?.touchpoint_number ?? i + 1));
    return p ? { ...m, channel: p.channel, timing: p.timing, kind: p.kind } : m;
  });
  return { ...composerOutput, messages };
}

module.exports = { buildTouchPlan, formatTouchPlan, pinToPlan, factsFor };

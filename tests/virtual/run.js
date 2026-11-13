/**
 * Виртуальный прогон: 8 разных сделок (tests/virtual/deals.js) через настоящий
 * advance() — ответы агентов сыграны по их промптам (2026-11-13), — плюс
 * автопроверки: мусор в чате, входы агентов, блок «Сроки», отрасль, даты
 * в касаниях против расчёта, выдуманные факты, запрещённые фразы,
 * «Обязательно в касаниях». «Сегодня» зафиксировано: 13.11.2026.
 *   node tests/virtual/run.js          — сводка находок (код выхода 1, если есть)
 *   node tests/virtual/run.js --full   — плюс весь текст для менеджера
 */
process.env.KLOUZER_TODAY = '2026-11-13';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FULL = process.argv.includes('--full');
const _log = console.log;
console.log = (...a) => { if (FULL || String(a[0]).startsWith('\n\n════') || String(a[0]).startsWith('[') && !String(a[0]).startsWith('[agentRunner') && !String(a[0]).startsWith('[must_include') ) _log(...a); };
const { runScenario } = require(path.join(ROOT, 'tests/harness'));
const { findBannedPhrases } = require(path.join(ROOT, 'engine/phraseCheck'));
const deals = require('./deals');
console.warn = () => {};

const MONTHS = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
const dateRe = new RegExp(`\\b(\\d{1,2})(?:[–-](\\d{1,2}))?\\s+(${MONTHS})`, 'g');
const numDateRe = /\b(\d{1,2})\.(\d{1,2})\b/g;

function datesIn(text) {
  const out = new Set();
  for (const m of text.matchAll(dateRe)) { out.add(`${m[1]} ${m[3]}`); if (m[2]) out.add(`${m[2]} ${m[3]}`); }
  for (const m of text.matchAll(numDateRe)) { out.add(`${Number(m[1])}.${m[2]}`); const mo = MONTHS.split('|')[Number(m[2]) - 1]; if (mo) out.add(`${Number(m[1])} ${mo}`); }
  return out;
}

const report = [];
const issue = (deal, sev, what) => report.push({ deal, sev, what });

(async () => {
  for (const d of deals) {
    if (d.agents._reviewerTwice) { d.agents.reviewer.push(d.agents.reviewer[0]); delete d.agents._reviewerTwice; }
    let r;
    try { r = await runScenario(d); } catch (e) { issue(d.name, 'КРИТИЧНО', `прогон упал: ${e.message}`); continue; }
    console.log(`\n\n████ ${d.name} — ${d.description}`);
    console.log('Путь:', r.steps.map((s) => s.nextState).join(' → '));
    if (r.unusedAgentResponses.length) issue(d.name, 'код', `не вызваны агенты, хотя ответы заготовлены: ${r.unusedAgentResponses.join(', ')}`);

    const allChat = r.steps.map((s) => s.chatText).join('\n\n');
    r.steps.forEach((s, i) => console.log(`\n--- шаг ${i + 1} [${s.stateBefore} → ${s.nextState}] менеджер: «${s.message.slice(0, 60).replace(/\n/g, ' ')}…»\n${s.chatText}`));

    // 1. Мусор в чате
    for (const bad of ['undefined', '[object Object]', 'NaN', '"status"', 'StakeholderExpansion', 'RiskReduction', 'EconomicValue']) {
      if (allChat.includes(bad)) issue(d.name, 'чат', `в тексте для менеджера «${bad}»`);
    }
    if (/^\s*[{[]/m.test(allChat) && /"\w+":/.test(allChat)) issue(d.name, 'чат', 'в чате сырой JSON');

    // 2. Входы агентов
    const calls = r.steps.flatMap((s) => s.agentCalls);
    for (const c of calls) {
      const m = c.input?.materials || {};
      const src = m.source_materials?.text || '';
      if (['strategy', 'composer', 'reviewer'].includes(c.agent) && !src.includes(d.messages[0].slice(0, 40))) {
        issue(d.name, 'вход', `${c.agent} не видит исходную переписку`);
      }
      if (['composer', 'reviewer', 'advisor'].includes(c.agent) && !c.input.diagnostic_output) {
        issue(d.name, 'вход', `${c.agent} не получает diagnostic_output (промпт на него ссылается: триггеры клиента с цитатами, блокер)`);
      }
    }
    const tl = calls.find((c) => c.input?.timeline !== undefined)?.input.timeline;

    // 3. Блок «Сроки»
    const hasDeadline = !!d.deal.client_deadline;
    const diagStep = r.steps.find((s) => s.agentCalls.some((c) => c.agent === 'diagnostic'));
    if (diagStep) {
      if (hasDeadline && !diagStep.chatText.includes('## Сроки —')) issue(d.name, 'чат', 'нет блока «Сроки» после оценки, хотя сроки заданы');
      if (!hasDeadline && !diagStep.chatText.includes('Сроки не посчитаны')) issue(d.name, 'чат', 'нет пометки «Сроки не посчитаны»');
    }
    if (d.deal.industry !== 'signage' && tl && /вывеск|баннер|монтаж/i.test(JSON.stringify(tl))) {
      issue(d.name, 'код', `расчёт сроков для отрасли ${d.deal.industry} говорит о вывеске/баннере/монтаже: «${(tl.summary.match(/[^.]*(вывеск|баннер|монтаж)[^.]*/i) || [''])[0].trim()}»`);
    }

    // 4. Касания
    const composerOut = [...r.steps].reverse().find((s) => s.dbPatches.some((p) => p.last_composer_output))?.dbPatches.find((p) => p.last_composer_output)?.last_composer_output;
    const msgs = composerOut?.messages || [];
    const allowedDates = new Set([...datesIn(JSON.stringify(tl || {}).replace(/\\n/g, ' ')), ...datesIn(d.messages.join(' '))]);
    if (tl) {
      // даты из ISO в расчёте
      for (const iso of JSON.stringify(tl).match(/\d{4}-\d{2}-\d{2}/g) || []) {
        const [y, mo, da] = iso.split('-');
        allowedDates.add(`${Number(da)} ${MONTHS.split('|')[Number(mo) - 1]}`);
        allowedDates.add(`${Number(da)}.${mo}`);
      }
    }
    msgs.forEach((m) => {
      const text = [m.subject, m.body].filter(Boolean).join('\n');
      for (const dt of datesIn(text)) if (!allowedDates.has(dt)) issue(d.name, 'касание', `касание ${m.touchpoint_number}: дата «${dt}» не из расчёта и не из переписки`);
      if (d.deal.industry !== 'signage' && /вывеск|баннер/i.test(text)) issue(d.name, 'касание', `касание ${m.touchpoint_number}: вывеска/баннер в сделке не по вывескам`);
      if ((!tl || !tl.temp_banner) && /временн\w* вывеск|баннер/i.test(text)) issue(d.name, 'касание', `касание ${m.touchpoint_number}: временная вывеска, хотя расчёт её не даёт`);
      if (/гаранти[а-яё]*[^.]{0,20}\b([2-9]|\d{2,})\s*(год|лет)|рейтинг|отзыв|\b\d+\s*%\s*клиент/i.test(text)) issue(d.name, 'касание', `касание ${m.touchpoint_number}: похоже на выдуманный факт/цифру`);
      console.log(`  [длина] касание ${m.touchpoint_number} (${m.channel}): ${String(m.body||'').length} симв.`);
      if (!m.timing) issue(d.name, 'касание', `касание ${m.touchpoint_number}: нет timing`);
    });
    for (const h of findBannedPhrases(msgs)) issue(d.name, 'касание', `касание ${h.touchpoint_number}: запрещённая фраза`);

    // 5. Обязательно в касаниях
    const strat = calls.find((c) => c.agent === 'composer')?.input.strategy_output;
    const mi = strat?.must_include || [];
    console.log(`\n[must_include: ${mi.length}]`);
    mi.forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
    const cover = composerOut?.must_include_coverage || [];
    if (mi.length && cover.length !== mi.length) issue(d.name, 'обязательное', `composer отчитался о ${cover.length} пунктах из ${mi.length}`);
  }

  console.log('\n\n════════ НАЙДЕНО ════════');
  for (const x of report) console.log(`[${x.sev}] ${x.deal}: ${x.what}`);
  _log(`virtual: ${deals.length} сделок, находок: ${report.length}`);
  if (report.length) process.exitCode = 1;
})();

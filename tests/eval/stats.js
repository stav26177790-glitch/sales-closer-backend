#!/usr/bin/env node
'use strict';
/**
 * tests/eval/stats.js — накопленная статистика прогонов симулятора: на чём Клоузер теряет «как есть».
 * Владелец 18.11: «накопи статистику — будет понятен вектор, куда копать».
 *
 * Запуск (нужна папка с отчётами — ветка eval-reports):
 *   node tests/eval/stats.js <папка eval-reports> [--since 2026-11-18] [--last 5] [--full-only] [--drops]
 * --drops — просадки: два последних прогона выборки, по ситуациям и причинам (⚠ — хуже).
 * --full-only — только прогоны, где ситуаций ≥ 20 (полные; частичные прогоны 24 / 25 перекашивают картину).
 *
 * Причины судьи пишутся по-разному («деньги письменно», «⛔ ошибка 6. Деньги письменно при доступном голосе», …) —
 * сводим в категории по ключевым словам (CATEGORIES). Касание с несколькими причинами учитывается в каждой.
 */
const fs = require('fs');
const path = require('path');

const CATEGORIES = [
  ['Деньги письменно', /деньги письменно|деньги в переписк|бюджет[а-яё]* (в переписк|письменн)|письменно[^.]{0,30}(цен|деньг|бюджет)/i],
  ['Обещание срока', /обещани[ея] срока|к открытию|сроки по facts|^сроки|срок[а-яё]* (по|из|не по) (факт|расч|facts)|честность о срок|временная вывеска|ошибка 2/i],
  ['Цена клиента / торг', /цена клиента|уступк|торг|скидк[а-яё]* без|сначала согласие, потом деньги|ошибка 1\b|^1\./i],
  ['Менеджер сам едет / проводит', /сам едет|сам проводит|личная встреча|выезд менеджера|встреча на производстве|ошибка 7/i],
  ['Выдуманный факт / кейс', /выдуман|факты — только|кейс|ошибка 4/i],
  ['Упрёк клиенту', /упрёк|упрек|ошибка 3/i],
  ['902-ПП', /902/i],
  ['Род глаголов', /род глагол|ошибка 8/i],
  ['ИИ-калька / неживая речь', /калька|неживая|ии-штамп|живой язык|штамп/i],
  ['Повтор довода / формулировки', /повтор/i],
  ['Повод', /повод/i],
  ['ЛДПР', /лдпр/i],
  ['Закрывающий вопрос / температура', /закрывающ|температур/i],
  ['Квадратные скобки / пустые места', /скобк|пустые места/i],
  ['Последний шанс / обратная связь', /последний шанс|обратн[а-яё]* связ/i],
  ['Инструмент доверия', /инструмент доверия/i],
  ['Сценарий «Негатив»', /негатив/i],
  ['Цель / принцип пути / канал', /цел[ьи] плана|не выполняет цель|принцип пути|^канал/i],
  ['Много вопросов', /много вопросов|один вопрос за касание/i],
  ['Выгода клиента', /выгод/i],
  ['Закрытый критерий / режим', /закрыт[а-яё]* критери|режим/i],
  ['Кружок', /кружок|кружке/i]
];
const catOf = (text) => (CATEGORIES.find(([, re]) => re.test(String(text || ''))) || ['Прочее'])[0];

function loadRuns(root, { since = '', last = 0, fullOnly = false } = {}) {
  const dir = path.join(root, 'runs');
  let names = fs.readdirSync(dir).filter((d) => d >= since && fs.existsSync(path.join(dir, d, 'report.json'))).sort();
  let runs = names.map((d) => ({ name: d, r: JSON.parse(fs.readFileSync(path.join(dir, d, 'report.json'), 'utf8')) }));
  if (fullOnly) runs = runs.filter((x) => (x.r.results || []).length >= 20);
  if (last) runs = runs.slice(-last);
  return runs;
}

function stats(runs) {
  const cats = {};
  let total = 0; let ok = 0; let fix = 0; let no = 0;
  const perRun = [];
  for (const { name, r } of runs) {
    let t = 0; let o = 0; let nn = 0;
    for (const x of r.results || []) {
      const v = x.verdict || {};
      for (const tch of v.touches || []) {
        const send = String(tch.send || '');
        const isNo = /^нет/.test(send); const isFix = /правк/.test(send);
        total++; t++;
        if (isNo) { no++; nn++; } else if (isFix) fix++; else { ok++; o++; }
        const seen = new Set();
        for (const i of tch.issues || []) {
          const c = catOf(`${i.rule} ${i.comment || ''}`.slice(0, 120));
          if (seen.has(c)) continue; seen.add(c);
          const e = cats[c] = cats[c] || { no: 0, fix: 0 };
          if (isNo) e.no++; else if (isFix) e.fix++;
        }
      }
    }
    perRun.push({ name, touches: t, ok: o, no: nn });
  }
  return { total, ok, fix, no, cats, perRun };
}

// Просадки (владелец 19.11: «отмечай статистику — где просадки; это выявит уязвимости»): сравнение двух прогонов
// по каждой ситуации (как есть, «нет», ожидания) и по каждой причине. ⚠ — хуже на порог и больше.
function bySituation(run) {
  const out = {};
  for (const x of run.r.results || []) {
    const v = x.verdict || {};
    const t = v.touches || [];
    const ok = t.filter((y) => !/^нет|правк/.test(String(y.send || ''))).length;
    const no = t.filter((y) => /^нет/.test(String(y.send || ''))).length;
    const ex = Array.isArray(v.expectations) ? v.expectations : [];
    const exOk = ex.filter((e) => e.met === true || /^да/i.test(String(e.met || e.status || ''))).length;
    out[x.id] = { title: x.title || '', n: t.length, ok, no, pct: t.length ? Math.round((ok / t.length) * 100) : null, ex: ex.length ? `${exOk}/${ex.length}` : '', exPct: ex.length ? exOk / ex.length : null };
  }
  return out;
}
function drops(a, b, { pctDrop = 20, noRise = 2 } = {}) {
  const A = bySituation(a); const B = bySituation(b);
  const rows = [];
  for (const id of Object.keys(B).sort((x, y) => x - y)) {
    const p = A[id]; const q = B[id];
    if (!p || q.n === 0 || p.n === 0) { rows.push({ id, q, p, flag: q.n === 0 ? '⚠ 0 касаний оценено' : '' }); continue; }
    const flags = [];
    if (q.pct !== null && p.pct !== null && p.pct - q.pct >= pctDrop) flags.push(`как есть ${p.pct}% → ${q.pct}%`);
    if (q.no - p.no >= noRise) flags.push(`«нет» ${p.no} → ${q.no}`);
    if (p.exPct !== null && q.exPct !== null && p.exPct - q.exPct >= 0.2) flags.push(`ожидания ${p.ex} → ${q.ex}`);
    rows.push({ id, p, q, flag: flags.length ? `⚠ ${flags.join('; ')}` : '' });
  }
  const ca = stats([a]).cats; const cb = stats([b]).cats;
  const catRows = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].map((c) => ({ c, a: ca[c] || { no: 0, fix: 0 }, b: cb[c] || { no: 0, fix: 0 } }))
    .map((r) => ({ ...r, d: (r.b.no - r.a.no) * 2 + (r.b.fix - r.a.fix) })).sort((x, y) => y.d - x.d);
  return { rows, catRows };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--') && !/^\d/.test(a));
  if (!root) { console.error('Укажите папку с отчётами (ветка eval-reports).'); process.exit(1); }
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const runs = loadRuns(root, { since: val('--since') || '', last: Number(val('--last') || 0), fullOnly: args.includes('--full-only') });
  if (args.includes('--drops')) {
    // Два последних прогона из выборки (обычно с --full-only): было → стало.
    if (runs.length < 2) { console.error('Для просадок нужно минимум два прогона в выборке.'); process.exit(1); }
    const [a, b] = runs.slice(-2);
    const { rows, catRows } = drops(a, b);
    const sa = stats([a]); const sb = stats([b]);
    const pc = (s, k) => (s.total ? Math.round((s[k] / s.total) * 100) : 0);
    console.log(`Было: ${a.name.slice(0, 16)} — как есть ${pc(sa, 'ok')}%, нет ${pc(sa, 'no')}% (${sa.total} кас.)`);
    console.log(`Стало: ${b.name.slice(0, 16)} — как есть ${pc(sb, 'ok')}%, нет ${pc(sb, 'no')}% (${sb.total} кас.)\n`);
    console.log('По ситуациям (как есть %, «нет», ожидания):');
    for (const r of rows) {
      const f = (x) => (x ? `${x.pct ?? '—'}% / нет ${x.no} / ${x.ex || '—'}` : '—');
      console.log(`  ${String(r.id).padStart(2)} ${String(r.q.title || '').slice(0, 26).padEnd(26)} ${f(r.p).padEnd(22)} → ${f(r.q).padEnd(22)} ${r.flag}`);
    }
    console.log('\nПричины (нет / правка): было → стало; сверху — что ухудшилось');
    for (const r of catRows) console.log(`  ${r.d > 0 ? '⚠' : r.d < 0 ? '✓' : ' '} ${r.c.padEnd(34)} ${r.a.no}/${r.a.fix} → ${r.b.no}/${r.b.fix}`);
    process.exit(0);
  }
  const s = stats(runs);
  const pct = (a) => (s.total ? Math.round((a / s.total) * 100) : 0);
  console.log(`Прогонов: ${runs.length}. Касаний: ${s.total} — как есть ${s.ok} (${pct(s.ok)}%), с правкой ${s.fix}, нет ${s.no}. Планка владельца — 80%.\n`);
  console.log('Причины (касание с несколькими причинами — в каждой):');
  console.log('  нет | правка | категория');
  for (const [c, e] of Object.entries(s.cats).sort((a, b) => b[1].no - a[1].no || b[1].fix - a[1].fix)) {
    console.log(`${String(e.no).padStart(5)} | ${String(e.fix).padStart(6)} | ${c}`);
  }
  console.log('\nПо прогонам:');
  for (const r of s.perRun) console.log(`  ${r.name.slice(0, 16)}: ${r.touches} касаний, как есть ${r.touches ? Math.round((r.ok / r.touches) * 100) : 0}%, нет ${r.no}`);
}

module.exports = { stats, loadRuns, catOf, CATEGORIES, bySituation, drops };

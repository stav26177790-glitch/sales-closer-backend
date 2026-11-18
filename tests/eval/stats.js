#!/usr/bin/env node
'use strict';
/**
 * tests/eval/stats.js — накопленная статистика прогонов симулятора: на чём Клоузер теряет «как есть».
 * Владелец 18.11: «накопи статистику — будет понятен вектор, куда копать».
 *
 * Запуск (нужна папка с отчётами — ветка eval-reports):
 *   node tests/eval/stats.js <папка eval-reports> [--since 2026-11-18] [--last 5] [--full-only]
 * --full-only — только прогоны, где ситуаций ≥ 20 (полные; частичные прогоны 24 / 25 перекашивают картину).
 *
 * Причины судьи пишутся по-разному («деньги письменно», «⛔ ошибка 6. Деньги письменно при доступном голосе», …) —
 * сводим в категории по ключевым словам (CATEGORIES). Касание с несколькими причинами учитывается в каждой.
 */
const fs = require('fs');
const path = require('path');

const CATEGORIES = [
  ['Деньги письменно', /деньги письменно|бюджет[а-яё]* (в переписк|письменн)|письменно[^.]{0,30}(цен|деньг|бюджет)/i],
  ['Обещание срока', /обещани[ея] срока|к открытию|сроки по facts|^сроки$|ошибка 2/i],
  ['Цена клиента / торг', /цена клиента|уступк|торг|ошибка 1\b|^1\./i],
  ['Менеджер сам едет / проводит', /сам едет|сам проводит|ошибка 7/i],
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
  ['Последний шанс', /последний шанс/i],
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

if (require.main === module) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--') && !/^\d/.test(a));
  if (!root) { console.error('Укажите папку с отчётами (ветка eval-reports).'); process.exit(1); }
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const runs = loadRuns(root, { since: val('--since') || '', last: Number(val('--last') || 0), fullOnly: args.includes('--full-only') });
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

module.exports = { stats, loadRuns, catOf, CATEGORIES };

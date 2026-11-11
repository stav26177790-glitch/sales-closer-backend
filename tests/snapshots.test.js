#!/usr/bin/env node
/**
 * tests/snapshots.test.js — снимки поведения Клоузера.
 *
 * Прогоняет сценарии из tests/scenarios.js через настоящий stateMachine.js
 * (с моками базы и агентов) и сравнивает результат с сохранёнными снимками
 * в tests/__snapshots__/. Снимок фиксирует для каждого сообщения менеджера:
 * следующий этап, текст ответа в чате, вызовы агентов с их входом и запись
 * в базу.
 *
 * Зачем: при переупаковке (шаг 3 дорожной карты) поведение не должно
 * поменяться ни на символ. Любое отличие — тест красный и показывает, где.
 *
 *   node tests/snapshots.test.js            — сравнить
 *   node tests/snapshots.test.js --update   — перезаписать снимки (только
 *                                             если изменение поведения задумано)
 *   node tests/snapshots.test.js --only имя — один сценарий
 */
const fs = require('fs');
const path = require('path');
const { runScenario } = require('./harness');
const scenarios = require('./scenarios');

const SNAP_DIR = path.join(__dirname, '__snapshots__');
const update = process.argv.includes('--update');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null;

// Первое расхождение между двумя значениями — путь и оба значения.
function firstDiff(a, b, p = '') {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    return { path: p || '(корень)', expected: a, actual: b };
  }
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDiff(a[k], b[k], p ? `${p}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : { path: p, expected: a, actual: b };
}
const show = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 400 ? s.slice(0, 400) + '…' : s;
};

(async () => {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  // Шум из stateMachine (console.warn о дедупликации и т.п.) в тестах не нужен.
  const realWarn = console.warn;
  console.warn = () => {};

  let failed = 0;
  let written = 0;
  const list = scenarios.filter((s) => !only || s.name === only);
  if (!list.length) {
    console.error(`Сценарий "${only}" не найден`);
    process.exit(2);
  }

  for (const scenario of list) {
    const file = path.join(SNAP_DIR, `${scenario.name}.json`);
    let actual;
    try {
      actual = await runScenario(scenario);
    } catch (e) {
      failed++;
      console.log(`❌ ${scenario.name}: сценарий упал — ${e.message}`);
      continue;
    }
    if (actual.unusedAgentResponses.length) {
      failed++;
      console.log(`❌ ${scenario.name}: не все заготовленные ответы агентов использованы (${actual.unusedAgentResponses.join(', ')}) — поведение изменилось или сценарий неточен`);
      continue;
    }
    const json = JSON.stringify(actual, null, 2) + '\n';
    if (update || !fs.existsSync(file)) {
      fs.writeFileSync(file, json);
      written++;
      console.log(`📝 ${scenario.name}: снимок записан (${actual.steps.length} шаг.)`);
      continue;
    }
    const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
    const diff = firstDiff(expected, actual);
    if (diff) {
      failed++;
      console.log(`❌ ${scenario.name}: отличие в ${diff.path}`);
      console.log(`   было:  ${show(diff.expected)}`);
      console.log(`   стало: ${show(diff.actual)}`);
    } else {
      const route = [actual.steps[0]?.stateBefore, ...actual.steps.map((s) => s.nextState)].join(' → ');
      console.log(`✅ ${scenario.name}: ${route}`);
    }
  }

  console.warn = realWarn;
  console.log(`\nИтого: ${list.length - failed}/${list.length} сценариев совпали${written ? `, записано снимков: ${written}` : ''}.`);
  // advance() держит таймеры дедупликации на 15 с — не ждём их.
  process.exit(failed ? 1 : 0);
})();

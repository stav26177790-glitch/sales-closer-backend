#!/usr/bin/env node
/**
 * live-checks.js
 *
 * Проверки, которые ТРЕБУЮТ реального вызова LLM через agentRunner.callAgent().
 * Тратят токены на каждый прогон — гонять при изменении промптов, не на каждый коммит.
 *
 * Запуск:
 *   node live-checks.js --agent-runner /path/to/agentRunner.js [--only bug13_hedge_repetition] [--repeat 1]
 *   node live-checks.js --mock            # прогон БЕЗ реального API — только проверяет
 *                                          # плюмбинг харнесса (не является настоящим
 *                                          # регресс-тестом промптов, см. README)
 *
 * ВАЖНО: agentRunner.js не входит в этот пакет (не был передан в сессии 2).
 * Файл нужно указать через --agent-runner или положить рядом как ./agentRunner.js.
 * Ожидаемый интерфейс (см. вызовы в stateMachine.js):
 *   callAgent(agentName: string, input: object, maxTokens?: number) => Promise<object>
 * где возвращаемый объект — уже распарсенный JSON вида { <agent>_output: {...} }
 * (или сам {...} без обёртки — обе формы обрабатываются в fixtures через фоллбэк).
 */
const path = require('path');
const fixtures = require('./fixtures');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const MOCK = process.argv.includes('--mock');
const ONLY = arg('--only', null);
const REPEAT = parseInt(arg('--repeat', '1'), 10);
const RUNNER_PATH = arg('--agent-runner', path.join(process.cwd(), 'agentRunner.js'));

function loadCallAgent() {
  if (MOCK) {
    // Заглушка ТОЛЬКО для проверки, что харнесс (загрузка фикстур, сверка assert)
    // работает без синтаксических ошибок. НЕ проверяет реальное поведение промптов.
    return async (agentName, input) => {
      return { [`${agentName}_output`]: {} };
    };
  }
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(RUNNER_PATH);
    if (typeof mod.callAgent !== 'function') {
      throw new Error(`модуль ${RUNNER_PATH} не экспортирует функцию callAgent`);
    }
    return mod.callAgent;
  } catch (e) {
    console.error(`\n❌ Не удалось загрузить agentRunner.js по пути "${RUNNER_PATH}".`);
    console.error(`   ${e.message}`);
    console.error('   Укажите верный путь через --agent-runner <путь> или запустите с --mock для проверки харнесса.\n');
    process.exit(2);
  }
}

async function run() {
  const callAgent = loadCallAgent();
  const caseNames = Object.keys(fixtures).filter((k) => k !== 'TODAY' && (!ONLY || k === ONLY));
  if (!caseNames.length) {
    console.error(`Не найдено кейсов (--only=${ONLY}).`);
    process.exit(2);
  }

  console.log(`=== LIVE CHECKS ${MOCK ? '(MOCK — только плюмбинг харнесса, НЕ настоящий тест промптов)' : ''} ===\n`);
  let failCount = 0;
  const summary = [];

  for (const name of caseNames) {
    const testCase = fixtures[name];
    const runResults = [];
    for (let attempt = 1; attempt <= REPEAT; attempt++) {
      try {
        const output = await callAgent(testCase.agent, testCase.input, 8000);
        const result = testCase.assert(output);
        runResults.push({ attempt, ...result, raw: output });
      } catch (e) {
        runResults.push({ attempt, pass: false, detail: `исключение при вызове агента: ${e.message}` });
      }
    }
    const allPass = runResults.every((r) => r.pass);
    if (!allPass) failCount++;
    const mark = allPass ? '✅' : '❌';
    console.log(`${mark} [${name}] агент: ${testCase.agent}${REPEAT > 1 ? `, прогонов: ${REPEAT}` : ''}`);
    runResults.forEach((r) => {
      const prefix = REPEAT > 1 ? `   попытка ${r.attempt}: ` : '   ';
      console.log(`${prefix}${r.pass ? 'OK' : 'FAIL'} — ${r.detail}`);
    });
    console.log('');
    summary.push({ name, allPass, flaky: REPEAT > 1 && !allPass && runResults.some((r) => r.pass) });
  }

  console.log(`Итого: ${caseNames.length - failCount}/${caseNames.length} кейсов пройдено (все повторы).`);
  const flaky = summary.filter((s) => s.flaky);
  if (flaky.length) {
    console.log(`⚠️  Нестабильные результаты (прошли не все повторы): ${flaky.map((f) => f.name).join(', ')}`);
  }
  process.exit(failCount ? 1 : 0);
}

run();

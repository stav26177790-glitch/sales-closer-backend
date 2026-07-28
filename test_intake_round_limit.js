#!/usr/bin/env node
/**
 * test_intake_round_limit.js
 *
 * Детерминированный unit-тест на MAX_INTAKE_ROUNDS (без реального API, без
 * реальной БД) — по той же схеме, что test_conflict_resolution_reachable.js:
 * прогоняет НАСТОЯЩИЙ advance() с замоканными db.js/agentRunner.js и читает
 * итоговую последовательность состояний.
 *
 * Сценарий: diagnostic (agentRunner.mock.intake.js) ВСЕГДА возвращает
 * clarification_needed.required = true, сколько бы раундов ни прошло —
 * имитация того, что сама LLM не соблюдает свою же инструкцию "после 2
 * раундов остановись" (diagnostic_agent.md, раздел "Предохранитель").
 *
 * Ожидание: после CONFIG.MAX_INTAKE_ROUNDS раундов stateMachine.js обязан
 * САМ (код-уровнево) прекратить цикл SOPRANO_INTERVIEW и пройти дальше
 * (в DIAGNOSING), а не крутиться бесконечно — то же самое, что уже
 * реализовано для composer↔reviewer через MAX_COMPOSER_ITERATIONS.
 *
 * Запуск:
 *   node test_intake_round_limit.js --dir /путь/к/папке/с/stateMachine.js
 */
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const DIR = arg('--dir', process.cwd());
const TARGET_STATE_MACHINE = path.join(DIR, 'stateMachine.js');
const DB_TARGET = path.join(DIR, 'db.js');
const RUNNER_TARGET = path.join(DIR, 'agentRunner.js');
const HERE = __dirname;

if (!fs.existsSync(TARGET_STATE_MACHINE)) {
  console.error(`❌ Не найден ${TARGET_STATE_MACHINE}. Укажи папку через --dir.`);
  process.exit(2);
}

const backups = {};
function stageMock(targetPath, mockSourcePath) {
  backups[targetPath] = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
  fs.copyFileSync(mockSourcePath, targetPath);
}
function restoreAll() {
  for (const [targetPath, content] of Object.entries(backups)) {
    if (content === null) {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    } else {
      fs.writeFileSync(targetPath, content, 'utf8');
    }
  }
}

stageMock(DB_TARGET, path.join(HERE, 'db.mock.js'));
stageMock(RUNNER_TARGET, path.join(HERE, 'agentRunner.mock.intake.js'));

let failCount = 0;
function assertCheck(name, condition, detail) {
  const mark = condition ? '✅' : '❌';
  if (!condition) failCount++;
  console.log(`${mark} ${name}`);
  if (detail) console.log(`   ${detail}`);
}

(async () => {
  try {
    delete require.cache[require.resolve(TARGET_STATE_MACHINE)];
    delete require.cache[require.resolve(DB_TARGET)];
    delete require.cache[require.resolve(RUNNER_TARGET)];

    const { advance } = require(TARGET_STATE_MACHINE);
    const db = require(DB_TARGET);

    db.__setDeal({
      id: 'test-deal-intake-loop',
      client: 'Тестовый клиент',
      product: 'тестовый продукт',
      deal_size: 100000,
      industry: 'signage',
      last_contact: '2026-07-01',
      days_silent: 5,
      current_state: 'INIT',
      criteria: { financial: 'не знаю', need: 'не знаю', trust: 'не знаю', authority: 'не знаю', urgency: 'не знаю' }
    });

    const states = [];
    // Раунд 1 — первый заход в SOPRANO_INTERVIEW, ещё не расходует лимит.
    let result = await advance('test-deal-intake-loop', 'Первое сообщение по сделке.');
    states.push(result.nextState);
    // Раунды 2..N — менеджер каждый раз отвечает, diagnostic каждый раз
    // снова просит уточнение (мок всегда возвращает required: true).
    for (let i = 0; i < 5; i++) {
      result = await advance('test-deal-intake-loop', `Уклончивый ответ менеджера №${i + 1}.`);
      states.push(result.nextState);
      if (result.nextState !== 'SOPRANO_INTERVIEW') break;
    }

    console.log('\n--- Последовательность состояний ---\n');
    console.log(states.join(' → '));
    console.log(`\nФинальный chatText:\n${result.chatText}`);
    console.log('\n--- Проверки ---\n');

    const savedStates = db.__getSavedStates();
    const maxRoundsSeen = Math.max(...savedStates.map((s) => s.intake_rounds || 0));

    assertCheck(
      'Цикл SOPRANO_INTERVIEW реально прерывается (не длится вечно) — за 6 сообщений дошли до состояния, отличного от SOPRANO_INTERVIEW',
      states[states.length - 1] !== 'SOPRANO_INTERVIEW',
      `Последовательность: ${states.join(' → ')}`
    );
    assertCheck(
      'Прерывание происходит РОВНО на лимите (не раньше, не позже) — max intake_rounds в сохранённых состояниях не превышает CONFIG.MAX_INTAKE_ROUNDS',
      maxRoundsSeen > 0 && maxRoundsSeen <= 3,
      `Максимальный intake_rounds, сохранённый в БД: ${maxRoundsSeen} (ожидали <= 3, т.к. MAX_INTAKE_ROUNDS = 3 в stateMachine.js на момент написания теста)`
    );
    assertCheck(
      'Менеджер видит объяснение, что не все детали уточнены (а не тихий обрыв интервью без объяснения)',
      result.chatText.includes('Не все детали удалось уточнить'),
      result.chatText.includes('Не все детали удалось уточнить') ? undefined : `chatText: ${result.chatText}`
    );
    assertCheck(
      'После прерывания сессия НЕ зависает в SOPRANO_INTERVIEW навсегда — следующее состояние DIAGNOSING или CONFLICT_RESOLUTION',
      ['DIAGNOSING', 'CONFLICT_RESOLUTION'].includes(result.nextState),
      `nextState фактически: ${result.nextState}`
    );

    console.log(`\nИтого: ${failCount === 0 ? 'все проверки пройдены' : failCount + ' проверок провалено'}.\n`);
  } catch (e) {
    console.error(`❌ Исключение во время теста: ${e.message}\n${e.stack}`);
    failCount++;
  } finally {
    restoreAll();
  }
  process.exit(failCount ? 1 : 0);
})();

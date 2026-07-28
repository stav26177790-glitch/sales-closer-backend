#!/usr/bin/env node
/**
 * test_escalation_manual_retry.js
 *
 * Детерминированный unit-тест на фикс бага №35 (HANDOFF_v7 §1.6 → HANDOFF_v8):
 * ESCALATION раньше был тупиком — ЛЮБОЕ следующее сообщение менеджера, что
 * бы он ни написал, немедленно финализировало сессию с неодобренным текстом,
 * полностью игнорируя фидбэк.
 *
 * Ожидаемое поведение после фикса (обсуждено с пользователем):
 *   1. Первое сообщение менеджера после эскалации НЕ уходит в composer молча —
 *      агент явно спрашивает "доработать или закрыть?" (да/нет).
 *   2. Только явное "да" запускает ещё одну попытку composer'а с фидбэком.
 *   3. Ручных попыток ограниченное число — CONFIG.MAX_ESCALATION_RETRIES (2 на
 *      момент написания теста). После исчерпания лимита — сессия завершается
 *      сразу, без повторного вопроса.
 *
 * Сценарий мока: composer каждый раз возвращает валидные касания, reviewer
 * КАЖДЫЙ раз возвращает "НА ДОРАБОТКУ" (сходимости никогда не будет) — это
 * специально, чтобы проверить именно лимит ручных попыток, а не то, помогает
 * ли доработка по существу.
 *
 * Запуск:
 *   node test_escalation_manual_retry.js --dir /путь/к/папке/с/stateMachine.js
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
stageMock(RUNNER_TARGET, path.join(HERE, 'agentRunner.mock.escalation.js'));

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
    const runnerMock = require(RUNNER_TARGET);
    runnerMock.__reset();

    const DEAL_ID = 'test-deal-escalation-retry';
    db.__setDeal({
      id: DEAL_ID,
      client: 'Тестовый клиент',
      product: 'тестовый продукт',
      deal_size: 500000,
      industry: 'signage',
      last_contact: '2026-07-20',
      days_silent: 3,
      current_state: 'ESCALATION',
      criteria: { financial: 'хорошо', need: 'хорошо', trust: 'хорошо', authority: 'хорошо', urgency: 'хорошо' },
      last_composer_output: { messages: [{ touchpoint_number: 1, channel: 'whatsapp', body: 'Исходное касание до эскалации.' }] },
      last_reviewer_output: { verdict: 'НА ДОРАБОТКУ', messages_reviewed: [] },
      composer_iterations: 3, // уже на MAX_COMPOSER_ITERATIONS (3) на момент эскалации
      escalation_retries: 0
    });

    console.log('\n=== Шаг 1: менеджер пишет содержательный фидбэк сразу после эскалации ===\n');
    const step1 = await advance(DEAL_ID, 'Смягчите тон, слишком напористо получилось.');
    console.log(`nextState: ${step1.nextState}`);
    console.log(`chatText: ${step1.chatText}`);
    assertCheck(
      'Шаг 1: composer НЕ вызывается молча — сначала явный вопрос менеджеру',
      runnerMock.__getComposerCallCount() === 0,
      `composer вызван ${runnerMock.__getComposerCallCount()} раз(а) — должно быть 0 на этом шаге`
    );
    assertCheck(
      'Шаг 1: агент явно спрашивает "доработать или закрыть?"',
      step1.chatText.includes('Доработать') && step1.chatText.includes('закрыть'),
      `chatText: ${step1.chatText}`
    );
    assertCheck('Шаг 1: сессия остаётся в ESCALATION, не финализируется вслепую', step1.nextState === 'ESCALATION');

    console.log('\n=== Шаг 2: менеджер подтверждает "да" — первая ручная попытка ===\n');
    const step2 = await advance(DEAL_ID, 'да');
    console.log(`nextState: ${step2.nextState}`);
    assertCheck(
      'Шаг 2: composer реально вызван с фидбэком менеджера (попытка №1)',
      runnerMock.__getComposerCallCount() === 1,
      `composer вызван ${runnerMock.__getComposerCallCount()} раз(а)`
    );
    assertCheck('Шаг 2: состояние переходит в COMPOSING (не финализация)', step2.nextState === 'COMPOSING');

    console.log('\n=== Шаг 3: менеджер пишет "ок" — уходит на проверку reviewer\'у (который снова не одобрит) ===\n');
    // Примечание: сообщения на разных шагах намеренно различаются текстом —
    // advance() дедуплицирует ДОСЛОВНО одинаковый текст к одной сделке в
    // 15-секундном окне (защита от двойного клика, см. комментарий в
    // stateMachine.js у ADVANCE_DEDUP_WINDOW_MS) — это защита от реальных
    // дублей, а не то, что проверяет этот тест, поэтому здесь её обходим.
    const step3 = await advance(DEAL_ID, 'ок');
    console.log(`nextState: ${step3.nextState}`);
    assertCheck('Шаг 3: reviewer вызван (попытка №1)', runnerMock.__getReviewerCallCount() === 1);
    assertCheck('Шаг 3: вердикт снова "НА ДОРАБОТКУ" → состояние REVIEWING', step3.nextState === 'REVIEWING');

    console.log('\n=== Шаг 4: снова эскалация (composer_iterations уже за пределом лимита) ===\n');
    const step4 = await advance(DEAL_ID, 'ок, жду');
    console.log(`nextState: ${step4.nextState}`);
    assertCheck('Шаг 4: сессия снова уходит в ESCALATION (не финализируется автоматически)', step4.nextState === 'ESCALATION');

    console.log('\n=== Шаг 5: менеджер снова пишет фидбэк — вторая (последняя) ручная попытка ===\n');
    const step5 = await advance(DEAL_ID, 'Ещё раз, пожалуйста, короче и мягче.');
    assertCheck('Шаг 5: снова спрашивает подтверждение, а не финализирует сразу', step5.nextState === 'ESCALATION' && step5.chatText.includes('Доработать'));

    const step6 = await advance(DEAL_ID, 'да, доработай');
    assertCheck('Шаг 6: composer вызван повторно (попытка №2)', runnerMock.__getComposerCallCount() === 2);
    assertCheck('Шаг 6: состояние COMPOSING', step6.nextState === 'COMPOSING');

    const step7 = await advance(DEAL_ID, 'ок, давай');
    assertCheck('Шаг 7: reviewer вызван повторно (попытка №2), снова НА ДОРАБОТКУ', runnerMock.__getReviewerCallCount() === 2 && step7.nextState === 'REVIEWING');

    const step8 = await advance(DEAL_ID, 'ок, посмотрим');
    assertCheck('Шаг 8: снова ESCALATION — лимит попыток (2) исчерпан ровно сейчас', step8.nextState === 'ESCALATION');

    console.log('\n=== Шаг 9: менеджер пробует ещё раз — лимит ручных попыток уже исчерпан ===\n');
    const step9 = await advance(DEAL_ID, 'Давайте ещё раз доработаем.');
    console.log(`nextState: ${step9.nextState}`);
    console.log(`chatText: ${step9.chatText}`);
    assertCheck(
      'Шаг 9: сессия финализируется СРАЗУ, без повторного вопроса "да/нет"',
      step9.nextState === 'FINAL_OUTPUT',
      `nextState фактически: ${step9.nextState}`
    );
    assertCheck(
      'Шаг 9: composer НЕ вызван в третий раз — лимит реально ограничивает попытки',
      runnerMock.__getComposerCallCount() === 2,
      `composer вызван всего ${runnerMock.__getComposerCallCount()} раз(а) — ожидали ровно 2 (по числу MAX_ESCALATION_RETRIES)`
    );
    assertCheck(
      'Шаг 9: менеджер видит объяснение (лимит попыток исчерпан), а не тихое закрытие',
      step9.chatText.includes('лимит') || step9.chatText.includes('исчерпан'),
      `chatText: ${step9.chatText}`
    );
    assertCheck('Шаг 9: memory-агент реально вызван для финализации', runnerMock.__getMemoryCallCount() >= 1);

    console.log(`\nИтого: ${failCount === 0 ? 'все проверки пройдены' : failCount + ' провалено'}.\n`);
  } catch (e) {
    console.error(`❌ Исключение во время теста: ${e.stack || e.message}`);
    failCount++;
  } finally {
    restoreAll();
  }
  process.exit(failCount ? 1 : 0);
})();

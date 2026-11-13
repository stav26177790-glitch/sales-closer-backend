/**
 * Ход в фоне (engine/progress.js): задание, этапы, результат, ошибка.
 */
const assert = require('assert');
const p = require('../engine/progress');

(async () => {
  let n = 0;
  const check = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

  await check('задание идёт → этапы меняются → готово с результатом', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    p.startJob('d1', 'Пишу касания по плану…', async () => { await gate; return { reply: 'готово', state: 'COMPOSING' }; });
    assert.equal(p.isRunning('d1'), true);
    assert.equal(p.runningCount(), 1);
    p.setStage('d1', 'Проверяю касания…');
    assert.equal(p.getJob('d1').stage, 'Проверяю касания…');
    release();
    await new Promise((r) => setTimeout(r, 10));
    const j = p.getJob('d1');
    assert.equal(j.status, 'done');
    assert.equal(j.result.reply, 'готово');
    assert.equal(p.runningCount(), 0);
  });
  await check('ошибка хода сохраняется, задание не висит', async () => {
    const err = console.error; console.error = () => {};
    p.startJob('d2', 'Работаю…', async () => { throw new Error('400 credit balance is too low'); });
    await new Promise((r) => setTimeout(r, 10));
    console.error = err;
    assert.equal(p.getJob('d2').status, 'error');
    assert.equal(p.isRunning('d2'), false);
  });
  await check('этап по состоянию сделки', async () => {
    assert.ok(p.stageForState('STRATEGY_SELECTION').startsWith('Пишу касания'));
    assert.ok(p.stageForState('INIT').includes('формуле закрытия'));
  });
  console.log(`progress: ${n} проверок пройдено`);
})();

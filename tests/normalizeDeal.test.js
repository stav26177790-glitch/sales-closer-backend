// Живой «Зерно 10» (15.11): в рабочей базе last_diagnostic_output приходил текстом — разбираем при чтении.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';
const assert = require('assert');
const { normalizeDeal } = require('../db');
let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }
check('оценка текстом → объект: видны scores, client_triggers, _path_mode', () => {
  const d = normalizeDeal({ last_diagnostic_output: JSON.stringify({ scores: { need: {} }, client_triggers: [1], _path_mode: 'step' }), last_strategy_output: { touch_plan: [] } });
  assert.equal(d.last_diagnostic_output._path_mode, 'step');
  assert.equal(d.last_diagnostic_output.client_triggers.length, 1);
  assert.deepEqual(d.last_strategy_output, { touch_plan: [] });
});
check('обычный текст и пустые поля не трогаем', () => {
  const d = normalizeDeal({ last_diagnostic_output: null, criteria: 'не JSON' });
  assert.equal(d.last_diagnostic_output, null);
  assert.equal(d.criteria, 'не JSON');
});
console.log(`normalizeDeal: ${n} проверок пройдено`);

/**
 * Прогон проверок кода на РЕАЛЬНЫХ ответах агентов живой сделки — бесплатно.
 * Файл — выгрузка «Данные для разработчика» в Клоузере (GET /api/deals/:id/agent-calls).
 *   node tests/replay.js путь/к/файлу.json
 * Для каждого ответа writer/composer/editor: проверки кода (длина, фразы,
 * календарь, чередование, все касания плана); для diagnostic — очистка вывода.
 */
const fs = require('fs');
const path = require('path');
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {}, children: [], paths: [] };
const { codeChecks } = require('../engine/autoCompose');
const { cleanSummary } = require('../engine/diagnosticCleanup');

const file = process.argv[2];
if (!file) { console.log('Укажите файл выгрузки: node tests/replay.js файл.json'); process.exit(1); }
const { calls = [] } = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
let issues = 0;
for (const c of calls) {
  const when = new Date(c.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  if (['writer', 'composer'].includes(c.agent)) {
    const out = c.output?.composer_output || c.output;
    const plan = c.input?.touch_plan || c.input?.strategy_output?.touch_plan;
    const r = codeChecks(out, c.input?.timeline || null, plan);
    const bad = r.messages_reviewed.filter((m) => m.verdict !== 'ОДОБРЕНО');
    console.log(`${when} ${c.agent}: ${bad.length ? `код вернул бы ${bad.map((m) => m.touchpoint_number).join(', ')}` : 'проверки кода чисты'}`);
    for (const m of bad) { issues++; console.log(`   касание ${m.touchpoint_number} [${(m.failed_criteria || []).join(', ')}]: ${m.fix_instructions}`); }
  } else if (c.agent === 'diagnostic') {
    const s = c.output?.diagnostic_output?.diagnostic_summary || c.output?.diagnostic_summary;
    const { removed } = cleanSummary(s);
    console.log(`${when} diagnostic: ${removed ? `очистка убрала бы ${removed} фраз(ы) про обход контактного лица` : 'чисто'}`);
  } else {
    console.log(`${when} ${c.agent}: ${c.duration_ms ? `${(c.duration_ms / 1000).toFixed(0)} с` : ''}`);
  }
}
console.log(`\nВсего находок проверок кода: ${issues}`);

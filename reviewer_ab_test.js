#!/usr/bin/env node
/**
 * reviewer_ab_test.js
 *
 * A/B тест: один и тот же composer_output прогоняется через reviewer_agent.md
 * ДВУМЯ моделями (по умолчанию claude-sonnet-4-6 и claude-haiku-4-5-20251001,
 * сейчас в проде используется вторая — см. agentRunner.js MODEL_BY_AGENT.reviewer)
 * при одинаковой температуре 0.1 (как в reviewer_agent.md). Задача — увидеть
 * СИСТЕМАТИЧЕСКУЮ разницу в вердиктах/критериях, а не абсолютную "правильность".
 *
 * ⚠️ Требует реального ANTHROPIC_API_KEY и пакета @anthropic-ai/sdk — тратит
 * токены на каждый прогон (2 вызова на кейс: Sonnet + Haiku). Не гонять на
 * каждый коммит, только при изменении reviewer_agent.md или при подозрении
 * на модель-специфичное поведение (см. HANDOFF_v6 §1.1 — Критерий 13).
 *
 * Не использует agentRunner.callAgent() напрямую, потому что там модель
 * жёстко зашита per-агент (MODEL_BY_AGENT) — здесь нужно явно варьировать
 * модель для ОДНОГО и того же агента, поэтому вызываем Anthropic SDK
 * напрямую с тем же системным промптом, что использовал бы agentRunner.
 *
 * Запуск:
 *   node reviewer_ab_test.js --agents-dir /путь/к/agents
 *   node reviewer_ab_test.js --agents-dir ./agents --knowledge-dir ./knowledge
 *   node reviewer_ab_test.js --agents-dir ./agents --only broken_trust_conditional_referral
 *   node reviewer_ab_test.js --agents-dir ./agents --repeat 3   # проверка стабильности каждой модели
 *   node reviewer_ab_test.js --mock   # только проверка плюмбинга харнесса, без реального API
 *
 * --agents-dir должен содержать reviewer_agent.md.
 * --knowledge-dir опционален — если указан, подключает те же файлы базы
 * знаний, что AGENT_KNOWLEDGE.reviewer в agentRunner.js
 * (14_style_guide.md, 09_touchpoint_engine.md, 01_sales_methodology.md),
 * если они там есть. Без --knowledge-dir тест идёт БЕЗ базы знаний — это
 * не баг, но повод учитывать при интерпретации: reviewer в проде видит
 * знания, здесь по умолчанию может не видеть.
 */
const fs = require('fs');
const path = require('path');
const fixtures = require('./reviewer_ab_fixtures');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const MOCK = process.argv.includes('--mock');
const ONLY = arg('--only', null);
const REPEAT = parseInt(arg('--repeat', '1'), 10);
const AGENTS_DIR = arg('--agents-dir', path.join(process.cwd(), 'agents'));
const KNOWLEDGE_DIR = arg('--knowledge-dir', null);

const REVIEWER_KNOWLEDGE_FILES = ['14_style_guide.md', '09_touchpoint_engine.md', '01_sales_methodology.md'];

const MODELS = {
  sonnet: arg('--sonnet-model', 'claude-sonnet-4-6'),
  haiku: arg('--haiku-model', 'claude-haiku-4-5-20251001')
};

const CRITERIA_KEYS = [
  'new_value', 'single_goal', 'strategy_alignment', 'blocker_addressed',
  'no_pressure', 'no_stop_words', 'personalization', 'clear_next_step',
  'channel_fit', 'not_repetitive', 'tone_fit', 'attachment_honesty',
  'broken_trust_protocol'
];

// Эвристика (НЕ доказательство) — просто подсветка мест, где reviewer мог
// обосновывать вердикт понятиями вне 13-критериевого чек-листа, как уже
// дважды случалось (HANDOFF_v5, HANDOFF_v6). Не заменяет ручное чтение
// fix_instructions/reviewer_notes — только экономит время на поиск.
const OUT_OF_CHECKLIST_MARKERS = [
  'этическ', 'стандарт', 'принцип', 'соответствует политике',
  'защищает данные', 'моральн', 'справедлив'
];

function loadReviewerPrompt() {
  const filePath = path.join(AGENTS_DIR, 'reviewer_agent.md');
  if (!fs.existsSync(filePath)) {
    console.error(`\n❌ Не найден ${filePath}. Укажите верный путь через --agents-dir.\n`);
    process.exit(2);
  }
  let prompt = fs.readFileSync(filePath, 'utf8');
  if (KNOWLEDGE_DIR) {
    let knowledge = '\n\n---\n# БАЗА ЗНАНИЙ\n---\n\n';
    let foundAny = false;
    REVIEWER_KNOWLEDGE_FILES.forEach((file) => {
      const kPath = path.join(KNOWLEDGE_DIR, file);
      if (fs.existsSync(kPath)) {
        knowledge += `## ${file}\n\n${fs.readFileSync(kPath, 'utf8')}\n\n---\n\n`;
        foundAny = true;
      }
    });
    if (foundAny) prompt += knowledge;
  }
  return prompt;
}

function extractJson(rawOutput) {
  try {
    const jsonMatch = rawOutput.match(/```json\n([\s\S]*?)\n```/);
    return jsonMatch ? JSON.parse(jsonMatch[1]) : JSON.parse(rawOutput);
  } catch {
    return { raw_output: rawOutput, parse_error: true };
  }
}

async function callModel(client, systemPrompt, input, model) {
  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    temperature: 0.1,
    system: systemPrompt,
    messages: [{ role: 'user', content: JSON.stringify(input, null, 2) }]
  });
  const rawOutput = response.content.find((b) => b.type === 'text')?.text || '';
  return extractJson(rawOutput);
}

// Баг, найденный при mock-прогоне этого же скрипта: фикстуры хранят
// composer_output внутри reviewer_input, а strategy_output/diagnostic_output/
// deal/memory — соседними полями на testCase (см. reviewer_ab_fixtures.js).
// Раньше эта функция не собирала их вместе — модели уходил только
// composer_output, без остального контекста сделки. Теперь собирается
// полный объект, соответствующий схеме "ВХОДНЫЕ ДАННЫЕ" reviewer_agent.md.
function buildFullReviewerInput(testCase) {
  return {
    composer_output: testCase.reviewer_input.composer_output,
    strategy_output: testCase.strategy_output,
    diagnostic_output: testCase.diagnostic_output,
    deal: testCase.deal,
    memory: testCase.memory
  };
}

function getReviewerOutput(parsed) {
  return parsed?.reviewer_output || parsed;
}

function flagOutOfChecklistLanguage(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return OUT_OF_CHECKLIST_MARKERS.filter((m) => lower.includes(m));
}

function compareRuns(sonnetOut, haikuOut) {
  const s = getReviewerOutput(sonnetOut);
  const h = getReviewerOutput(haikuOut);
  const diffs = [];

  if (s?.parse_error || h?.parse_error) {
    diffs.push(`⚠️ Не удалось распарсить JSON у ${s?.parse_error ? 'Sonnet' : ''}${s?.parse_error && h?.parse_error ? ' и ' : ''}${h?.parse_error ? 'Haiku' : ''}`);
    return diffs;
  }

  const sVerdict = s?.verdict;
  const hVerdict = h?.verdict;
  if (sVerdict !== hVerdict) {
    diffs.push(`ВЕРДИКТ РАЗЛИЧАЕТСЯ: Sonnet="${sVerdict}" vs Haiku="${hVerdict}"`);
  }

  const sMessages = s?.messages_reviewed || [];
  const hMessages = h?.messages_reviewed || [];
  const maxLen = Math.max(sMessages.length, hMessages.length);
  for (let i = 0; i < maxLen; i++) {
    const sm = sMessages[i];
    const hm = hMessages[i];
    if (!sm || !hm) {
      diffs.push(`Касание ${i + 1}: разное количество messages_reviewed (Sonnet=${sMessages.length}, Haiku=${hMessages.length})`);
      continue;
    }
    if (sm.verdict !== hm.verdict) {
      diffs.push(`Касание ${i + 1} — вердикт: Sonnet="${sm.verdict}" vs Haiku="${hm.verdict}"`);
    }
    CRITERIA_KEYS.forEach((key) => {
      const sv = sm.checklist?.[key];
      const hv = hm.checklist?.[key];
      if (sv && hv && sv.split(' ')[0] !== hv.split(' ')[0]) {
        diffs.push(`Касание ${i + 1}, критерий "${key}": Sonnet="${sv}" vs Haiku="${hv}"`);
      }
    });

    const sFlags = flagOutOfChecklistLanguage(sm.fix_instructions);
    const hFlags = flagOutOfChecklistLanguage(hm.fix_instructions);
    if (sFlags.length) diffs.push(`⚑ Sonnet, касание ${i + 1}: язык вне чек-листа в fix_instructions (маркеры: ${sFlags.join(', ')}) — прочитать вручную`);
    if (hFlags.length) diffs.push(`⚑ Haiku, касание ${i + 1}: язык вне чек-листа в fix_instructions (маркеры: ${hFlags.join(', ')}) — прочитать вручную`);
  }

  return diffs;
}

async function run() {
  const caseNames = Object.keys(fixtures).filter((k) => k !== 'TODAY' && (!ONLY || k === ONLY));
  if (!caseNames.length) {
    console.error(`Не найдено кейсов (--only=${ONLY}).`);
    process.exit(2);
  }

  console.log(`=== REVIEWER A/B TEST: ${MODELS.sonnet} vs ${MODELS.haiku} ${MOCK ? '(MOCK — только плюмбинг)' : ''} ===\n`);

  let client = null;
  let systemPrompt = '';
  if (!MOCK) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic();
    systemPrompt = loadReviewerPrompt();
  }

  for (const name of caseNames) {
    const testCase = fixtures[name];
    console.log(`\n--- [${name}] ---`);
    for (let attempt = 1; attempt <= REPEAT; attempt++) {
      const label = REPEAT > 1 ? ` (попытка ${attempt})` : '';
      try {
        let sonnetOut, haikuOut;
        if (MOCK) {
          sonnetOut = { reviewer_output: { verdict: 'ОДОБРЕНО', messages_reviewed: [] } };
          haikuOut = { reviewer_output: { verdict: 'ОДОБРЕНО', messages_reviewed: [] } };
        } else {
          const fullInput = buildFullReviewerInput(testCase);
          [sonnetOut, haikuOut] = await Promise.all([
            callModel(client, systemPrompt, fullInput, MODELS.sonnet),
            callModel(client, systemPrompt, fullInput, MODELS.haiku)
          ]);
        }
        const diffs = compareRuns(sonnetOut, haikuOut);
        if (diffs.length === 0) {
          console.log(`✅${label} совпадают по вердикту и всем критериям`);
        } else {
          console.log(`⚠️${label} найдены расхождения:`);
          diffs.forEach((d) => console.log(`   - ${d}`));
        }
        if (!MOCK) {
          console.log(`   [Sonnet reviewer_notes] ${getReviewerOutput(sonnetOut)?.reviewer_notes || '(нет)'}`);
          console.log(`   [Haiku  reviewer_notes] ${getReviewerOutput(haikuOut)?.reviewer_notes || '(нет)'}`);
        }
      } catch (e) {
        console.log(`❌${label} исключение: ${e.message}`);
      }
    }
  }

  console.log(`\nГотово. Читайте расхождения выше вручную — особенно строки с "⚑" (возможный язык вне чек-листа)` +
    ` и любые различия по кейсу "broken_trust_conditional_referral" — это ключевой кейс из HANDOFF_v6.`);
}

run();

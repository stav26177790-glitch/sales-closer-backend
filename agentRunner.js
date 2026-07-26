const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { validateAgentOutput } = require('./outputSchemas');
const client = new Anthropic(); // ANTHROPIC_API_KEY читается из env автоматически
// Дешёвые агенты на Haiku, остальные — на Sonnet (как согласовано)
const MODEL_BY_AGENT = {
  planner: 'claude-sonnet-4-6',
  diagnostic: 'claude-sonnet-4-6',
  strategy: 'claude-sonnet-4-6',
  composer: 'claude-sonnet-4-6',
  reviewer: 'claude-haiku-4-5-20251001',
  memory: 'claude-haiku-4-5-20251001',
  advisor: 'claude-haiku-4-5-20251001'
};
const TEMPERATURES = {
  planner: 0.2,
  diagnostic: 0.2,
  strategy: 0.3,
  composer: 0.4,
  reviewer: 0.1,
  memory: 0.1,
  advisor: 0.3
};
const AGENT_KNOWLEDGE = {
  planner: [],
  diagnostic: [
    '01_sales_methodology.md', '02_sales_formula.md', '03_signal_dictionary.md',
    '04_financial_capacity.md', '05_need.md', '06_trust.md', '07_decision_authority.md',
    '08_urgency.md', '13_examples.md', '16_soprano_qualification.md', '20_buying_psychology.md'
  ],
  strategy: [
    '02_sales_formula.md', '06_trust.md', '07_decision_authority.md', '08_urgency.md',
    '09_touchpoint_engine.md', '13_examples.md', '20_buying_psychology.md',
    '21_industry_specifics.md', '23_lpr_tactics.md'
  ],
  composer: [
    '09_touchpoint_engine.md', '10b_scripts_post_kp_meeting.md', '11_touchpoint_library.md',
    '14_style_guide.md', '15_objection_expensive.md', '15b_objection_library.md',
    '17_trust_building.md', '22_presentation.md'
  ],
  reviewer: ['14_style_guide.md', '09_touchpoint_engine.md', '01_sales_methodology.md'],
  memory: [],
  advisor: [
    '15_objection_expensive.md', '15b_objection_library.md', '17_trust_building.md',
    '07_decision_authority.md', '23_lpr_tactics.md'
  ]
};
const KNOWLEDGE_BASE_PATH = path.join(__dirname, 'knowledge');
const AGENTS_PATH = path.join(__dirname, 'agents');
const CASES_BASE_PATH = path.join(__dirname, 'knowledge', 'cases');
const AGENTS_WITH_INDUSTRY_CASES = new Set(['strategy', 'composer', 'advisor']);

function loadKnowledgeForAgent(agentName) {
  const files = AGENT_KNOWLEDGE[agentName] || [];
  if (files.length === 0) return '';
  let knowledge = '\n\n---\n# БАЗА ЗНАНИЙ\n---\n\n';
  files.forEach((file) => {
    const filePath = path.join(KNOWLEDGE_BASE_PATH, file);
    if (fs.existsSync(filePath)) {
      knowledge += `## ${file}\n\n${fs.readFileSync(filePath, 'utf8')}\n\n---\n\n`;
    }
  });
  return knowledge;
}

function loadIndustryCases(industry) {
  if (!industry) return '';
  const folderPath = path.join(CASES_BASE_PATH, industry);
  if (!fs.existsSync(folderPath)) return '';
  const files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.md'));
  if (!files.length) return '';
  let cases = `\n\n---\n# КЕЙСЫ ПО ОТРАСЛИ: ${industry}\n---\n\n`;
  files.forEach((file) => {
    cases += fs.readFileSync(path.join(folderPath, file), 'utf8') + '\n\n';
  });
  return cases;
}

function loadAgentPrompt(agentName) {
  const filePath = path.join(AGENTS_PATH, `${agentName}_agent.md`);
  if (!fs.existsSync(filePath)) throw new Error(`Промпт агента не найден: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Задача Б (HANDOFF_v2 §5.1): раньше обрезка входа при превышении maxChars
 * происходила молча — ни в логах, ни в ответе не было следа, что часть
 * материалов не попала к агенту. Теперь факт обрезки логируется всегда.
 *
 * Баг №25 (найден при подготовке этого патча): если поле
 * materials.correspondence или materials.crm_notes отсутствует во входных
 * данных, старый код всё равно делал `undefined + '\n...[сокращено]'`,
 * что в JS даёт строку "undefined\n...[сокращено]" — она подставлялась
 * как БУКВАЛЬНЫЙ контент в промпт агенту. Теперь отсутствующее поле
 * остаётся отсутствующим (не обрезается и не заменяется мусорной строкой).
 *
 * Баг №26 (найден по логам с прода после включения логирования обрезки):
 * materials.dialog_history — вся история сообщений по сделке, склеенная
 * в одну строку в stateMachine.js (`db.getMessages(dealId)`), — росла БЕЗ
 * ОГРАНИЧЕНИЙ и не участвовала в обрезке вообще. На реальной сделке это
 * дало вход в 69137 символов для strategy при том, что correspondence
 * после обрезки был всего 3000 — то есть основную стоимость запроса
 * создавал именно необрезанный dialog_history. Теперь обрезается и он,
 * но с ХВОСТА (оставляем последние maxDialogChars символов, а не первые) —
 * недавняя история сделки обычно важнее самой старой для текущего решения.
 */
function compressInput(inputData, agentName, maxChars = 12000) {
  const str = JSON.stringify(inputData);
  if (str.length <= maxChars) return inputData;

  const MAX_CORRESPONDENCE = 3000;
  const MAX_CRM_NOTES = 1000;
  const MAX_DIALOG_HISTORY = 4000;

  const originalCorrespondence = inputData.materials?.correspondence;
  const originalCrmNotes = inputData.materials?.crm_notes;
  const originalDialogHistory = inputData.materials?.dialog_history;
  const truncatedFields = [];

  const newMaterials = { ...inputData.materials };

  if (typeof originalCorrespondence === 'string' && originalCorrespondence.length > MAX_CORRESPONDENCE) {
    newMaterials.correspondence = originalCorrespondence.slice(0, MAX_CORRESPONDENCE) + '\n...[сокращено]';
    truncatedFields.push(`correspondence (${originalCorrespondence.length} → ${MAX_CORRESPONDENCE} симв.)`);
  }
  if (typeof originalCrmNotes === 'string' && originalCrmNotes.length > MAX_CRM_NOTES) {
    newMaterials.crm_notes = originalCrmNotes.slice(0, MAX_CRM_NOTES) + '\n...[сокращено]';
    truncatedFields.push(`crm_notes (${originalCrmNotes.length} → ${MAX_CRM_NOTES} симв.)`);
  }
  if (typeof originalDialogHistory === 'string' && originalDialogHistory.length > MAX_DIALOG_HISTORY) {
    // Оставляем хвост (последние сообщения), а не начало — для истории
    // диалога недавний контекст важнее самого раннего.
    newMaterials.dialog_history = '[начало истории сокращено]...\n' + originalDialogHistory.slice(-MAX_DIALOG_HISTORY);
    truncatedFields.push(`dialog_history (${originalDialogHistory.length} → ${MAX_DIALOG_HISTORY} симв., оставлен хвост)`);
  }

  const result = { ...inputData, materials: newMaterials };
  const resultStr = JSON.stringify(result);

  const dealLabel = inputData?.deal?.client || inputData?.deal?.id || 'unknown_deal';
  if (truncatedFields.length) {
    console.warn(
      `[compressInput] Вход обрезан для агента "${agentName}" (сделка: ${dealLabel}). ` +
      `Было ${str.length} симв., стало ${resultStr.length} симв. Обрезаны поля: ${truncatedFields.join(', ')}.`
    );
  } else {
    // Порог превышен, но обрезать нечего (correspondence/crm_notes короткие
    // или отсутствуют) — значит, размер раздувают другие поля. Раньше это
    // проходило вообще без следа.
    console.warn(
      `[compressInput] Вход агента "${agentName}" (сделка: ${dealLabel}) превышает лимит ` +
      `${maxChars} симв. (факт. ${str.length}), но materials.correspondence/crm_notes обрезать ` +
      `нечего — размер раздувают другие поля входных данных. Вход отправлен БЕЗ обрезки.`
    );
  }

  return truncatedFields.length ? result : inputData;
}

async function callAgent(agentName, inputData, maxTokens = 4000) {
  let systemPrompt = loadAgentPrompt(agentName) + loadKnowledgeForAgent(agentName);
  if (AGENTS_WITH_INDUSTRY_CASES.has(agentName)) {
    systemPrompt += loadIndustryCases(inputData?.deal?.industry);
  }
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL_BY_AGENT[agentName],
        max_tokens: maxTokens,
        temperature: TEMPERATURES[agentName] ?? 0.2,
        system: systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(compressInput(inputData, agentName), null, 2) }]
      });
      const rawOutput = response.content.find((b) => b.type === 'text')?.text || '';
      try {
        const jsonMatch = rawOutput.match(/```json\n([\s\S]*?)\n```/);
        const parsed = jsonMatch ? JSON.parse(jsonMatch[1]) : JSON.parse(rawOutput);
        logSchemaDrift(agentName, inputData, parsed);
        return parsed;
      } catch {
        return { raw_output: rawOutput, parse_error: true };
      }
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
/**
 * Схема-валидация (Блок 1 сессии 3, продолжение): сверяет ЖИВОЙ ответ
 * модели с её же собственной схемой из *_agent.md ("ВЫХОДНЫЕ ДАННЫЕ").
 *
 * ВАЖНО — это НЕ то же самое, что баги №24/№30/№31/№32, которые чинили
 * этой сессией: те были рассогласованием КОДА stateMachine.js со схемой
 * (ловится статическим анализом в regression/static-checks.js). Здесь —
 * другой класс проблемы: сама модель в конкретном вызове не выполнила
 * то, что обещает её собственный промпт (забыла обязательное поле,
 * вернула не тот тип). Раньше это тихо утекало на 2-3 шага дальше по
 * пайплайну и разбиралось только когда кто-то замечал сломанный вывод
 * в чате — без единой зацепки, что пошло не так и на каком именно агенте.
 *
 * НЕ блокирует и не ретраит пайплайн — только громко логирует, с
 * указанием сделки и агента, чтобы проблему можно было найти по логам
 * (тот же принцип, что уже используется в compressInput() ниже).
 * Решение "должна ли схема-валидация ретраить вызов агента при дрейфе" —
 * сознательно НЕ реализовано здесь: это отдельный риск (лишние вызовы
 * API, возможность зацикливания), обсудить отдельно, если понадобится.
 */
function logSchemaDrift(agentName, inputData, parsedResult) {
  if (parsedResult?.parse_error) return; // это отдельный, уже залогированный на своём уровне случай
  const payload = parsedResult?.[`${agentName}_output`] || parsedResult;
  const { valid, problems } = validateAgentOutput(agentName, payload);
  if (valid) return;
  const dealLabel = inputData?.deal?.client || inputData?.deal?.id || 'unknown_deal';
  console.warn(
    `[schema] Ответ агента "${agentName}" (сделка: ${dealLabel}) разошёлся с его собственной схемой: ` +
    `${problems.join('; ')}. Пайплайн продолжает работу как есть — если дальше по цепочке что-то ` +
    `отрендерится пусто или странно, вероятная причина здесь.`
  );
}

module.exports = { callAgent };

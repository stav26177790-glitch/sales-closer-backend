/**
 * llm/prompt.js — системный промпт агента: промпт из agents/<имя>_agent.md
 * + файлы базы знаний из registry + кейсы отрасли сделки (для strategy,
 * composer, advisor). Текст собирается ровно так же, как до шага 4.
 */
const fs = require('fs');
const path = require('path');
const { getAgentConfig } = require('./registry');

const ROOT = path.join(__dirname, '..');
const KNOWLEDGE_BASE_PATH = path.join(ROOT, 'knowledge');
const AGENTS_PATH = path.join(ROOT, 'agents');
const CASES_BASE_PATH = path.join(ROOT, 'knowledge', 'cases');

function loadKnowledgeForAgent(agentName) {
  const files = getAgentConfig(agentName).knowledge;
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

// Знания об отрасли сделки: knowledge/industry/<отрасль>.md и дополнения
// <отрасль>_*.md (например, signage_902pp.md — правила Москвы). Файлов может не быть.
function loadIndustryKnowledge(industry) {
  if (!industry || !/^[a-z0-9_]+$/.test(industry)) return '';
  const dir = path.join(KNOWLEDGE_BASE_PATH, 'industry');
  const main = path.join(dir, `${industry}.md`);
  if (!fs.existsSync(main)) return '';
  const extras = fs.readdirSync(dir).filter((f) => f.startsWith(`${industry}_`) && f.endsWith('.md')).sort();
  const parts = [main, ...extras.map((f) => path.join(dir, f))].map((f) => fs.readFileSync(f, 'utf8'));
  return `\n\n---\n# ОТРАСЛЬ СДЕЛКИ: ${industry}\n---\n\n${parts.join('\n\n---\n\n')}\n`;
}

function buildSystemPrompt(agentName, industry) {
  let systemPrompt = loadAgentPrompt(agentName) + loadKnowledgeForAgent(agentName);
  if (getAgentConfig(agentName).industryKnowledge) {
    systemPrompt += loadIndustryKnowledge(industry);
  }
  if (getAgentConfig(agentName).industryCases) {
    systemPrompt += loadIndustryCases(industry);
  }
  return systemPrompt;
}

// Для API: строка, либо один текстовый блок с пометкой кэша.
// Весь промпт — один блок: он одинаков для всех вызовов агента в отрасли,
// меняется только сообщение пользователя (данные сделки).
function toApiSystem(agentName, systemPrompt) {
  if (!getAgentConfig(agentName).cache) return systemPrompt;
  return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
}

module.exports = { buildSystemPrompt, toApiSystem, loadIndustryCases };

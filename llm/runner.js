/**
 * llm/runner.js — вызов агента: системный промпт, вход, запрос к Claude,
 * разбор JSON, логирование.
 *
 * Шаг 4 (2026-11-11):
 *  - кэширование системного промпта для composer, reviewer, advisor (см. registry.js);
 *  - повторы: только для временных сбоев (429, 5xx, перегрузка, обрыв связи),
 *    их делает сам SDK с паузами и с учётом retry-after. Раньше собственный
 *    цикл повторял ЛЮБУЮ ошибку 3 раза поверх 2 повторов SDK — до 9 запросов,
 *    включая бессмысленные повторы ошибок 400/401;
 *  - в лог пишется время, токены (в т.ч. из кэша) и причина остановки:
 *    по ним видно стоимость и обрезанные ответы (stop: max_tokens).
 */
const { validateAgentOutput } = require('../outputSchemas');
const { getAgentConfig } = require('./registry');
const { buildSystemPrompt, toApiSystem } = require('./prompt');
const { compressInput } = require('./input');
const { createClient, providerConfig } = require('./provider');

// Провайдер (Claude или DeepSeek) — llm/provider.js, env LLM_PROVIDER. Формат запроса один (Anthropic).
// maxRetries: SDK повторяет только 408/409/429/5xx и сетевые ошибки.
const client = createClient();
const EXTRA_PARAMS = providerConfig().extraParams;

function dealLabelOf(inputData) {
  return inputData?.deal?.client || inputData?.deal?.id || 'unknown_deal';
}

function formatUsage(usage) {
  if (!usage) return 'usage: нет';
  const read = usage.cache_read_input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const cache = read || write ? `, cache read ${read} / write ${write}` : '';
  return `in ${usage.input_tokens ?? '?'}${cache}, out ${usage.output_tokens ?? '?'}`;
}

const { parseModelJson } = require('../engine/jsonRepair');
// Разбор + починка типовых поломок JSON (прямые кавычки внутри строк и т.п.).
function parseAgentText(rawOutput) {
  return parseModelJson(rawOutput);
}

const { recordAgentCall } = require('../engine/agentLog');

async function callAgent(agentName, inputData, maxTokens = 4000) {
  // Трейс-логгинг (баг №34): каждый вызов агента виден в логах —
  // кто, для какой сделки, когда начался и чем закончился.
  const dealLabel = dealLabelOf(inputData);
  console.log(`[agentRunner] → ${agentName} (сделка: ${dealLabel}, ${new Date().toISOString()})`);
  const config = getAgentConfig(agentName);
  const systemPrompt = buildSystemPrompt(agentName, inputData?.deal?.industry);
  const startedAt = Date.now();

  const response = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    temperature: config.temperature,
    system: toApiSystem(agentName, systemPrompt),
    messages: [{ role: 'user', content: JSON.stringify(compressInput(inputData, agentName), null, 2) }],
    ...EXTRA_PARAMS
  });

  console.log(
    `[agentRunner] ← ${agentName} (сделка: ${dealLabel}) ${((Date.now() - startedAt) / 1000).toFixed(1)} с, ` +
    `${formatUsage(response.usage)}, stop: ${response.stop_reason}`
  );

  const rawOutput = response.content.find((b) => b.type === 'text')?.text || '';
  const parsed = parseAgentText(rawOutput);
  // Сохраняем вход и ответ агента для проверки правок на реальных ответах (engine/agentLog.js).
  recordAgentCall({ agent: agentName, input: inputData, output: parsed, rawOutput, durationMs: Date.now() - startedAt, usage: response.usage });
  if (parsed === null) {
    console.warn(
      `[agentRunner] Ответ ${agentName} (сделка: ${dealLabel}) не разобран как JSON` +
      (response.stop_reason === 'max_tokens' ? ` — ответ обрезан лимитом max_tokens=${maxTokens}` : '') +
      '. Дальше по цепочке — восстановление из raw_output.'
    );
    return { raw_output: rawOutput, parse_error: true };
  }
  logSchemaDrift(agentName, inputData, parsed);
  return parsed;
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

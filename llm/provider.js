/**
 * llm/provider.js — какой сервис моделей используется (сменный провайдер, HANDOFF 0.7 шаг 2, 14.11).
 *
 * Оба провайдера говорят в формате Anthropic Messages API, поэтому вызов в llm/runner.js
 * не меняется: меняются адрес, ключ, названия моделей и цена.
 *   anthropic — Claude (по умолчанию; сейчас заблокирован проверкой личности);
 *   deepseek  — DeepSeek напрямую, https://api.deepseek.com/anthropic (cache_control там
 *               игнорируется — у DeepSeek свой автоматический кэш одинакового начала промпта).
 *
 * Настройки (env, Render → Environment):
 *   LLM_PROVIDER     — anthropic | deepseek (по умолчанию anthropic)
 *   DEEPSEEK_API_KEY — ключ DeepSeek (для deepseek); ANTHROPIC_API_KEY — для anthropic
 *   LLM_MODEL_MAIN   — модель «основных» агентов (по умолчанию: claude-sonnet-4-6 / deepseek-v4-pro)
 *   LLM_MODEL_SMALL  — модель «простых» агентов: memory, advisor, intent_classifier
 *                      (по умолчанию: claude-haiku-4-5 / deepseek-v4-flash)
 *   LLM_THINKING     — enabled — включить режим рассуждений DeepSeek (по умолчанию выключен:
 *                      дешевле и быстрее; включать — только после сравнения прогоном набора)
 */
const Anthropic = require('@anthropic-ai/sdk');

// Цена — USD за 1 млн токенов. DeepSeek — дневной («пиковый») тариф на ноябрь 2026
// (ночью по Пекину вдвое дешевле); пересматривать по https://api-docs.deepseek.com/quick_start/pricing
const PROVIDERS = {
  anthropic: {
    keyEnv: 'ANTHROPIC_API_KEY',
    baseURL: undefined,
    main: 'claude-sonnet-4-6',
    small: 'claude-haiku-4-5-20251001',
    price: {
      main: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
      small: { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 }
    }
  },
  deepseek: {
    keyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/anthropic',
    main: 'deepseek-v4-pro',
    small: 'deepseek-v4-flash',
    price: {
      main: { in: 1.32, out: 3.96, cacheWrite: 1.32, cacheRead: 0.044 },
      small: { in: 0.30, out: 1.20, cacheWrite: 0.30, cacheRead: 0.006 }
    }
  }
};

function providerName(env = process.env) {
  const name = String(env.LLM_PROVIDER || 'anthropic').trim().toLowerCase();
  if (!PROVIDERS[name]) throw new Error(`LLM_PROVIDER=${name}: неизвестный провайдер (есть: ${Object.keys(PROVIDERS).join(', ')})`);
  return name;
}

function providerConfig(env = process.env) {
  const name = providerName(env);
  const p = PROVIDERS[name];
  return {
    name,
    keyEnv: p.keyEnv,
    apiKey: env[p.keyEnv],
    baseURL: p.baseURL,
    models: { main: env.LLM_MODEL_MAIN || p.main, small: env.LLM_MODEL_SMALL || p.small },
    price: p.price,
    // Для DeepSeek режим рассуждений явно выключаем (если не просили включить).
    extraParams: name === 'deepseek' && String(env.LLM_THINKING || '').toLowerCase() !== 'enabled'
      ? { thinking: { type: 'disabled' } }
      : {}
  };
}

// Клиент SDK. Для Claude — как раньше ({ maxRetries: 4 }, ключ из ANTHROPIC_API_KEY);
// для остальных — свой адрес и ключ. Повторы временных сбоев (429, 5xx) делает SDK.
function createClient(env = process.env) {
  const cfg = providerConfig(env);
  if (cfg.name === 'anthropic') return new Anthropic({ maxRetries: 4 });
  return new Anthropic({ maxRetries: 4, baseURL: cfg.baseURL, apiKey: cfg.apiKey });
}

// Цена вызова в USD по usage ответа (поля формата Anthropic).
function costOf(model, usage, env = process.env) {
  if (!usage) return 0;
  const cfg = providerConfig(env);
  const p = model && model === cfg.models.small ? cfg.price.small : cfg.price.main;
  return ((usage.input_tokens || 0) * p.in + (usage.output_tokens || 0) * p.out +
    (usage.cache_creation_input_tokens || 0) * p.cacheWrite + (usage.cache_read_input_tokens || 0) * p.cacheRead) / 1e6;
}

module.exports = { PROVIDERS, providerName, providerConfig, createClient, costOf };

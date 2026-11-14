#!/usr/bin/env node
/**
 * tests/provider.test.js — сменный провайдер моделей (llm/provider.js, 14.11):
 * Claude по умолчанию, DeepSeek напрямую через его Anthropic-совместимый адрес.
 */
const assert = require('assert');
const { providerConfig, providerName, costOf } = require('../llm/provider');

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

check('по умолчанию — Claude, модели как раньше, без лишних параметров', () => {
  const c = providerConfig({ ANTHROPIC_API_KEY: 'k' });
  assert.equal(c.name, 'anthropic');
  assert.equal(c.baseURL, undefined);
  assert.deepEqual(c.models, { main: 'claude-sonnet-4-6', small: 'claude-haiku-4-5-20251001' });
  assert.deepEqual(c.extraParams, {});
  assert.equal(c.apiKey, 'k');
});

check('deepseek: адрес api.deepseek.com/anthropic, ключ DEEPSEEK_API_KEY, v4-pro / v4-flash', () => {
  const c = providerConfig({ LLM_PROVIDER: 'DeepSeek', DEEPSEEK_API_KEY: 'd', ANTHROPIC_API_KEY: 'a' });
  assert.equal(c.name, 'deepseek');
  assert.equal(c.baseURL, 'https://api.deepseek.com/anthropic');
  assert.equal(c.apiKey, 'd');
  assert.deepEqual(c.models, { main: 'deepseek-v4-pro', small: 'deepseek-v4-flash' });
});

check('deepseek: режим рассуждений выключен по умолчанию, LLM_THINKING=enabled — включён', () => {
  assert.deepEqual(providerConfig({ LLM_PROVIDER: 'deepseek' }).extraParams, { thinking: { type: 'disabled' } });
  assert.deepEqual(providerConfig({ LLM_PROVIDER: 'deepseek', LLM_THINKING: 'enabled' }).extraParams, {});
});

check('модели можно переопределить через LLM_MODEL_MAIN / LLM_MODEL_SMALL', () => {
  const c = providerConfig({ LLM_PROVIDER: 'deepseek', LLM_MODEL_MAIN: 'deepseek-v4-flash', LLM_MODEL_SMALL: 'x' });
  assert.deepEqual(c.models, { main: 'deepseek-v4-flash', small: 'x' });
});

check('неизвестный провайдер — понятная ошибка, а не тихий Claude', () => {
  assert.throws(() => providerName({ LLM_PROVIDER: 'gpt' }), /неизвестный провайдер/);
});

check('цена: Claude Sonnet $3/$15, DeepSeek V4 Pro $1.32/$3.96, кэш DeepSeek — $0.044', () => {
  const u = { input_tokens: 1e6, output_tokens: 1e6 };
  assert.equal(costOf('claude-sonnet-4-6', u, {}), 18);
  assert.equal(costOf('deepseek-v4-pro', u, { LLM_PROVIDER: 'deepseek' }).toFixed(2), '5.28');
  assert.equal(costOf('deepseek-v4-pro', { cache_read_input_tokens: 1e6 }, { LLM_PROVIDER: 'deepseek' }).toFixed(3), '0.044');
  assert.equal(costOf('deepseek-v4-flash', u, { LLM_PROVIDER: 'deepseek' }).toFixed(2), '1.50');
});

console.log(`provider: ${n} проверок пройдено`);

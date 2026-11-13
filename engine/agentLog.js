/**
 * engine/agentLog.js — сохранять ответы агентов живых сделок (таблица agent_calls).
 *
 * Зачем (владелец, 2026-11-13: «не переделывать и не тестировать по 10 раз»):
 * любую правку проверок кода можно прогнать на РЕАЛЬНЫХ ответах модели
 * из живых сделок — бесплатно, без новых живых прогонов.
 * Номер сделки — из контекста хода (AsyncLocalStorage, ставит advance()).
 * Таблицы нет или БД недоступна — молча пропускаем: работа Клоузера важнее.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
let disabled = !process.env.SUPABASE_URL;

function runWithDeal(dealId, fn) {
  return als.run({ dealId }, fn);
}

function recordAgentCall({ agent, input, output, rawOutput, durationMs, usage }) {
  const dealId = als.getStore()?.dealId;
  if (disabled || !dealId) return;
  let db;
  try { db = require('../db'); } catch { disabled = true; return; }
  if (!db?.supabase?.from) return;
  db.supabase.from('agent_calls').insert({
    deal_id: dealId, agent, input, output: output ?? null, raw_output: output ? null : rawOutput, duration_ms: durationMs, usage: usage || null
  }).then(({ error }) => {
    if (error) {
      // Таблица ещё не создана — не шумим в логах на каждый вызов.
      if (/agent_calls/.test(error.message || '') || error.code === '42P01') { disabled = true; console.warn('[agentLog] Таблицы agent_calls нет — сохранение ответов агентов выключено до её создания.'); }
      else console.warn('[agentLog] Не сохранилось:', error.message);
    }
  }, () => {});
}

async function listAgentCalls(dealId) {
  const db = require('../db');
  const { data, error } = await db.supabase.from('agent_calls').select('*').eq('deal_id', dealId).order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

module.exports = { runWithDeal, recordAgentCall, listAgentCalls };

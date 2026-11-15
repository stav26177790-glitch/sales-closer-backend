const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('[SUPABASE] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не заданы — БД не подключена.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const MEMORY_TTL_DAYS = 180;

// Поля сделки с JSON. В рабочей базе (живой «Зерно 10», 15.11) last_diagnostic_output приходил
// ТЕКСТОМ, а не объектом: код читал .scores / .client_triggers / ._path_mode — получал undefined
// (writer видел 0 «что важно клиенту», режим «следующий шаг» не включался). Разбираем при чтении.
const JSON_FIELDS = ['last_diagnostic_output', 'last_strategy_output', 'last_composer_output', 'last_reviewer_output', 'criteria'];
function normalizeDeal(deal) {
  if (!deal || typeof deal !== 'object') return deal;
  for (const k of JSON_FIELDS) {
    if (typeof deal[k] === 'string' && /^\s*[{[]/.test(deal[k])) {
      try { deal[k] = JSON.parse(deal[k]); } catch { /* оставляем как есть */ }
    }
  }
  return deal;
}

async function listDeals(managerId) {
  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .eq('manager_id', managerId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(normalizeDeal);
}

// Строка в managers нужна до первой сделки (deals.manager_id → managers.id).
// Аккаунты создаёт администратор в Supabase Auth; строку managers создаём сами при первом входе.
async function ensureManager(user) {
  const displayName = user.user_metadata?.full_name || user.email || 'Менеджер';
  const { error } = await supabase
    .from('managers')
    .upsert({ id: user.id, display_name: displayName }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw error;
}

const { parseClientDate } = require('./engine/clientDate');

// Поля сроков сделки из тела запроса: только заданные и корректные.
function timelineFields(src) {
  const out = {};
  const date = parseClientDate(src?.client_deadline);
  if (date) out.client_deadline = date;
  const int = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 && v !== '' && v !== null ? Number(v) : undefined);
  if (int(src?.production_days) > 0) out.production_days = int(src.production_days);
  if (int(src?.install_days_min) !== undefined) out.install_days_min = int(src.install_days_min);
  if (int(src?.install_days_max) !== undefined) out.install_days_max = int(src.install_days_max);
  return out;
}

async function createDeal(managerId, deal) {
  const { data, error } = await supabase
    .from('deals')
    .insert({
      manager_id: managerId,
      client: deal.client,
      product: deal.product || null,
      deal_size: deal.deal_size || null,
      industry: deal.industry || 'signage', // имя папки в knowledge/cases
      last_contact: deal.last_contact || null,
      days_silent: deal.days_silent || 0,
      // Сроки (миграция 002) — только если заданы, чтобы создание сделки
      // работало и на базе без новых колонок.
      ...timelineFields(deal)
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getDeal(dealId) {
  const { data, error } = await supabase.from('deals').select('*').eq('id', dealId).single();
  if (error) throw error;
  return normalizeDeal(data);
}

async function updateDealState(dealId, patch) {
  const { data, error } = await supabase
    .from('deals')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', dealId)
    .select()
    .single();
  if (error) throw error;
  return normalizeDeal(data);
}

async function getMessages(dealId) {
  const { data, error } = await supabase
    .from('deal_messages')
    .select('*')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function addMessage(dealId, role, content, state = null) {
  const { data, error } = await supabase
    .from('deal_messages')
    .insert({ deal_id: dealId, role, content, state })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function loadMemory(dealId) {
  const { data, error } = await supabase
    .from('deal_memory')
    .select('*')
    .eq('deal_id', dealId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null;
  return data.memory_data;
}

async function saveMemory(dealId, memoryData) {
  const expires_at = new Date(Date.now() + MEMORY_TTL_DAYS * 86400000).toISOString();
  const { error } = await supabase
    .from('deal_memory')
    .upsert({ deal_id: dealId, memory_data: memoryData, saved_at: new Date().toISOString(), expires_at });
  if (error) throw error;
}
async function deleteDeal(dealId) {
  const { error } = await supabase.from('deals').delete().eq('id', dealId);
  if (error) throw error;
}
module.exports = {
  supabase,
  normalizeDeal,
  timelineFields,
  ensureManager,
  listDeals,
  createDeal,
  getDeal,
  updateDealState,
  getMessages,
  addMessage,
  loadMemory,
  saveMemory,
  deleteDeal
};

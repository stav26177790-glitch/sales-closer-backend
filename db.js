const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('[SUPABASE] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не заданы — БД не подключена.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const MEMORY_TTL_DAYS = 180;

async function listDeals(managerId) {
  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .eq('manager_id', managerId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function createDeal(managerId, deal) {
  const { data, error } = await supabase
    .from('deals')
    .insert({
      manager_id: managerId,
      client: deal.client,
      product: deal.product || null,
      deal_size: deal.deal_size || null,
      industry: deal.industry || 'вывески',
      last_contact: deal.last_contact || null,
      days_silent: deal.days_silent || 0
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getDeal(dealId) {
  const { data, error } = await supabase.from('deals').select('*').eq('id', dealId).single();
  if (error) throw error;
  return data;
}

async function updateDealState(dealId, patch) {
  const { data, error } = await supabase
    .from('deals')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', dealId)
    .select()
    .single();
  if (error) throw error;
  return data;
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

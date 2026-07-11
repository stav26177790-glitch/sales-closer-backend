require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { advance } = require('./stateMachine');
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const POST_COMPOSING_STATES = new Set(['COMPOSING', 'REVIEWING', 'ESCALATION', 'MEMORY_UPDATE', 'FINAL_OUTPUT']);
const STALE_DAYS = 14;

function withFlags(deal) {
  const isPastComposing = POST_COMPOSING_STATES.has(deal.current_state);
  const daysSinceUpdate = (Date.now() - new Date(deal.updated_at).getTime()) / 86400000;
  return {
    ...deal,
    is_experience_candidate: isPastComposing && !deal.experience_decision,
    is_stale_candidate: !isPastComposing && !deal.stale_dismissed && daysSinceUpdate >= STALE_DAYS,
  };
}

// Простейшая аутентификация: фронт передаёт Supabase JWT, мы достаём manager_id.
// Для прототипа также допускаем заголовок x-manager-id напрямую (до подключения полноценного Auth UI).
async function requireManager(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const { data, error } = await db.supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Не авторизован' });
    req.managerId = data.user.id;
    return next();
  }
  const headerManagerId = req.headers['x-manager-id'];
  if (headerManagerId) {
    req.managerId = headerManagerId;
    return next();
  }
  return res.status(401).json({ error: 'Не авторизован' });
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Список сделок менеджера
app.get('/api/deals', requireManager, async (req, res) => {
  try {
    const deals = await db.listDeals(req.managerId);
    res.json({ deals: deals.map(withFlags) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Создать новую сделку
app.post('/api/deals', requireManager, async (req, res) => {
  try {
    const deal = await db.createDeal(req.managerId, req.body);
    await db.addMessage(
      deal.id,
      'agent',
      `Добрый день. Разберём сделку ${deal.client}.\nПришлите материалы: переписку, заметки из CRM, результаты встреч.\nЧем больше деталей — тем точнее диагностика.`,
      'INIT'
    );
    res.json({ deal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// История сообщений по сделке
app.get('/api/deals/:id/history', requireManager, async (req, res) => {
  try {
    const deal = await db.getDeal(req.params.id);
    if (deal.manager_id !== req.managerId) return res.status(403).json({ error: 'Нет доступа' });
    const messages = await db.getMessages(req.params.id);
    res.json({ deal, messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Главный эндпоинт: менеджер отправляет сообщение, бэкенд продвигает state machine на один шаг
app.post('/api/deals/:id/continue', requireManager, async (req, res) => {
  const dealId = req.params.id;
  const { message } = req.body;
  try {
    const deal = await db.getDeal(dealId);
    if (deal.manager_id !== req.managerId) return res.status(403).json({ error: 'Нет доступа' });
    if (message) await db.addMessage(dealId, 'user', message, deal.current_state);
    const result = await advance(dealId, message || '');
    await db.addMessage(dealId, 'agent', result.chatText, result.nextState);
    const updatedDeal = await db.getDeal(dealId);
    res.json({ deal: updatedDeal, reply: result.chatText, state: result.nextState });
  } catch (e) {
    console.error('[CONTINUE ERROR]', e);
    res.status(500).json({ error: e.message });
  }
});

// Менеджер подтверждает или отклоняет сделку как полезный опыт для агента
app.patch('/api/deals/:id/experience', requireManager, async (req, res) => {
  try {
    const { decision } = req.body;
    if (!['confirmed', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'decision должен быть confirmed или rejected' });
    }
    const deal = await db.getDeal(req.params.id);
    if (deal.manager_id !== req.managerId) return res.status(403).json({ error: 'Нет доступа' });
    const updated = await db.updateDealState(req.params.id, { experience_decision: decision });
    res.json({ deal: withFlags(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Менеджер отклоняет предложение удалить "зависшую" сделку — она перестаёт быть кандидатом
app.patch('/api/deals/:id/dismiss-stale', requireManager, async (req, res) => {
  try {
    const deal = await db.getDeal(req.params.id);
    if (deal.manager_id !== req.managerId) return res.status(403).json({ error: 'Нет доступа' });
    const updated = await db.updateDealState(req.params.id, { stale_dismissed: true });
    res.json({ deal: withFlags(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Полное удаление сделки (вручную или после подтверждения зависшей) — messages и memory удалятся каскадом
app.delete('/api/deals/:id', requireManager, async (req, res) => {
  try {
    const deal = await db.getDeal(req.params.id);
    if (deal.manager_id !== req.managerId) return res.status(403).json({ error: 'Нет доступа' });
    await db.deleteDeal(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Sales Closer AI backend on :${PORT}`));

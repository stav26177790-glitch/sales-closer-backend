require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { advance } = require('./stateMachine');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

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
    res.json({ deals });
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Sales Closer AI backend on :${PORT}`));

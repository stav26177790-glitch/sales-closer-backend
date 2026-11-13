require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { advance } = require('./stateMachine');
const { friendlyError } = require('./engine/errors');
const { timelineForDeal } = require('./engine/timeline');
const { formatTimeline } = require('./engine/chat');
const progress = require('./engine/progress');
const { listAgentCalls } = require('./engine/agentLog');
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
// Сколько запросов сейчас в работе — для мягкого завершения при деплое (см. SIGTERM внизу).
let inFlight = 0;
app.use((req, res, next) => { inFlight++; res.on('close', () => { inFlight--; }); next(); });

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

// Аутентификация: фронтенд передаёт Supabase JWT (вход по ссылке на почту),
// из него берём manager_id. Других способов нет: заголовок x-manager-id убран
// 2026-11-11 после проверки входа на проде.
const knownManagers = new Set();

async function requireManager(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const { data, error } = await db.supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Не авторизован' });
    req.managerId = data.user.id;
    if (!knownManagers.has(req.managerId)) {
      try {
        await db.ensureManager(data.user);
        knownManagers.add(req.managerId);
      } catch (e) {
        console.error('[auth] Не удалось создать строку managers:', e.message);
        return res.status(500).json({ error: 'Не удалось подготовить профиль менеджера' });
      }
    }
    return next();
  }
  return res.status(401).json({ error: 'Не авторизован' });
}

// version — коммит, который сейчас работает на Render (RENDER_GIT_COMMIT задаёт сам Render).
// Нужно, чтобы понимать, выкатилось ли изменение, перед живой проверкой.
app.get('/api/health', (req, res) => res.json({
  ok: true,
  version: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7)
}));

// Пинг базы: делает минимальный запрос к Supabase, чтобы бесплатный проект
// не уходил в автопаузу. Вызывается по расписанию из .github/workflows/keep-alive.yml.
// Данные не возвращает — только факт успешного запроса.
app.get('/api/ping-db', async (req, res) => {
  const { error } = await db.supabase.from('deals').select('id', { head: true, count: 'exact' }).limit(1);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, at: new Date().toISOString() });
});

// Список сделок менеджера
app.get('/api/deals', requireManager, async (req, res) => {
  try {
    const deals = await db.listDeals(req.managerId);
    res.json({ deals: deals.map(withFlags) });
  } catch (e) {
    console.error('[API ERROR]', req.method, req.path, e);
    res.status(500).json({ error: friendlyError(e) });
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
    console.error('[API ERROR]', req.method, req.path, e);
    res.status(500).json({ error: friendlyError(e) });
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
    console.error('[API ERROR]', req.method, req.path, e);
    res.status(500).json({ error: friendlyError(e) });
  }
});

// Главный эндпоинт: менеджер отправляет сообщение, бэкенд продвигает state machine на один шаг.
// { async: true } — ход в фоне: сразу ответ «принято», статус — GET …/job (engine/progress.js).
app.post('/api/deals/:id/continue', requireManager, async (req, res) => {
  const dealId = req.params.id;
  const { message } = req.body;
  try {
    const deal = await db.getDeal(dealId);
    if (deal.manager_id !== req.managerId) return res.status(403).json({ error: 'Нет доступа' });
    if (req.body.async) {
      if (progress.isRunning(dealId)) {
        return res.status(409).json({ error: 'Клоузер ещё работает над прошлым сообщением — дождитесь ответа.' });
      }
      if (message) await db.addMessage(dealId, 'user', message, deal.current_state);
      const job = progress.startJob(dealId, progress.stageForState(deal.current_state), async () => {
        const result = await advance(dealId, message || '');
        await db.addMessage(dealId, 'agent', result.chatText, result.nextState);
        const updatedDeal = await db.getDeal(dealId);
        return { deal: updatedDeal, reply: result.chatText, state: result.nextState };
      });
      return res.status(202).json({ job: { status: job.status, stage: job.stage, started_at: job.startedAt } });
    }
    if (message) await db.addMessage(dealId, 'user', message, deal.current_state);
    const result = await advance(dealId, message || '');
    await db.addMessage(dealId, 'agent', result.chatText, result.nextState);
    const updatedDeal = await db.getDeal(dealId);
    res.json({ deal: updatedDeal, reply: result.chatText, state: result.nextState });
  } catch (e) {
    console.error('[CONTINUE ERROR]', e);
    res.status(500).json({ error: friendlyError(e) });
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
    console.error('[API ERROR]', req.method, req.path, e);
    res.status(500).json({ error: friendlyError(e) });
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
    console.error('[API ERROR]', req.method, req.path, e);
    res.status(500).json({ error: friendlyError(e) });
  }
});

// Сроки сделки (дата клиента, производство, монтаж) — для расчёта кодом.
app.patch('/api/deals/:id/timeline', requireManager, async (req, res) => {
  try {
    const deal = await db.getDeal(req.params.id);
    if (deal.manager_id !== req.managerId) return res.status(403).json({ error: 'Нет доступа' });
    const fields = db.timelineFields(req.body);
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Нет корректных полей сроков' });
    const updated = await db.updateDealState(req.params.id, fields);
    // Сразу показываем менеджеру расчёт: раньше блок «Сроки» появлялся только
    // после свежей диагностики, и сроки, заданные позже, менеджер не видел
    // (живой тест 2026-11-13). Сообщение попадает и в историю для агентов.
    const timeline = timelineForDeal(updated);
    const message = timeline
      ? `${formatTimeline(timeline).trim()}\n\n_Сроки сохранены — Клоузер учтёт их в стратегии и касаниях._`
      : formatTimeline(null).trim();
    await db.addMessage(req.params.id, 'agent', message, updated.current_state);
    res.json({ deal: withFlags(updated), message });
  } catch (e) {
    console.error('[API ERROR]', req.method, req.path, e);
    res.status(500).json({ error: friendlyError(e) });
  }
});

// Статус хода в фоне: что Клоузер делает сейчас и, когда готово, — ответ.
app.get('/api/deals/:id/job', requireManager, async (req, res) => {
  try {
    const deal = await db.getDeal(req.params.id);
    if (deal.manager_id !== req.managerId) return res.status(403).json({ error: 'Нет доступа' });
    const job = progress.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Хода нет' });
    const body = { status: job.status, stage: job.stage, elapsed_sec: Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000) };
    if (job.status === 'done') Object.assign(body, job.result);
    if (job.status === 'error') body.error = friendlyError(job.error);
    res.json(body);
  } catch (e) {
    console.error('[API ERROR]', req.method, req.path, e);
    res.status(500).json({ error: friendlyError(e) });
  }
});

// Ответы агентов по сделке — для разработчика: проверить правки на реальных ответах.
app.get('/api/deals/:id/agent-calls', requireManager, async (req, res) => {
  try {
    const deal = await db.getDeal(req.params.id);
    if (deal.manager_id !== req.managerId) return res.status(403).json({ error: 'Нет доступа' });
    res.json({ deal, calls: await listAgentCalls(req.params.id) });
  } catch (e) {
    console.error('[API ERROR]', req.method, req.path, e);
    res.status(500).json({ error: friendlyError(e) });
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
    console.error('[API ERROR]', req.method, req.path, e);
    res.status(500).json({ error: friendlyError(e) });
  }
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => console.log(`Sales Closer AI backend on :${PORT}`));
// Касания составляются, проверяются и дорабатываются в одном запросе
// (engine/autoCompose.js) — это может занять несколько минут. По умолчанию
// Node обрывает запрос через 5 минут (requestTimeout) — поднимаем до 15.
server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 15 * 60 * 1000 + 5000;
server.keepAliveTimeout = 65 * 1000;

// Деплой на Render: новый экземпляр принимает запросы, старому через 60 с
// приходит SIGTERM. Раньше Node завершался сразу — ход менеджера, который
// ещё считался (касания идут 2–4 минуты), обрывался: «Load failed»
// (живой тест 2026-11-13). Теперь: не принимаем новые запросы, ждём, пока
// закончатся начатые, и только потом выходим (Render добьёт SIGKILL по
// истечении shutdown delay — по умолчанию 30 с, можно поднять до 300).
process.on('SIGTERM', () => {
  console.log(`[shutdown] SIGTERM — жду завершения запросов: ${inFlight}, ходов в фоне: ${progress.runningCount()}`);
  server.close(() => { if (progress.runningCount() === 0) process.exit(0); });
  const timer = setInterval(() => {
    if (inFlight <= 0 && progress.runningCount() === 0) { clearInterval(timer); process.exit(0); }
  }, 1000);
});

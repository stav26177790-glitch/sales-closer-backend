# Sales Closer AI — деплой

## Структура

```
backend/              — Express API (деплой на Railway или Render)
  agents/              — промпты агентов (скопированы из исходного проекта)
  knowledge/            — база знаний (скопирована из исходного проекта)
  agentRunner.js        — вызов Claude API
  db.js                 — слой Supabase
  stateMachine.js        — пошаговая логика STATE_MACHINE.yaml
  server.js              — Express-сервер и эндпоинты
  supabase_schema.sql    — SQL для настройки БД
  .env.example           — какие переменные окружения нужны

sales-closer-frontend.jsx — фронтенд (React), отдельный шаг деплоя на Vercel
```

## Шаг 1 — Supabase (5 минут)

1. Зайти на supabase.com, создать проект (бесплатный тариф).
2. В разделе SQL Editor вставить содержимое `supabase_schema.sql` и выполнить.
3. В Settings → API скопировать `Project URL` и `service_role` ключ (не anon — service_role, он даёт серверу полный доступ в обход RLS).

## Шаг 2 — Anthropic API ключ

Если ключа ещё нет — создать на console.anthropic.com → API Keys. Это ключ, который видит только бэкенд, пользователи (менеджеры) его не видят.

## Шаг 3 — деплой бэкенда на Railway

1. Создать новый репозиторий на GitHub, положить туда содержимое папки `backend/`.
2. На railway.app: New Project → Deploy from GitHub repo → выбрать репозиторий.
3. В Variables (переменные окружения) добавить:
   - `ANTHROPIC_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Railway сам определит Node.js проект и запустит `npm start`. После деплоя Railway выдаст публичный URL вида `https://your-app.up.railway.app`.

(Render работает аналогично: New Web Service → подключить репозиторий → Build command `npm install`, Start command `npm start`.)

## Шаг 4 — деплой фронтенда на Vercel

1. В `sales-closer-frontend.jsx` заменить строку:
   ```js
   const API_BASE = "http://localhost:3001/api";
   ```
   на адрес бэкенда из шага 3:
   ```js
   const API_BASE = "https://your-app.up.railway.app/api";
   ```
2. Создать отдельный репозиторий с этим файлом как `App.jsx` в стандартном Vite/CRA React-проекте (или попросить Claude собрать обвязку проекта при следующем шаге).
3. На vercel.com: New Project → подключить репозиторий → деплой одной кнопкой.
4. Дальше — git push в любой из двух репозиториев автоматически передеплоит соответствующую часть.

## Текущее состояние авторизации

Прототип использует временный `x-manager-id: demo-manager` вместо полноценного логина — это позволяет проверить всю цепочку (фронт → бэкенд → Claude → Supabase) без лишнего шага. Полноценный Supabase Auth (логин/пароль или magic link для 1-5 менеджеров) — следующий шаг после проверки, что эта связка работает.

## Локальная проверка перед деплоем

```bash
cd backend
npm install
cp .env.example .env   # вписать реальные ключи
npm start
```

Сервер поднимется на `http://localhost:3001`. Открыть фронтенд с `API_BASE = "http://localhost:3001/api"` и проверить создание сделки + первый обмен сообщениями — это даст понять, ходит ли реальный Claude API через ваши промпты агентов корректно, прежде чем платить за хостинг.

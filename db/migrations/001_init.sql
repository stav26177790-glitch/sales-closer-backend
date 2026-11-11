-- Sales Closer AI — схема базы (Supabase / Postgres)
--
-- Идемпотентна: можно выполнять и на пустом проекте, и на живой базе.
-- На живой базе она только ДОБАВЛЯЕТ недостающее (колонки, RLS, политики, индексы)
-- и ничего не удаляет. Выполнять в Supabase → SQL Editor целиком.
--
-- Заменяет устаревший supabase_schema.sql (в нём не было 13 колонок deals,
-- которые использует stateMachine.js).

create extension if not exists "uuid-ossp";

-- ─── managers: профиль поверх auth.users ─────────────────────────────────────
create table if not exists managers (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz default now()
);

-- ─── deals ───────────────────────────────────────────────────────────────────
create table if not exists deals (
  id uuid primary key default uuid_generate_v4(),
  manager_id uuid not null references managers(id) on delete cascade,
  client text not null,
  product text,
  deal_size numeric,
  industry text default 'signage',
  last_contact date,
  days_silent integer default 0,
  current_state text default 'INIT',
  criteria jsonb default '{"financial":"","need":"","trust":"","authority":"","urgency":""}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Колонки, которые код пишет в deals (stateMachine.js, server.js), но которых
-- не было в исходной схеме.
alter table deals add column if not exists last_diagnostic_output jsonb;
alter table deals add column if not exists last_strategy_output jsonb;
alter table deals add column if not exists last_composer_output jsonb;
alter table deals add column if not exists last_reviewer_output jsonb;
alter table deals add column if not exists composer_iterations integer default 0;
alter table deals add column if not exists intake_rounds integer default 0;
alter table deals add column if not exists escalation_retries integer default 0;
alter table deals add column if not exists awaiting_correction_confirmation boolean default false;
alter table deals add column if not exists awaiting_escalation_confirmation boolean default false;
alter table deals add column if not exists pending_manager_feedback text;
alter table deals add column if not exists pending_escalation_feedback text;
alter table deals add column if not exists experience_decision text;   -- 'confirmed' | 'rejected' | null
alter table deals add column if not exists stale_dismissed boolean default false;

-- Отрасль по умолчанию = имя папки кейсов (knowledge/cases/signage).
-- Раньше было 'вывески' — для таких сделок кейсы молча не подгружались.
alter table deals alter column industry set default 'signage';
update deals set industry = 'signage' where industry = 'вывески';

-- ─── deal_messages ───────────────────────────────────────────────────────────
create table if not exists deal_messages (
  id uuid primary key default uuid_generate_v4(),
  deal_id uuid not null references deals(id) on delete cascade,
  role text not null check (role in ('user', 'agent', 'system')),
  content text not null,
  state text,
  created_at timestamptz default now()
);

-- ─── deal_memory ─────────────────────────────────────────────────────────────
create table if not exists deal_memory (
  deal_id uuid primary key references deals(id) on delete cascade,
  memory_data jsonb not null,
  saved_at timestamptz default now(),
  expires_at timestamptz
);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Бэкенд ходит с service_role и RLS обходит. RLS защищает от прямых запросов
-- с anon key, который теперь есть во фронтенде (вход по почте).
alter table managers enable row level security;
alter table deals enable row level security;
alter table deal_messages enable row level security;
alter table deal_memory enable row level security;

drop policy if exists "manager reads own profile" on managers;
create policy "manager reads own profile" on managers
  for select using (auth.uid() = id);

drop policy if exists "manager owns deals" on deals;
create policy "manager owns deals" on deals
  for all using (auth.uid() = manager_id);

drop policy if exists "manager owns deal messages" on deal_messages;
create policy "manager owns deal messages" on deal_messages
  for all using (
    exists (select 1 from deals where deals.id = deal_messages.deal_id and deals.manager_id = auth.uid())
  );

drop policy if exists "manager owns deal memory" on deal_memory;
create policy "manager owns deal memory" on deal_memory
  for all using (
    exists (select 1 from deals where deals.id = deal_memory.deal_id and deals.manager_id = auth.uid())
  );

-- ─── Индексы ─────────────────────────────────────────────────────────────────
create index if not exists idx_deals_manager on deals(manager_id);
create index if not exists idx_messages_deal on deal_messages(deal_id, created_at);

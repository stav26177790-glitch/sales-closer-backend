-- Sales Closer AI — схема Supabase
-- Выполнить в SQL Editor проекта Supabase один раз при настройке.

create extension if not exists "uuid-ossp";

-- Менеджеры (использует Supabase Auth, эта таблица — профиль поверх auth.users)
create table if not exists managers (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz default now()
);

-- Сделки
create table if not exists deals (
  id uuid primary key default uuid_generate_v4(),
  manager_id uuid not null references managers(id) on delete cascade,
  client text not null,
  product text,
  deal_size numeric,
  industry text default 'вывески',
  last_contact date,
  days_silent integer default 0,
  current_state text default 'INIT',
  criteria jsonb default '{"financial":"","need":"","trust":"","authority":"","urgency":""}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Сообщения чата (и человек, и агент, плюс служебные тех-события для отладки)
create table if not exists deal_messages (
  id uuid primary key default uuid_generate_v4(),
  deal_id uuid not null references deals(id) on delete cascade,
  role text not null check (role in ('user', 'agent', 'system')),
  content text not null,
  state text,
  created_at timestamptz default now()
);

-- Память между сессиями (заменяет memory/{managerId}_{clientName}.json)
create table if not exists deal_memory (
  deal_id uuid primary key references deals(id) on delete cascade,
  memory_data jsonb not null,
  saved_at timestamptz default now(),
  expires_at timestamptz
);

-- RLS: менеджер видит только свои сделки
alter table deals enable row level security;
alter table deal_messages enable row level security;
alter table deal_memory enable row level security;

create policy "manager owns deals" on deals
  for all using (auth.uid() = manager_id);

create policy "manager owns deal messages" on deal_messages
  for all using (
    exists (select 1 from deals where deals.id = deal_messages.deal_id and deals.manager_id = auth.uid())
  );

create policy "manager owns deal memory" on deal_memory
  for all using (
    exists (select 1 from deals where deals.id = deal_memory.deal_id and deals.manager_id = auth.uid())
  );

create index if not exists idx_deals_manager on deals(manager_id);
create index if not exists idx_messages_deal on deal_messages(deal_id, created_at);

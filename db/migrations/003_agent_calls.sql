-- 003: ответы агентов живых сделок — чтобы проверять правки на реальных
-- ответах модели без новых живых прогонов (2026-11-13).
-- Выполнить один раз в Supabase → SQL Editor → New query → Run.
create table if not exists agent_calls (
  id          bigserial primary key,
  deal_id     uuid not null references deals(id) on delete cascade,
  agent       text not null,
  input       jsonb,
  output      jsonb,
  raw_output  text,
  duration_ms integer,
  usage       jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists agent_calls_deal_idx on agent_calls (deal_id, created_at);
-- Доступ только с сервера (ключ service role); из браузера — нет.
alter table agent_calls enable row level security;

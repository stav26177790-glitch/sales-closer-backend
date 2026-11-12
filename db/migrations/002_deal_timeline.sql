-- Сроки сделки для расчёта кодом (engine/timeline.js), 2026-11-12.
-- Идемпотентна. Выполнить в Supabase → SQL Editor ДО выката фронтенда
-- с новыми полями формы.

alter table deals add column if not exists client_deadline date;            -- к какой дате нужно клиенту (день открытия)
alter table deals add column if not exists production_days integer;         -- производство, рабочих дней
alter table deals add column if not exists install_days_min integer default 2;  -- монтаж, рабочих дней (минимум)
alter table deals add column if not exists install_days_max integer default 3;  -- монтаж, рабочих дней (максимум)

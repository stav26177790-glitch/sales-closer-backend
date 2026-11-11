-- Сверка живой базы со схемой из db/migrations/001_init.sql.
-- Только читает. Выполнить в Supabase → SQL Editor и прислать результат.

select table_name, column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('managers', 'deals', 'deal_messages', 'deal_memory')
order by table_name, ordinal_position;

select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('managers', 'deals', 'deal_messages', 'deal_memory');

select industry, count(*) from deals group by industry order by 2 desc;

-- Run once in Supabase > SQL Editor (Calendar module)
create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  title text not null,
  event_type text not null default 'activity',
  start_time text,
  details text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.calendar_events enable row level security;
drop policy if exists calendar_select on public.calendar_events;
create policy calendar_select on public.calendar_events for select to authenticated using(true);
drop policy if exists calendar_admin_insert on public.calendar_events;
create policy calendar_admin_insert on public.calendar_events for insert to authenticated with check(public.is_admin());
drop policy if exists calendar_admin_update on public.calendar_events;
create policy calendar_admin_update on public.calendar_events for update to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists calendar_admin_delete on public.calendar_events;
create policy calendar_admin_delete on public.calendar_events for delete to authenticated using(public.is_admin());
-- live updates (ignore the error if it says the table is already a member)
alter publication supabase_realtime add table public.calendar_events;

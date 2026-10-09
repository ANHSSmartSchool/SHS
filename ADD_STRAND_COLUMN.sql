-- Run once in Supabase > SQL Editor
alter table public.lesson_plans add column if not exists strand text;

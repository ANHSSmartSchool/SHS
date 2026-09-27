-- ANHS SmartSchool schema + RLS + Storage
create extension if not exists pgcrypto;
create table if not exists public.profiles (id uuid primary key references auth.users(id) on delete cascade, email text, role text not null default 'teacher' check(role in ('admin','teacher','department_head')), name text not null, title text, initials text, grade text, section text, photo_url text, created_at timestamptz not null default now());
create table if not exists public.teachers (id uuid primary key default gen_random_uuid(), name text not null, sex text, age integer, department text, position text, years integer, post_grad text, created_by uuid references auth.users(id), created_at timestamptz not null default now());
create table if not exists public.lesson_plans (id uuid primary key default gen_random_uuid(), teacher text not null, department text, subject text, sections jsonb default '[]'::jsonb, section_text text, term text, week text, submitted_at timestamptz not null default now(), due_at timestamptz, file_name text, file_icon text, storage_path text, file_url text, reviewer text not null default 'admin', created_by uuid references auth.users(id), created_at timestamptz not null default now());
create table if not exists public.settings (id text primary key, logo_url text, updated_at timestamptz not null default now());
insert into public.settings(id) values('school') on conflict(id) do nothing;
alter table public.profiles enable row level security; alter table public.teachers enable row level security; alter table public.lesson_plans enable row level security; alter table public.settings enable row level security;
create or replace function public.is_staff_reviewer() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from public.profiles where id=auth.uid() and role in('admin','department_head')); $$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from public.profiles where id=auth.uid() and role='admin'); $$;
create or replace function public.protect_profile_changes() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() = old.id and not public.is_admin() then
    if new.role is distinct from old.role or new.email is distinct from old.email or new.name is distinct from old.name or new.title is distinct from old.title or new.initials is distinct from old.initials or new.grade is distinct from old.grade or new.section is distinct from old.section then
      raise exception 'Only an administrator can change protected profile fields';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists protect_profile_changes on public.profiles;
create trigger protect_profile_changes before update on public.profiles for each row execute function public.protect_profile_changes();

drop policy if exists profiles_select on public.profiles; create policy profiles_select on public.profiles for select to authenticated using(id=auth.uid() or public.is_staff_reviewer());
drop policy if exists profiles_update_self on public.profiles; create policy profiles_update_self on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
drop policy if exists profiles_admin_all on public.profiles; create policy profiles_admin_all on public.profiles for all to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists teachers_select on public.teachers; create policy teachers_select on public.teachers for select to authenticated using(true);
drop policy if exists teachers_admin_insert on public.teachers; create policy teachers_admin_insert on public.teachers for insert to authenticated with check(public.is_admin());
drop policy if exists teachers_admin_update on public.teachers; create policy teachers_admin_update on public.teachers for update to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists teachers_admin_delete on public.teachers; create policy teachers_admin_delete on public.teachers for delete to authenticated using(public.is_admin());
drop policy if exists lesson_plans_select on public.lesson_plans; create policy lesson_plans_select on public.lesson_plans for select to authenticated using(created_by=auth.uid() or public.is_staff_reviewer());
drop policy if exists lesson_plans_insert on public.lesson_plans; create policy lesson_plans_insert on public.lesson_plans for insert to authenticated with check(created_by=auth.uid() and (public.is_staff_reviewer() or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='teacher' and p.name=teacher)));
drop policy if exists lesson_plans_update on public.lesson_plans; create policy lesson_plans_update on public.lesson_plans for update to authenticated using(created_by=auth.uid() or public.is_staff_reviewer()) with check(created_by=auth.uid() or public.is_staff_reviewer());
drop policy if exists lesson_plans_delete on public.lesson_plans; create policy lesson_plans_delete on public.lesson_plans for delete to authenticated using(public.is_admin());
drop policy if exists settings_select on public.settings; create policy settings_select on public.settings for select to anon,authenticated using(true);
drop policy if exists settings_admin_write on public.settings; create policy settings_admin_write on public.settings for all to authenticated using(public.is_admin()) with check(public.is_admin());
insert into storage.buckets(id,name,public) values('avatars','avatars',true) on conflict(id) do nothing; insert into storage.buckets(id,name,public) values('school-assets','school-assets',true) on conflict(id) do nothing; insert into storage.buckets(id,name,public) values('lesson-plans','lesson-plans',false) on conflict(id) do nothing;
drop policy if exists avatars_insert_own on storage.objects; create policy avatars_insert_own on storage.objects for insert to authenticated with check(bucket_id='avatars' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists avatars_update_own on storage.objects; create policy avatars_update_own on storage.objects for update to authenticated using(bucket_id='avatars' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists avatars_delete_own on storage.objects; create policy avatars_delete_own on storage.objects for delete to authenticated using(bucket_id='avatars' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists school_assets_admin_insert on storage.objects; create policy school_assets_admin_insert on storage.objects for insert to authenticated with check(bucket_id='school-assets' and public.is_admin());
drop policy if exists school_assets_admin_update on storage.objects; create policy school_assets_admin_update on storage.objects for update to authenticated using(bucket_id='school-assets' and public.is_admin());
drop policy if exists school_assets_admin_delete on storage.objects; create policy school_assets_admin_delete on storage.objects for delete to authenticated using(bucket_id='school-assets' and public.is_admin());
drop policy if exists lesson_files_insert on storage.objects; create policy lesson_files_insert on storage.objects for insert to authenticated with check(bucket_id='lesson-plans' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists lesson_files_select on storage.objects; create policy lesson_files_select on storage.objects for select to authenticated using(bucket_id='lesson-plans' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_staff_reviewer()));
drop policy if exists lesson_files_update on storage.objects; create policy lesson_files_update on storage.objects for update to authenticated using(bucket_id='lesson-plans' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_staff_reviewer()));
drop policy if exists lesson_files_delete on storage.objects; create policy lesson_files_delete on storage.objects for delete to authenticated using(bucket_id='lesson-plans' and public.is_admin());

-- Enable Realtime for the two live tables (safe if already present).
do $$ begin
  begin alter publication supabase_realtime add table public.teachers; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.lesson_plans; exception when duplicate_object then null; end;
end $$;

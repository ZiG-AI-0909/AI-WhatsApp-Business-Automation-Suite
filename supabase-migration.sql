-- =============================================================
-- Supabase Auth Migration
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- =============================================================

-- ─── 1. Profiles table ───────────────────────────────────────
-- Stores non-sensitive user metadata. Passwords are NEVER stored here.
-- Linked 1-to-1 with auth.users via the user's UUID.

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text          default '',
  email        text          default '',
  avatar_url   text          default '',
  created_at   timestamptz   not null default now(),
  updated_at   timestamptz   not null default now()
);

comment on table public.profiles is
  'User profile metadata. Linked to auth.users. No passwords stored here.';

-- ─── 2. Enable Row Level Security ───────────────────────────
alter table public.profiles enable row level security;

-- ─── 3. RLS Policies ─────────────────────────────────────────
-- Each user can only view, insert, and update their own row.

-- SELECT: users can read only their own profile
drop policy if exists "profiles: users can view own profile" on public.profiles;
create policy "profiles: users can view own profile"
  on public.profiles
  for select
  using (auth.uid() = id);

-- INSERT: users can create only their own profile
drop policy if exists "profiles: users can insert own profile" on public.profiles;
create policy "profiles: users can insert own profile"
  on public.profiles
  for insert
  with check (auth.uid() = id);

-- UPDATE: users can update only their own profile
drop policy if exists "profiles: users can update own profile" on public.profiles;
create policy "profiles: users can update own profile"
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ─── 4. Auto-create profile on signup ───────────────────────
-- This trigger fires after every new row is inserted into auth.users
-- (covers both email/password signup and Google OAuth).
-- It creates the matching profile row automatically.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'avatar_url', '')
  )
  on conflict (id) do nothing;   -- idempotent: safe to re-run
  return new;
end;
$$;

-- Drop and recreate to make this script idempotent
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute procedure public.handle_new_user();

-- Backfill profiles for users created before this migration was installed.
insert into public.profiles (id, full_name, email, avatar_url)
select
  id,
  coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', ''),
  coalesce(email, ''),
  coalesce(raw_user_meta_data->>'avatar_url', raw_user_meta_data->>'picture', '')
from auth.users
on conflict (id) do update set
  full_name = case when public.profiles.full_name = '' then excluded.full_name else public.profiles.full_name end,
  email = case when public.profiles.email = '' then excluded.email else public.profiles.email end,
  avatar_url = case when public.profiles.avatar_url = '' then excluded.avatar_url else public.profiles.avatar_url end;

-- ─── 5. Auto-update `updated_at` timestamp ──────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row
  execute procedure public.set_updated_at();

-- ─── Done ────────────────────────────────────────────────────
-- Verify with:
--   select * from public.profiles limit 5;
--   select policyname, cmd from pg_policies where tablename = 'profiles';

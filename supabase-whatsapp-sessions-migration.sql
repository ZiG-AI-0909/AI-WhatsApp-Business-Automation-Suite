-- =============================================================
-- Multi-Tenant Phase 2 Migration — Per-User WhatsApp Sessions
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- AFTER supabase-multitenant-migration.sql (Phase 1)
-- =============================================================
-- Stores each user's Baileys WhatsApp auth state (credentials +
-- encryption keys) as JSON, keyed by user_id. Replaces the old
-- single-tenant .baileys_auth/ folder on the ephemeral Render
-- filesystem: sessions now survive restarts AND are fully
-- isolated per user.
--
-- SECURITY: auth_state contains WhatsApp session keys. It must
-- never be readable across tenants. RLS below restricts direct
-- PostgREST access to the owning user; the backend uses the
-- service role key (bypasses RLS) but only ever touches rows
-- for the authenticated req.user.id.
-- =============================================================

-- 1. Table: one row per user. ON DELETE CASCADE keeps this in
--    sync when an auth user is removed.
create table if not exists public.whatsapp_sessions (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    auth_state jsonb,
    updated_at timestamptz not null default now()
);

-- 2. Index for housekeeping queries (e.g. stale session cleanup)
create index if not exists idx_whatsapp_sessions_updated
    on public.whatsapp_sessions(updated_at);

-- 3. RLS: only the owning user may see/modify their session row.
--    Anonymous access is denied (auth.uid() is null → no match).
alter table public.whatsapp_sessions enable row level security;
drop policy if exists "tenant_whatsapp_sessions" on public.whatsapp_sessions;
create policy "tenant_whatsapp_sessions" on public.whatsapp_sessions
    for all
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- 4. Keep updated_at fresh automatically
drop trigger if exists trg_whatsapp_sessions_updated_at on public.whatsapp_sessions;
create trigger trg_whatsapp_sessions_updated_at
    before update on public.whatsapp_sessions
    for each row execute function moddatetime(updated_at);

-- NOTE: if moddatetime (from the `moddatetime` extension) is not
-- enabled in your project, enable it first, or remove the trigger —
-- the backend also writes updated_at explicitly on every upsert:
--   create extension if not exists moddatetime with schema extensions;

-- =============================================================
-- Verify:
--   select column_name, data_type from information_schema.columns
--     where table_name = 'whatsapp_sessions';
-- =============================================================

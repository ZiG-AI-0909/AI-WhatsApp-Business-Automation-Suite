-- =============================================================
-- Multi-Tenant Phase 1 Migration — Data Isolation
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- AFTER supabase-data-migration.sql
-- =============================================================
-- Adds a user_id owner column to every tenant table (FK to auth.users),
-- turns app_settings into a per-user key-value store, and creates RLS
-- policies so each table only exposes rows where user_id = auth.uid().
--
-- NOTE: the backend uses the service role key, which BYPASSES RLS. These
-- policies are a safety net for direct/anonymous PostgREST access; the real
-- enforcement is in the application layer (every query is scoped by
-- user_id). The service role still bypasses RLS so the backend's scoped
-- queries work unchanged.
-- =============================================================

-- 1. Add user_id ownership column to every tenant table
alter table public.contacts            add column if not exists user_id uuid references auth.users(id);
alter table public.conversations       add column if not exists user_id uuid references auth.users(id);
alter table public.messages            add column if not exists user_id uuid references auth.users(id);
alter table public.templates           add column if not exists user_id uuid references auth.users(id);
alter table public.campaigns           add column if not exists user_id uuid references auth.users(id);
alter table public.campaign_contacts   add column if not exists user_id uuid references auth.users(id);
alter table public.knowledge_documents add column if not exists user_id uuid references auth.users(id);
alter table public.knowledge_chunks    add column if not exists user_id uuid references auth.users(id);
alter table public.campaign_schedules  add column if not exists user_id uuid references auth.users(id);
alter table public.image_leads         add column if not exists user_id uuid references auth.users(id);
alter table public.app_settings        add column if not exists user_id uuid references auth.users(id);

-- 2. Indexes for tenant-scoped lookups
create index if not exists idx_contacts_user            on public.contacts(user_id);
create index if not exists idx_conversations_user       on public.conversations(user_id);
create index if not exists idx_messages_user            on public.messages(user_id);
create index if not exists idx_templates_user           on public.templates(user_id);
create index if not exists idx_campaigns_user           on public.campaigns(user_id);
create index if not exists idx_campaign_contacts_user   on public.campaign_contacts(user_id);
create index if not exists idx_knowledge_documents_user on public.knowledge_documents(user_id);
create index if not exists idx_knowledge_chunks_user    on public.knowledge_chunks(user_id);
create index if not exists idx_campaign_schedules_user  on public.campaign_schedules(user_id);
create index if not exists idx_image_leads_user         on public.image_leads(user_id);

-- 3. app_settings becomes per-user: composite primary key (user_id, key)
alter table public.app_settings drop constraint if exists app_settings_pkey;
alter table public.app_settings add constraint app_settings_pkey primary key (user_id, key);
create index if not exists idx_app_settings_user on public.app_settings(user_id);

-- 4. Backfill (only if you have pre-migration rows you want to keep visible):
--    Legacy rows have user_id NULL and are invisible to every tenant under
--    RLS. Claim them explicitly, e.g.:
--      update public.contacts set user_id = '<owner-uuid>' where user_id is null;
--    Repeat for each table that has data. New writes always set user_id.

-- 5. RLS policies — one per table: rows are only visible/modifiable by the
--    owning authenticated user (auth.uid()). Anonymous access is denied
--    (auth.uid() is null, so user_id = auth.uid() is never true).
do $$
declare t text;
begin
  foreach t in array array[
      'contacts','conversations','messages','templates','campaigns',
      'campaign_contacts','knowledge_documents','knowledge_chunks',
      'campaign_schedules','image_leads','app_settings'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "tenant_%I" on public.%I;', t, t);
    execute format(
      'create policy "tenant_%I" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid());',
      t, t
    );
  end loop;
end $$;

-- =============================================================
-- Verify:
--   select table_name from information_schema.columns
--     where column_name = 'user_id' order by table_name;
-- =============================================================
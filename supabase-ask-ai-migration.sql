-- =============================================================
-- Ask AI (Technical Query Resolver) — query history storage.
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- AFTER supabase-multitenant-migration.sql
-- =============================================================
create table if not exists public.ai_queries (
    id               bigserial primary key,
    question         text not null,
    answer           text not null,
    source_doc_ids   text default '[]',
    source_doc_names text default '[]',
    user_id          uuid references auth.users(id),
    created_at       timestamptz default now()
);

comment on table public.ai_queries is 'Internal Ask AI question history, per tenant (user_id)';

alter table public.ai_queries enable row level security;

-- Same RLS safety net as other tenant tables (see supabase-multitenant-migration.sql):
-- the backend uses the service role key; application-layer user_id scoping is the
-- real enforcement.
create policy "Tenant isolation for ai_queries" on public.ai_queries
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists idx_ai_queries_user on public.ai_queries(user_id);

drop trigger if exists is_ai_queries_owner on public.ai_queries;

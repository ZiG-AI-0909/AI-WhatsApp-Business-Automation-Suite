-- =============================================================
-- Product Identification (Image Extractor second mode) storage.
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- AFTER supabase-multitenant-migration.sql
-- =============================================================
create table if not exists public.product_identifications (
    id              bigserial primary key,
    source_image    text default '',
    product_category text default '',
    size            text default '',
    specification   text default '',
    markings        text default '[]',
    condition_notes text default '',
    confidence      double precision default 0,
    review_status   text default 'pending_review',
    user_id         uuid references auth.users(id),
    created_at      timestamptz default now(),
    updated_at      timestamptz default now()
);

comment on table public.product_identifications is 'AI product identification suggestions from photos, per tenant (user_id) — suggestions require manual verification';

alter table public.product_identifications enable row level security;

-- Same RLS safety net as other tenant tables: the backend uses the service
-- role key; application-layer user_id scoping is the real enforcement.
create policy "Tenant isolation for product_identifications" on public.product_identifications
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists idx_product_identifications_user on public.product_identifications(user_id);

drop trigger if exists set_product_identifications_updated_at on public.product_identifications;
create trigger set_product_identifications_updated_at
    before update on public.product_identifications
    for each row execute procedure public.set_updated_at();

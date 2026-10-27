-- =============================================================
-- Proforma Invoice Maker (export proforma invoices -> Excel).
-- Run this in: Supabase Dashboard -> SQL Editor -> New Query
-- AFTER supabase-data-migration.sql (needs public.set_updated_at()).
--
-- Idempotent: safe to rerun. Same tenant model as quotations: a user_id
-- column + RLS as a safety net; the backend uses the service role and
-- scopes every query by user_id.
--
-- Until this runs, the Proforma Maker still previews and exports; only
-- saving invoices and the saved company profile are unavailable.
-- =============================================================

-- ─── proforma_invoices ───────────────────────────────────────
-- The whole invoice form (parties, shipping, items, freight, terms) is one
-- jsonb document: it is always loaded and saved as a unit. The columns
-- beside it are copies for listing, searching and the number check.
create table if not exists public.proforma_invoices (
    id              bigserial primary key,
    user_id         uuid not null references auth.users(id) on delete cascade,
    invoice_number  text not null default '',
    invoice_date    date,
    consignee_name  text not null default '',
    buyer_name      text not null default '',
    currency        text not null default 'USD',
    grand_total     numeric(16,2) not null default 0,
    data            jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

alter table public.proforma_invoices drop constraint if exists proforma_invoices_currency_check;
alter table public.proforma_invoices add constraint proforma_invoices_currency_check
    check (currency in ('USD', 'EUR', 'GBP', 'AED'));

-- One saved invoice per number per tenant (drafts without a number are free).
create unique index if not exists idx_proforma_invoices_user_number
    on public.proforma_invoices(user_id, invoice_number)
    where invoice_number <> '';
create index if not exists idx_proforma_invoices_user_updated
    on public.proforma_invoices(user_id, updated_at desc);

comment on table public.proforma_invoices is 'Export proforma invoices per tenant (user_id). data holds the full form; totals are recomputed by the backend.';

-- ─── proforma_profiles: the exporter's saved defaults ────────
-- Company, bank, shipping defaults, standard terms and numbering pattern
-- used to start every new invoice. One row per tenant.
create table if not exists public.proforma_profiles (
    user_id     uuid primary key references auth.users(id) on delete cascade,
    profile     jsonb not null default '{}'::jsonb,
    updated_at  timestamptz not null default now()
);

-- ─── RLS ─────────────────────────────────────────────────────
alter table public.proforma_invoices enable row level security;
alter table public.proforma_profiles enable row level security;

drop policy if exists "Tenant isolation for proforma_invoices" on public.proforma_invoices;
create policy "Tenant isolation for proforma_invoices" on public.proforma_invoices
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "Tenant isolation for proforma_profiles" on public.proforma_profiles;
create policy "Tenant isolation for proforma_profiles" on public.proforma_profiles
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop trigger if exists set_proforma_invoices_updated_at on public.proforma_invoices;
create trigger set_proforma_invoices_updated_at
    before update on public.proforma_invoices
    for each row execute procedure public.set_updated_at();
drop trigger if exists set_proforma_profiles_updated_at on public.proforma_profiles;
create trigger set_proforma_profiles_updated_at
    before update on public.proforma_profiles
    for each row execute procedure public.set_updated_at();

notify pgrst, 'reload schema';

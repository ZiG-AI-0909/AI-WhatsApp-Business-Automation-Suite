-- =============================================================
-- Billing — customers outside the company (default monthly price)
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- AFTER supabase-billing-migration.sql. Safe to re-run.
-- =============================================================
-- Who is a customer:
--   * any account ticked "Must pay" in Setup → Subscriptions, and
--   * any account that is NOT company staff (no area given in Team &
--     access) once a default monthly price is set here.
-- Customers only see the subscription page until they pay, and then work
-- in their OWN workspace — never the company's data or settings.
-- Company staff (given areas in Team & access, not ticked) stay free.
-- =============================================================

create table if not exists public.billing_settings (
    id                   smallint primary key default 1 check (id = 1),
    default_amount_paise integer not null default 0 check (default_amount_paise >= 0),
    updated_at           timestamptz not null default now(),
    updated_by_email     text
);
insert into public.billing_settings (id) values (1) on conflict (id) do nothing;

alter table public.billing_settings enable row level security;

-- Verify:  select * from public.billing_settings;

-- =============================================================
-- Billing (Razorpay monthly subscription) Migration
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- AFTER supabase-team-access-migration.sql (uses team_list_accounts()).
-- =============================================================
-- A super admin ticks which accounts must pay and sets each one's monthly
-- price. Those accounts can use the automation (WhatsApp, campaigns,
-- email campaigns…) only while paid_until is in the future. Each Razorpay
-- payment adds one month. Accounts with no row (or required = false) are
-- free, so nothing changes for anyone until a super admin ticks them.
-- Safe to re-run.
-- =============================================================

create table if not exists public.billing_accounts (
    user_id         uuid primary key references auth.users(id) on delete cascade,
    email           text,
    required        boolean not null default false,
    amount_paise    integer not null default 0 check (amount_paise >= 0),
    currency        text not null default 'INR',
    paid_until      timestamptz,
    updated_at      timestamptz not null default now(),
    updated_by_email text
);

create table if not exists public.billing_payments (
    id                  bigserial primary key,
    user_id             uuid not null references auth.users(id) on delete cascade,
    razorpay_order_id   text not null unique,
    razorpay_payment_id text unique,
    amount_paise        integer not null,
    currency            text not null default 'INR',
    status              text not null default 'created',  -- created | paid | manual
    period_start        timestamptz,
    period_end          timestamptz,
    note                text,
    created_at          timestamptz not null default now(),
    paid_at             timestamptz
);

create index if not exists idx_billing_payments_user on public.billing_payments(user_id, created_at desc);

-- Backend (service role) only.
alter table public.billing_accounts enable row level security;
alter table public.billing_payments enable row level security;

-- =============================================================
-- Verify:
--   select * from public.billing_accounts;
-- =============================================================

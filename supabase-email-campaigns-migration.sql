-- =============================================================
-- Bulk Email Campaigns Migration
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- AFTER supabase-multitenant-migration.sql
-- =============================================================
-- Bulk email lives in its OWN tables, separate from the WhatsApp
-- `campaigns` / `campaign_contacts` tables. The WhatsApp queue and
-- scheduler scan `campaigns` on every restart; keeping email apart means
-- an email campaign can never be picked up by the WhatsApp sender.
--
--   email_campaigns            — one row per bulk email campaign
--   email_campaign_recipients  — one row per recipient (rendered email)
--   email_unsubscribes         — addresses that clicked "unsubscribe"
--
-- Sending credentials (SMTP / Resend) live in app_settings as before.
-- Safe to re-run.
-- =============================================================

create table if not exists public.email_campaigns (
    id              bigserial primary key,
    user_id         uuid not null,
    name            text not null,
    subject         text not null,
    body            text not null,              -- plain text or simple HTML with {{fields}}
    status          text not null default 'draft',
    total           integer not null default 0,
    sent            integer not null default 0,
    failed          integer not null default 0,
    skipped         integer not null default 0,
    settings        jsonb not null default '{}'::jsonb,  -- { delaySeconds, dailyLimit }
    last_error      text,
    started_at      timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

alter table public.email_campaigns drop constraint if exists email_campaigns_status_check;
alter table public.email_campaigns add constraint email_campaigns_status_check
    check (status in ('draft', 'running', 'paused', 'stopped', 'completed', 'completed_with_errors'));

create index if not exists idx_email_campaigns_user on public.email_campaigns(user_id, created_at desc);
create index if not exists idx_email_campaigns_status on public.email_campaigns(status);

create table if not exists public.email_campaign_recipients (
    id              bigserial primary key,
    campaign_id     bigint not null references public.email_campaigns(id) on delete cascade,
    user_id         uuid not null,
    email           text not null,
    name            text,
    fields          jsonb not null default '{}'::jsonb,
    rendered_subject text,
    rendered_body   text,
    status          text not null default 'pending',   -- pending | sent | failed | skipped
    error           text,
    message_id      text,
    attempts        integer not null default 0,
    sent_at         timestamptz,
    created_at      timestamptz not null default now()
);

create index if not exists idx_email_recipients_campaign on public.email_campaign_recipients(campaign_id, status, id);
create index if not exists idx_email_recipients_user_sent on public.email_campaign_recipients(user_id, sent_at);

create table if not exists public.email_unsubscribes (
    id              bigserial primary key,
    user_id         uuid not null,
    email           text not null,
    created_at      timestamptz not null default now(),
    unique (user_id, email)
);

-- Service-role backend only: enable RLS with no policies so the anon /
-- authenticated keys cannot read these tables directly.
alter table public.email_campaigns enable row level security;
alter table public.email_campaign_recipients enable row level security;
alter table public.email_unsubscribes enable row level security;

-- =============================================================
-- Verify:
--   select table_name from information_schema.tables
--    where table_name like 'email_%' order by 1;
-- =============================================================

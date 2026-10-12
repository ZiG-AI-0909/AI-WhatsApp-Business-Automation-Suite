-- =============================================================
-- Email Campaigns Phase 1 Migration — Data Model
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- AFTER supabase-data-migration.sql AND supabase-multitenant-migration.sql
-- =============================================================
-- Adds email-channel support alongside the existing WhatsApp campaigns:
--   1. contacts.email      — optional email address (phone stays required)
--   2. campaigns.channel   — 'whatsapp' | 'email' (default 'whatsapp', so
--                            every existing row stays a WhatsApp campaign)
--   3. campaigns.subject   — email subject line (email campaigns only)
--   4. campaigns.html_body — email HTML content (email campaigns only;
--                            WhatsApp campaigns keep using template_message)
--   5. templates.channel   — 'whatsapp' | 'email' (default 'whatsapp')
--   6. templates.subject   — email subject line (email templates only)
--
-- Nothing is removed or renamed: all existing WhatsApp columns keep their
-- names and semantics, so WhatsApp campaigns/templates work unchanged.
--
-- Per-user Resend credentials (RESEND_API_KEY, RESEND_FROM_EMAIL,
-- RESEND_FROM_NAME) need NO migration: they are stored as new keys in the
-- existing per-user app_settings key-value store from the multi-tenant
-- Phase 1 migration (composite PK (user_id, key)).
-- =============================================================

-- 1. CONTACTS: optional email address.
-- Nullable — phone remains the required unique identifier; a contact may
-- have an email, a phone, or both.
alter table public.contacts
    add column if not exists email text;

-- Partial unique index: prevents two contacts of the same user claiming the
-- same email address, while allowing unlimited NULL emails. Indexing only
-- non-null values keeps existing phone-only rows unaffected.
create unique index if not exists idx_contacts_email_unique
    on public.contacts(email)
    where email is not null;

create index if not exists idx_contacts_email
    on public.contacts(email);

-- 2. CAMPAIGNS: channel discriminator + email-only content columns.
-- channel defaults to 'whatsapp' so every existing row (and any row inserted
-- without an explicit channel) is backward compatible.
alter table public.campaigns
    add column if not exists channel text not null default 'whatsapp';

alter table public.campaigns
    add column if not exists subject text;

alter table public.campaigns
    add column if not exists html_body text;

-- Allow-list check constraint so a typo can't create an unsendable channel.
alter table public.campaigns
    drop constraint if exists campaigns_channel_check;
alter table public.campaigns
    add constraint campaigns_channel_check
    check (channel in ('whatsapp', 'email'));

-- Email campaigns always need a subject + body; WhatsApp campaigns are
-- unaffected (their template_message column remains NOT NULL as before).
alter table public.campaigns
    drop constraint if exists campaigns_email_content_check;
alter table public.campaigns
    add constraint campaigns_email_content_check
    check (channel <> 'email' or (subject is not null and html_body is not null));

create index if not exists idx_campaigns_channel
    on public.campaigns(channel);

-- 3. TEMPLATES: same channel pattern for reusable email templates.
alter table public.templates
    add column if not exists channel text not null default 'whatsapp';

alter table public.templates
    add column if not exists subject text;

alter table public.templates
    drop constraint if exists templates_channel_check;
alter table public.templates
    add constraint templates_channel_check
    check (channel in ('whatsapp', 'email'));

create index if not exists idx_templates_channel
    on public.templates(channel);

-- =============================================================
-- Verify:
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_name in ('contacts','campaigns','templates')
--      and (column_name in ('email','channel','subject','html_body'))
--    order by table_name, column_name;
--
--   select channel, count(*) from public.campaigns group by channel;
--   select channel, count(*) from public.templates group by channel;
-- =============================================================

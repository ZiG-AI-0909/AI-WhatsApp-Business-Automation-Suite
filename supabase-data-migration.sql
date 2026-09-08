-- =============================================================
-- Supabase Data Tables Migration
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- =============================================================
-- This migration creates all tables needed to replace the SQLite
-- database (data/Bhavesh.db) when deploying to Render free tier.
-- All tables use BIGSERIAL for auto-incrementing IDs to match
-- the frontend's expectation of integer IDs.
-- =============================================================

-- Enable UUID extension (may already be enabled)
create extension if not exists "uuid-ossp";

-- ============================================================
-- 1. CONTACTS
-- ============================================================
create table if not exists public.contacts (
    id                bigserial primary key,
    phone             text unique not null,
    name              text default '',
    company           text default '',
    city              text default '',
    marketing_opt_in  bigint default 1,
    tags              text default '[]',
    notes             text default '',
    is_lid            bigint default 0,
    jid               text,
    last_message_at   timestamptz,
    created_at        timestamptz default now(),
    updated_at        timestamptz default now()
);

comment on table public.contacts is 'Contact phone numbers and metadata';

create index if not exists idx_contacts_phone on public.contacts(phone);

-- ============================================================
-- 2. CONVERSATIONS
-- ============================================================
create table if not exists public.conversations (
    id                bigserial primary key,
    contact_id        bigint references public.contacts(id) on delete cascade,
    status            text default 'open',
    ai_enabled        bigint default 1,
    last_message_at   timestamptz,
    unread_count      bigint default 0,
    created_at        timestamptz default now()
);

comment on table public.conversations is 'WhatsApp conversations linked to contacts';

create index if not exists idx_conversations_contact on public.conversations(contact_id);

-- ============================================================
-- 3. MESSAGES
-- ============================================================
create table if not exists public.messages (
    id                  bigserial primary key,
    conversation_id     bigint references public.conversations(id) on delete cascade,
    direction           text not null,
    body                text not null,
    status              text default 'sent',
    wa_message_id       text,
    provider            text default '',
    sender              text default '',
    timestamp           bigint,
    created_at          timestamptz default now()
);

comment on table public.messages is 'Individual WhatsApp messages within conversations';

create index if not exists idx_messages_conversation on public.messages(conversation_id);
create unique index if not exists idx_messages_provider_id on public.messages(wa_message_id) where wa_message_id is not null;

-- ============================================================
-- 4. TEMPLATES
-- ============================================================
create table if not exists public.templates (
    id          bigserial primary key,
    name        text not null,
    content     text not null,
    created_at  timestamptz default now(),
    updated_at  timestamptz default now()
);

comment on table public.templates is 'Message templates for campaigns';

-- ============================================================
-- 5. CAMPAIGNS
-- ============================================================
create table if not exists public.campaigns (
    id                  bigserial primary key,
    name                text not null,
    status              text default 'draft',
    template_message    text not null,
    total_contacts      bigint default 0,
    processed           bigint default 0,
    sent                bigint default 0,
    failed              bigint default 0,
    replies             bigint default 0,
    opt_outs            bigint default 0,
    skipped             bigint default 0,
    settings            text default '{}',
    provider            text default 'web',
    media_path          text,
    media_type          text,
    media_filename      text,
    media_mimetype      text,
    buttons             text default '[]',
    created_at          timestamptz default now(),
    started_at          timestamptz,
    completed_at        timestamptz,
    updated_at          timestamptz default now()
);

comment on table public.campaigns is 'Bulk messaging campaigns';

-- ============================================================
-- 6. CAMPAIGN_CONTACTS (campaign-membership junction table)
-- ============================================================
create table if not exists public.campaign_contacts (
    id                  bigserial primary key,
    campaign_id         bigint references public.campaigns(id) on delete cascade,
    contact_id          bigint references public.contacts(id),
    rendered_message    text,
    status              text default 'pending',
    attempts            bigint default 0,
    last_error          text,
    sent_at             timestamptz,
    provider_message_id text,
    retry_at            timestamptz
);

comment on table public.campaign_contacts is 'Contacts enrolled in a campaign with send status';

create index if not exists idx_campaign_contacts_campaign on public.campaign_contacts(campaign_id);
create index if not exists idx_campaign_contacts_status on public.campaign_contacts(status);
create unique index if not exists idx_campaign_contact_provider_message on public.campaign_contacts(provider_message_id) where provider_message_id is not null;

-- ============================================================
-- 7. KNOWLEDGE_DOCUMENTS
-- ============================================================
create table if not exists public.knowledge_documents (
    id          bigserial primary key,
    name        text not null,
    category    text default 'general',
    content     text default '',
    file_path   text,
    status      text default 'active',
    created_at  timestamptz default now()
);

comment on table public.knowledge_documents is 'Knowledge base documents for AI context';

-- ============================================================
-- 8. KNOWLEDGE_CHUNKS
-- ============================================================
create table if not exists public.knowledge_chunks (
    id            bigserial primary key,
    document_id   bigint references public.knowledge_documents(id) on delete cascade,
    content       text not null,
    chunk_index   bigint default 0
);

comment on table public.knowledge_chunks is 'Chunks of knowledge documents for retrieval';

-- ============================================================
-- 9. CAMPAIGN_SCHEDULES
-- ============================================================
create table if not exists public.campaign_schedules (
    id                    bigserial primary key,
    name                  text not null,
    template_message      text not null,
    file_path             text not null,
    media_path            text,
    media_type            text,
    media_filename        text,
    media_mimetype        text,
    buttons               text default '[]',
    settings              text default '{}',
    allow_missing_fields  bigint default 0,
    schedule_type         text not null,
    run_at                timestamptz,
    recurrence_cron       text,
    status                text default 'pending',
    last_run_at           timestamptz,
    next_run_at           timestamptz,
    last_campaign_id      bigint,
    last_error            text,
    created_at            timestamptz default now(),
    updated_at            timestamptz default now()
);

comment on table public.campaign_schedules is 'Scheduled/recurring campaign definitions';

-- ============================================================
-- 10. IMAGE_LEADS (from image extractor)
-- ============================================================
create table if not exists public.image_leads (
    id                    bigserial primary key,
    source_image          text default '',
    extraction_group_id   text default '',
    business_name         text default '',
    phone_numbers         text default '[]',
    emails                text default '[]',
    website               text default '',
    address               text default '',
    city                  text default '',
    state                 text default '',
    country               text default '',
    postal_code           text default '',
    business_category     text default '',
    contact_person        text default '',
    social_links          text default '[]',
    raw_text              text default '',
    duplicate_status      text default '',
    review_status         text default 'pending_review',
    confidence            double precision default 0,
    processing_status     text default 'completed',
    created_at            timestamptz default now(),
    updated_at            timestamptz default now()
);

comment on table public.image_leads is 'Leads extracted from business images';

-- ============================================================
-- 11. APP_SETTINGS (key-value store for settings persistence)
-- ============================================================
create table if not exists public.app_settings (
    key         text primary key,
    value       text not null,
    updated_at  timestamptz default now()
);

comment on table public.app_settings is 'Application settings persisted across restarts';

-- ============================================================
-- Enable Row Level Security on all tables
-- NOTE: Server-side code uses the service role key which bypasses RLS.
-- RLS is still enabled for safety, but the service role key will
-- have full access. Adjust policies if you need row-level restrictions.
-- ============================================================

-- Contacts: allow all operations via service role (no RLS restrictions)
alter table public.contacts enable row level security;

-- Conversations
alter table public.conversations enable row level security;

-- Messages
alter table public.messages enable row level security;

-- Templates
alter table public.templates enable row level security;

-- Campaigns
alter table public.campaigns enable row level security;

-- Campaign Contacts
alter table public.campaign_contacts enable row level security;

-- Knowledge Documents
alter table public.knowledge_documents enable row level security;

-- Knowledge Chunks
alter table public.knowledge_chunks enable row level security;

-- Campaign Schedules
alter table public.campaign_schedules enable row level security;

-- Image Leads
alter table public.image_leads enable row level security;

-- App Settings
alter table public.app_settings enable row level security;

-- ============================================================
-- Helper: updated_at trigger function
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

-- ============================================================
-- Apply updated_at triggers to all relevant tables
-- ============================================================

drop trigger if exists set_contacts_updated_at on public.contacts;
create trigger set_contacts_updated_at
    before update on public.contacts
    for each row execute procedure public.set_updated_at();

drop trigger if exists set_templates_updated_at on public.templates;
create trigger set_templates_updated_at
    before update on public.templates
    for each row execute procedure public.set_updated_at();

drop trigger if exists set_campaigns_updated_at on public.campaigns;
create trigger set_campaigns_updated_at
    before update on public.campaigns
    for each row execute procedure public.set_updated_at();

drop trigger if exists set_schedules_updated_at on public.campaign_schedules;
create trigger set_schedules_updated_at
    before update on public.campaign_schedules
    for each row execute procedure public.set_updated_at();

drop trigger if exists set_image_leads_updated_at on public.image_leads;
create trigger set_image_leads_updated_at
    before update on public.image_leads
    for each row execute procedure public.set_updated_at();

drop trigger if exists set_app_settings_updated_at on public.app_settings;
create trigger set_app_settings_updated_at
    before update on public.app_settings
    for each row execute procedure public.set_updated_at();

-- ============================================================
-- DONE
-- ============================================================
-- Verify with:
--   select table_name from information_schema.tables where table_schema = 'public' order by table_name;
--   \d+ public.contacts
--   \d+ public.conversations
--   \d+ public.messages
--   etc.

-- =============================================================
-- Knowledge Base audience isolation: internal_only flag.
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- AFTER supabase-ask-ai-migration.sql
--
-- WHY: knowledge_documents feeds BOTH the customer-facing WhatsApp
-- auto-reply (knowledgeBase.getRelevantContext) and the internal
-- Ask AI tool (queryService.retrieveSources). The seeded
-- "How to Use This Platform" document (and any future staff-only
-- upload) must power Ask AI but NEVER reach a real customer through
-- the auto-reply bot.
--
-- SAFE BY DEFAULT: false means "visible to both audiences", so every
-- existing document keeps its current behaviour — no backfill needed
-- for regular content. Only the seeded Platform Help documents are
-- flipped to true below (idempotent).
-- =============================================================

-- 1. Add the flag (no-op if this migration already ran).
alter table public.knowledge_documents
    add column if not exists internal_only boolean not null default false;

comment on column public.knowledge_documents.internal_only is
    'true = internal staff content only: searchable by Ask AI, excluded from the customer-facing WhatsApp auto-reply';

-- 2. Mark the seeded platform-help documents internal-only. Matches by
-- category so it also catches any manual re-uploads of the same guide.
update public.knowledge_documents
set internal_only = true
where category = 'Platform Help'
  and internal_only = false;

-- =============================================================
-- Schedule estimate cache — precomputed campaign-run duration.
--
-- estimate_json         { contacts, durationMs } payload
-- estimate_computed_at  when the payload was computed
-- estimate_source_hash  sha256 of (file identity + settings); when it
--                       matches the schedule's current file/settings the
--                       cached payload is reused instead of re-parsing
--                       the Excel file
--
-- Idempotent: safe to run more than once.
-- =============================================================

alter table public.campaign_schedules add column if not exists estimate_json jsonb null;
alter table public.campaign_schedules add column if not exists estimate_computed_at timestamptz null;
alter table public.campaign_schedules add column if not exists estimate_source_hash text null;

comment on column public.campaign_schedules.estimate_json is 'Cached { contacts, durationMs } estimate for one campaign run';
comment on column public.campaign_schedules.estimate_computed_at is 'When estimate_json was computed';
comment on column public.campaign_schedules.estimate_source_hash is 'sha256 of file identity + settings JSON; cache key for estimate_json';

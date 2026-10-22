-- =============================================================
-- Mechanic / Technician Partner registration (Sudarshan Extrusions Pvt. Ltd.)
--
-- One public registration form for the company itself — NOT per-tenant
-- data, so there is no user_id column. Same access model as vendor KYC
-- (supabase-vendor-kyc-migration.sql — run that one first; this file
-- reuses its kyc-documents bucket, private.kyc_staff list and trigger):
--   * Partners submit through POST /api/public/technician (rate-limited,
--     validated). The backend writes with the service role.
--   * Staff review through /api/technicians/*, which requires a signed-in
--     user listed in private.kyc_staff (the same reviewers as vendor KYC).
--   * RLS is ON with NO policies, so the anon key in the frontend can
--     neither read nor write rows. The optional Aadhaar goes in the
--     PRIVATE kyc-documents bucket (no storage policies) as
--     technicians/<id>/aadhaar.<ext>; only its path is stored here, and
--     staff open it through 10-minute signed URLs.
--
-- Run once in the Supabase SQL Editor. Safe to re-run, and safe to run on
-- a table created by an earlier version of this file (it only adds
-- columns and relaxes date_of_birth; existing rows are kept).
-- =============================================================

-- An earlier draft of this form used public.technician_registrations.
-- Remove it only if it exists and is empty; otherwise leave it alone.
do $$
begin
    if to_regclass('public.technician_registrations') is not null then
        if not exists (select 1 from public.technician_registrations) then
            drop table public.technician_registrations;
        else
            raise notice 'public.technician_registrations has rows; left in place.';
        end if;
    end if;
end;
$$;

create table if not exists public.technician_partner_registrations (
    id            uuid primary key default gen_random_uuid(),
    submitted_at  timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    status        text not null default 'pending'
                  check (status in ('pending', 'shortlisted', 'approved', 'rejected')),

    -- The form fields, in form order. district is always a Tamil Nadu
    -- district (list in backend/src/technician/technicianSchema.js),
    -- whichever state is chosen. Optional: shop_name, both dates, the shop
    -- location and the Aadhaar upload.
    full_name         text not null check (char_length(full_name) between 2 and 120),
    district          text not null,
    place             text not null,
    shop_name         text check (char_length(shop_name) <= 120),
    mobile            text not null check (mobile ~ '^[6-9][0-9]{9}$'),
    address           text not null,
    pincode           text not null check (pincode ~ '^[1-9][0-9]{5}$'),
    state             text not null check (state in ('Tamil Nadu', 'Karnataka', 'Andhra Pradesh')),
    date_of_birth     date,
    date_of_marriage  date check (date_of_marriage is null or date_of_birth is null or date_of_marriage >= date_of_birth),
    -- Shop location (optional): 'device' = the phone's location button
    -- (coordinates + a generated https://www.google.com/maps?q=lat,lng link);
    -- 'link' = a Google Maps link the partner pasted (coordinates only when
    -- the link contains them).
    shop_latitude             numeric(9,6) check (shop_latitude between -90 and 90),
    shop_longitude            numeric(9,6) check (shop_longitude between -180 and 180),
    shop_location_accuracy_m  integer check (shop_location_accuracy_m >= 0),
    shop_maps_url             text check (char_length(shop_maps_url) <= 500),
    shop_location_source      text check (shop_location_source in ('device', 'link')),
    -- Optional Aadhaar upload, only when one was uploaded:
    --   { "aadhaar": { "path": "technicians/<id>/aadhaar.<ext>", "file_name": "aadhaar.<ext>",
    --                  "mime_type": "...", "size": 12345 } }
    documents         jsonb not null default '{}'::jsonb check (jsonb_typeof(documents) = 'object'),

    submitter_ip          text,
    submitter_user_agent  text,

    -- Staff review (never set by the public form)
    review_remarks  text,
    reviewed_by     uuid references auth.users(id) on delete set null,
    reviewed_at     timestamptz
);

-- Upgrade a table created by the earlier version of this file (DOB was
-- required; no shop name or location). Adds columns only — no data is lost.
alter table public.technician_partner_registrations
    add column if not exists shop_name text check (char_length(shop_name) <= 120),
    add column if not exists shop_latitude numeric(9,6) check (shop_latitude between -90 and 90),
    add column if not exists shop_longitude numeric(9,6) check (shop_longitude between -180 and 180),
    add column if not exists shop_location_accuracy_m integer check (shop_location_accuracy_m >= 0),
    add column if not exists shop_maps_url text check (char_length(shop_maps_url) <= 500),
    add column if not exists shop_location_source text check (shop_location_source in ('device', 'link'));
alter table public.technician_partner_registrations alter column date_of_birth drop not null;

create index if not exists technician_partner_registrations_submitted_idx on public.technician_partner_registrations (submitted_at desc);
create index if not exists technician_partner_registrations_status_submitted_idx on public.technician_partner_registrations (status, submitted_at desc);

-- Reuses the updated_at trigger function from the vendor KYC migration.
drop trigger if exists technician_partner_registrations_touch on public.technician_partner_registrations;
create trigger technician_partner_registrations_touch
    before update on public.technician_partner_registrations
    for each row execute function public.kyc_submissions_touch();

-- RLS on, no policies: anon/authenticated get nothing; the backend's
-- service role bypasses RLS. Revoke the default table grants as well.
alter table public.technician_partner_registrations enable row level security;
revoke all on public.technician_partner_registrations from anon, authenticated;

-- ─── Verify ──────────────────────────────────────────────────
-- 1. No policies on the table (expect 0 rows):
--      select policyname from pg_policies where schemaname = 'public' and tablename = 'technician_partner_registrations';
-- 2. The bucket is private (expect public = false):
--      select id, public from storage.buckets where id = 'kyc-documents';
-- 3. The new columns exist:
--      select column_name, is_nullable from information_schema.columns
--      where table_schema = 'public' and table_name = 'technician_partner_registrations' order by ordinal_position;

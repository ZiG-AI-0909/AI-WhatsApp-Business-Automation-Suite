-- =============================================================
-- Vendor KYC (Sudarshan Extrusions Pvt. Ltd. vendor onboarding)
--
-- One public "KYC Registration Form" for the company itself — NOT
-- per-tenant data, so there is no user_id column.
--
-- Access model (same as the rest of this app: the browser never talks to
-- these tables or the bucket directly):
--   * Vendors submit through POST /api/public/kyc (rate-limited,
--     validated). The backend writes with the service role.
--   * Staff read/review through /api/kyc/*, which requires a signed-in
--     user listed in private.kyc_staff (checked via public.is_kyc_staff).
--   * RLS is ON with NO policies for anon/authenticated, and the bucket is
--     private with NO storage policies: the anon key shipped in the
--     frontend can neither read nor write vendor PAN/bank data.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- =============================================================

create schema if not exists private;

-- ─── Staff allowlist ─────────────────────────────────────────
-- Add reviewers by hand:
--   insert into private.kyc_staff (user_id)
--   select id from auth.users where email = 'reviewer@sudarshanpipes.com';
create table if not exists private.kyc_staff (
    user_id  uuid primary key references auth.users(id) on delete cascade,
    added_at timestamptz not null default now()
);
alter table private.kyc_staff enable row level security;

create or replace function public.is_kyc_staff(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from private.kyc_staff where user_id = p_user_id);
$$;
revoke all on function public.is_kyc_staff(uuid) from public, anon, authenticated;
grant execute on function public.is_kyc_staff(uuid) to service_role;

-- ─── Submissions ─────────────────────────────────────────────
create table if not exists public.kyc_submissions (
    id            uuid primary key default gen_random_uuid(),
    submitted_at  timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    status        text not null default 'pending'
                  check (status in ('pending', 'verified', 'approved', 'rejected', 'info_required')),
    vendor_code   text unique,

    -- §1 Vendor / business details
    legal_name          text not null,
    business_type       text not null,
    trade_name          text,
    pan                 text not null check (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
    gstin               text not null check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
    udyam_number        text not null check (udyam_number ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$'),
    registered_address  text not null,
    registered_pin      text not null check (registered_pin ~ '^[1-9][0-9]{5}$'),
    factory_address     text,
    state               text not null,
    website             text,
    years_in_business   smallint not null check (years_in_business between 0 and 200),

    -- §2 Contact details
    contact_name         text not null,
    contact_designation  text not null,
    contact_mobile       text not null check (contact_mobile ~ '^[6-9][0-9]{9}$'),
    contact_email        text not null check (contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    alternate_contact    text,
    landline             text,

    -- §3 Vendor category & supply details. The public form's category →
    -- items picker, one entry per ticked category, in form order:
    --   [{ "category": "Raw Materials", "items": ["PVC Resin", "Titanium Dioxide"], "other_text": "" },
    --    { "category": "Packaging",     "items": ["Packing Bags / Sacks"],          "other_text": "" }]
    -- category: Raw Materials | Components & Fittings | Machinery & Spares |
    --           Packaging | Transport & Logistics | Contractor & Services | Other
    -- items come only from that category's list (backend/src/kyc/kycSchema.js);
    -- anything typed under "Other" is in other_text. The server validates the
    -- contents; the database only guarantees a non-empty array. No upper
    -- bound on purpose: adding a category later needs no constraint change
    -- (the server caps the count at the number of categories it knows).
    category_selections jsonb not null check (
                            jsonb_typeof(category_selections) = 'array'
                            and jsonb_array_length(category_selections) >= 1),
    products_offered    text,
    brands_specs        text,
    supply_capacity     text,
    delivery_lead_time  text,

    -- §4 Bank & payment details
    bank_account_holder  text not null,
    bank_name            text not null,
    bank_account_number  text not null check (bank_account_number ~ '^[0-9]{9,18}$'),
    bank_ifsc            text not null check (bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
    bank_branch          text not null,
    bank_account_type    text not null,
    payment_terms        text,
    currency             text not null default 'INR',

    -- §5 Document checklist. One entry per UPLOADED file (a missing optional
    -- document = "N/A"):
    --   { "<type>": { "path": "<id>/<type>.<ext>", "file_name": "...",
    --                 "mime_type": "...", "size": 12345 } }
    -- The signed & sealed declaration page is the "signed_declaration" entry.
    documents  jsonb not null check (
                   documents ?& array['pan_proof', 'gst_certificate', 'bank_proof',
                                      'udyam_certificate', 'signed_declaration']),

    -- §6 Vendor declaration (no signature/seal columns: the physically
    -- signed & sealed page is uploaded as documents.signed_declaration)
    authorized_person_name         text not null,
    authorized_person_designation  text not null,
    declaration_date               date not null,
    declaration_accepted           boolean not null check (declaration_accepted),
    submitter_ip                   text,
    submitter_user_agent           text,

    -- §5 "Verified by Company" column (staff): { "<type>": "yes" | "pending" }
    documents_verified  jsonb not null default '{}'::jsonb,

    -- §7 Internal verification & approval (staff only; never set by the public form)
    check_business_identity          text not null default 'pending' check (check_business_identity in ('verified', 'pending', 'na')),
    check_business_identity_remarks  text,
    check_pan_gst                    text not null default 'pending' check (check_pan_gst in ('verified', 'pending', 'na')),
    check_pan_gst_remarks            text,
    check_bank                       text not null default 'pending' check (check_bank in ('verified', 'pending', 'na')),
    check_bank_remarks               text,
    check_technical                  text not null default 'pending' check (check_technical in ('verified', 'pending', 'na')),
    check_technical_remarks          text,
    check_risk                       text not null default 'pending' check (check_risk in ('verified', 'pending', 'na')),
    check_risk_remarks               text,
    procurement_reviewer             text,
    procurement_reviewed_on          date,
    finance_reviewer                 text,
    finance_reviewed_on              date,
    final_approver                   text,
    final_approved_on                date,
    final_decision                   text check (final_decision in ('approved', 'rejected', 'info_required')),
    decision_remarks                 text,
    reviewed_by                      uuid references auth.users(id) on delete set null,
    reviewed_at                      timestamptz
);

create index if not exists kyc_submissions_submitted_idx on public.kyc_submissions (submitted_at desc);
create index if not exists kyc_submissions_status_submitted_idx on public.kyc_submissions (status, submitted_at desc);
-- "Which vendors supply PVC Resin?" →
--   where category_selections @> '[{"items": ["PVC Resin"]}]'
create index if not exists kyc_submissions_category_selections_idx on public.kyc_submissions using gin (category_selections jsonb_path_ops);

create or replace function public.kyc_submissions_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;
drop trigger if exists kyc_submissions_touch on public.kyc_submissions;
create trigger kyc_submissions_touch
    before update on public.kyc_submissions
    for each row execute function public.kyc_submissions_touch();

-- RLS on, no policies: anon/authenticated get nothing; the backend's
-- service role bypasses RLS. Revoke the default table grants as well.
alter table public.kyc_submissions enable row level security;
revoke all on public.kyc_submissions from anon, authenticated;

-- ─── Storage bucket ──────────────────────────────────────────
-- Private, 5 MB per file, PDF/JPG/PNG only. Objects: <submission id>/<type>.<ext>
-- No storage.objects policies are created for this bucket, so only the
-- service role can read or write it; staff get short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kyc-documents', 'kyc-documents', false, 5242880,
        array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

-- ─── Verify ──────────────────────────────────────────────────
-- 1. No policies on the table (expect 0 rows):
--      select policyname from pg_policies where schemaname = 'public' and tablename = 'kyc_submissions';
-- 2. No storage policy that would open this bucket. Any row here whose
--    qual (read/update/delete) or with_check (upload) does not restrict
--    bucket_id to some OTHER bucket — e.g. a blanket "authenticated can
--    read all" — would ALSO apply to kyc-documents. Review every row:
--      select policyname, cmd, roles, qual, with_check
--      from pg_policies where schemaname = 'storage' and tablename = 'objects'
--      order by cmd, policyname;
-- 3. Staff list:
--      select s.user_id, u.email from private.kyc_staff s join auth.users u on u.id = s.user_id;

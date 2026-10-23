-- =============================================================
-- Mechanic / technician registration — Staff Mode (who registered whom)
--
-- The public partner form has two modes:
--   * Mechanic / technician mode (default): the partner fills in the form
--     themselves → registration_source = 'self', no staff columns.
--   * Staff mode: a field staff member fills it in for the partner →
--     registration_source = 'staff' + the staff member's id, Staff ID and
--     name as they were at that moment.
--
-- Field staff are NOT app users, so they are kept in a roster
-- (public.technician_staff) that the KYC reviewers (private.kyc_staff)
-- manage on "Submitted forms". In Staff mode the form asks for the Staff
-- ID + PIN; the backend checks the PIN (scrypt hash, never stored in
-- clear) and locks a Staff ID for 15 minutes after 5 wrong PINs. A staff
-- member who is also signed in to the app on that browser is recognised
-- automatically when their roster entry is linked to their account
-- (auth_user_id).
--
-- Attribution is written once, when the registration is created: a
-- trigger refuses any later change to registration_source / staff_*, so
-- reviewing or editing a registration can never move it to another staff
-- member or count it twice. Counts are derived from the rows (nothing is
-- incremented), see backend/src/technician/technicianStaff.js.
--
-- Same access model as the rest of the form: RLS ON with NO policies,
-- everything goes through the backend's service role.
--
-- Requires supabase-technician-registration-migration.sql (and the vendor
-- KYC migration it builds on). Run in the Supabase SQL Editor. Safe to
-- re-run. Existing registrations are kept and become 'self'.
-- =============================================================

-- ─── Staff roster ────────────────────────────────────────────
create table if not exists public.technician_staff (
    id                uuid primary key default gen_random_uuid(),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    staff_code        text not null unique check (staff_code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),  -- the "Staff ID", upper case
    full_name         text not null check (char_length(full_name) between 2 and 120),
    phone             text check (phone is null or phone ~ '^[6-9][0-9]{9}$'),
    active            boolean not null default true,       -- inactive staff cannot register; their history stays
    pin_hash          text not null,                       -- scrypt$<salt>$<hash>
    pin_failed_count  integer not null default 0,
    pin_locked_until  timestamptz,
    -- Registration target (optional): target_count per day / week / month (India time).
    target_count      integer check (target_count is null or target_count between 1 and 100000),
    target_period     text not null default 'month' check (target_period in ('day', 'week', 'month')),
    -- Optional link to an app account: that person is recognised without a PIN when signed in.
    auth_user_id      uuid unique references auth.users(id) on delete set null,
    created_by        uuid references auth.users(id) on delete set null,
    created_by_email  text,
    updated_by_email  text
);

drop trigger if exists technician_staff_touch on public.technician_staff;
create trigger technician_staff_touch
    before update on public.technician_staff
    for each row execute function public.kyc_submissions_touch();

-- ─── Attribution on each registration ────────────────────────
alter table public.technician_partner_registrations
    add column if not exists registration_source text not null default 'self' check (registration_source in ('self', 'staff')),
    add column if not exists staff_id   uuid references public.technician_staff(id) on delete restrict,
    add column if not exists staff_code text,
    add column if not exists staff_name text;

-- Self = no staff columns; staff = all three.
alter table public.technician_partner_registrations drop constraint if exists technician_partner_registrations_attribution_check;
alter table public.technician_partner_registrations add constraint technician_partner_registrations_attribution_check check (
    (registration_source = 'self'  and staff_id is null and staff_code is null and staff_name is null)
 or (registration_source = 'staff' and staff_id is not null and staff_code is not null and staff_name is not null)
);

create index if not exists technician_partner_registrations_staff_idx on public.technician_partner_registrations (staff_id, submitted_at desc) where staff_id is not null;
create index if not exists technician_partner_registrations_source_idx on public.technician_partner_registrations (registration_source, submitted_at desc);
create index if not exists technician_partner_registrations_mobile_idx on public.technician_partner_registrations (mobile, submitted_at);

-- Attribution is set once, on insert.
create or replace function public.technician_registration_attribution_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.registration_source is distinct from old.registration_source
       or new.staff_id is distinct from old.staff_id
       or new.staff_code is distinct from old.staff_code
       or new.staff_name is distinct from old.staff_name then
        raise exception 'Registration attribution cannot be changed after the registration is created.'
            using errcode = 'check_violation';
    end if;
    return new;
end;
$$;
drop trigger if exists technician_partner_registrations_attribution_lock on public.technician_partner_registrations;
create trigger technician_partner_registrations_attribution_lock
    before update on public.technician_partner_registrations
    for each row execute function public.technician_registration_attribution_lock();

-- ─── Link a roster entry to an app account by email ──────────
-- Returns the linked auth user id, or NULL when no account has that email.
create or replace function public.technician_staff_link_account(p_staff_id uuid, p_email text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare uid uuid;
begin
    select u.id into uid from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1;
    if uid is null then return null; end if;
    update public.technician_staff set auth_user_id = uid where id = p_staff_id;
    return uid;
end;
$$;

-- Emails of the linked accounts, for the roster screen.
create or replace function public.technician_staff_account_emails()
returns table (staff_id uuid, email text)
language sql stable security definer set search_path = ''
as $$
    select s.id, u.email::text from public.technician_staff s join auth.users u on u.id = s.auth_user_id;
$$;

revoke all on function public.technician_staff_link_account(uuid, text) from public, anon, authenticated;
revoke all on function public.technician_staff_account_emails() from public, anon, authenticated;
grant execute on function public.technician_staff_link_account(uuid, text) to service_role;
grant execute on function public.technician_staff_account_emails() to service_role;

-- RLS on, no policies; no grants for the browser roles.
alter table public.technician_staff enable row level security;
revoke all on public.technician_staff from anon, authenticated;

-- ─── Verify ──────────────────────────────────────────────────
-- 1. Every existing registration is 'self':
--      select registration_source, count(*) from public.technician_partner_registrations group by 1;
-- 2. No policies (expect 0 rows):
--      select policyname from pg_policies where schemaname = 'public' and tablename = 'technician_staff';
-- 3. Attribution is locked (expect an error):
--      begin;
--      update public.technician_partner_registrations set staff_name = 'x'
--       where id = (select id from public.technician_partner_registrations limit 1);
--      rollback;

-- =============================================================
-- Staff & Member Login — personal registration links ("referrals")
--
-- Each staff member signs in at /staff-login (Staff ID + PIN, checked by
-- the backend; no Supabase Auth account) and shares a personal link to
-- the partner form: /technician-registration?ref=<Staff ID>. A partner who
-- registers through that link fills the form in themselves, so the row gets
-- a third source:
--   registration_source = 'self'      nobody referred the partner
--                       = 'referral'  partner used a staff member's link
--                       = 'staff'     a staff member filled in the form
-- 'referral' and 'staff' rows carry staff_id, staff_code and staff_name;
-- 'self' rows carry none. The backend resolves the staff member from the
-- code itself (active staff only) and never takes ids or names from the
-- browser. The attribution lock from supabase-technician-staff-migration.sql
-- still applies: the source and staff columns are written once, on insert.
--
-- No new index: technician_partner_registrations_staff_idx
-- (staff_id, submitted_at desc) from the staff migration already serves the
-- staff dashboard.
--
-- Requires supabase-technician-staff-migration.sql. Run in the Supabase SQL
-- Editor. Safe to re-run. Existing rows are not changed.
-- =============================================================

-- Drop the old two-value check on registration_source, whatever it is called.
do $$
declare c record;
begin
    for c in
        select con.conname
        from pg_constraint con
        where con.conrelid = 'public.technician_partner_registrations'::regclass
          and con.contype = 'c'
          and con.conname <> 'technician_partner_registrations_attribution_check'
          and pg_get_constraintdef(con.oid) like '%registration_source%'
    loop
        execute format('alter table public.technician_partner_registrations drop constraint %I', c.conname);
    end loop;
end;
$$;
alter table public.technician_partner_registrations
    add constraint technician_partner_registrations_registration_source_check
    check (registration_source in ('self', 'referral', 'staff'));

alter table public.technician_partner_registrations
    drop constraint if exists technician_partner_registrations_attribution_check;
alter table public.technician_partner_registrations
    add constraint technician_partner_registrations_attribution_check check (
        (registration_source = 'self' and staff_id is null and staff_code is null and staff_name is null)
     or (registration_source in ('referral', 'staff') and staff_id is not null and staff_code is not null and staff_name is not null)
    );

-- Safety net: the dashboard index from the staff migration (no-op when present).
create index if not exists technician_partner_registrations_staff_idx
    on public.technician_partner_registrations (staff_id, submitted_at desc) where staff_id is not null;

-- ─── Verify ──────────────────────────────────────────────────
-- 1. The source check allows the three values:
--      select pg_get_constraintdef(oid) from pg_constraint
--      where conname = 'technician_partner_registrations_registration_source_check';
-- 2. Counts per source:
--      select registration_source, count(*) from public.technician_partner_registrations group by 1;

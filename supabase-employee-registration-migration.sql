-- =============================================================
-- Employee self-registration (SEPL-{STATE}{NNN} Employee IDs)
--
-- Replaces adding staff by hand: a prospective employee opens the public
-- link /employee-registration, enters name, mobile, state of operation
-- (and optionally email), and gets an Employee ID + initial PIN.
--
-- Employees are rows of the existing roster public.technician_staff:
--   * staff_code  = the Employee ID, e.g. SEPL-TN001 (unique, never changes)
--   * pin_hash    = scrypt hash of the initial PIN (last 4 digits of the
--                   mobile); pin_must_change = true marks it temporary
--   * state / state_code = state of operation (may be edited later; the
--                   Employee ID keeps the state it was issued for)
--   * registration_source = 'self' (this form) or 'manual' (added by hand
--                   before this migration)
-- so a registered employee can use their Employee ID + PIN in the partner
-- form's Staff mode right away, and can later own leads, customers, dealers
-- and targets through technician_staff.id.
--
-- IDs come from public.employee_id_sequences: one counter per state,
-- incremented with a row lock inside public.register_employee(), which also
-- inserts the employee in the same transaction. Counters only go up, so an
-- ID is never reused, even after an employee is deactivated. A counter skips
-- any code already taken (e.g. a hand-made SEPL-TN004).
--
-- Same access model as the rest of the roster: RLS ON with NO policies;
-- everything goes through the backend's service role.
--
-- Requires supabase-technician-staff-migration.sql. Run in the Supabase SQL
-- Editor. Safe to re-run. Existing staff are kept and become 'manual'.
-- =============================================================

-- ─── Employee columns on the roster ──────────────────────────
alter table public.technician_staff
    add column if not exists registration_source  text not null default 'manual' check (registration_source in ('manual', 'self')),
    add column if not exists state                text,
    add column if not exists state_code           text check (state_code is null or state_code ~ '^[A-Z]{2}$'),
    add column if not exists email                text check (email is null or char_length(email) <= 254),
    add column if not exists pin_must_change      boolean not null default false,
    add column if not exists client_submission_id uuid unique;

-- One self-registration per mobile number (manual rows are not constrained,
-- so existing data can never make this migration fail; register_employee
-- also refuses a mobile that any roster row already has).
create unique index if not exists technician_staff_self_phone_key
    on public.technician_staff (phone) where registration_source = 'self';
create index if not exists technician_staff_state_idx on public.technician_staff (state_code);

-- ─── Per-state Employee ID counters ──────────────────────────
create table if not exists public.employee_id_sequences (
    state_code  text primary key check (state_code ~ '^[A-Z]{2}$'),
    last_value  integer not null default 0 check (last_value >= 0),
    updated_at  timestamptz not null default now()
);

-- Start each counter after any SEPL-XXnnn code already on the roster.
insert into public.employee_id_sequences (state_code, last_value)
select substring(staff_code from '^SEPL-([A-Z]{2})[0-9]+$'), max(substring(staff_code from '^SEPL-[A-Z]{2}([0-9]+)$')::integer)
from public.technician_staff
where staff_code ~ '^SEPL-[A-Z]{2}[0-9]+$'
group by 1
on conflict (state_code) do update
    set last_value = greatest(public.employee_id_sequences.last_value, excluded.last_value);

-- ─── Atomic registration ─────────────────────────────────────
-- Returns one row:
--   outcome 'created'   → new employee (id, staff_code, created_at)
--   outcome 'repeat'    → the same submission (client id) was already saved
--   outcome 'duplicate' → this mobile number is already on the roster
-- The backend validates every value and maps state → state_code first.
create or replace function public.register_employee(
    p_full_name text,
    p_phone     text,
    p_email     text,
    p_state     text,
    p_state_code text,
    p_pin_hash  text,
    p_client_id uuid
)
returns table (outcome text, id uuid, staff_code text, phone text, created_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
    seq   integer;
    code  text;
    row_  public.technician_staff%rowtype;
begin
    if p_state_code !~ '^[A-Z]{2}$' or p_phone !~ '^[6-9][0-9]{9}$' then
        raise exception 'Invalid employee registration.' using errcode = 'check_violation';
    end if;

    -- Serialise registrations of the same mobile number (and so the same
    -- submission) until this transaction ends.
    perform pg_advisory_xact_lock(hashtext('employee-registration:' || p_phone));

    if p_client_id is not null then
        select * into row_ from public.technician_staff s where s.client_submission_id = p_client_id;
        if found then
            return query select 'repeat'::text, row_.id, row_.staff_code, row_.phone, row_.created_at;
            return;
        end if;
    end if;

    if exists (select 1 from public.technician_staff s where s.phone = p_phone) then
        return query select 'duplicate'::text, null::uuid, null::text, null::text, null::timestamptz;
        return;
    end if;

    -- Next free number for the state. The upsert locks the counter row, so
    -- concurrent registrations for the same state queue here.
    loop
        insert into public.employee_id_sequences as q (state_code, last_value, updated_at)
        values (p_state_code, 1, now())
        on conflict (state_code) do update set last_value = q.last_value + 1, updated_at = now()
        returning q.last_value into seq;
        -- At least 3 digits; lpad() alone would truncate 1000 to '100'.
        code := 'SEPL-' || p_state_code || lpad(seq::text, greatest(3, length(seq::text)), '0');
        exit when not exists (select 1 from public.technician_staff s where s.staff_code = code);
    end loop;

    insert into public.technician_staff as s
        (staff_code, full_name, phone, email, state, state_code, pin_hash, pin_must_change, active, registration_source, client_submission_id)
    values
        (code, p_full_name, p_phone, nullif(p_email, ''), p_state, p_state_code, p_pin_hash, true, true, 'self', p_client_id)
    returning * into row_;

    return query select 'created'::text, row_.id, row_.staff_code, row_.phone, row_.created_at;
end;
$$;

revoke all on function public.register_employee(text, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.register_employee(text, text, text, text, text, text, uuid) to service_role;

-- RLS on, no policies; no grants for the browser roles.
alter table public.employee_id_sequences enable row level security;
revoke all on public.employee_id_sequences from anon, authenticated;

-- ─── Verify ──────────────────────────────────────────────────
-- 1. Existing staff kept, all 'manual':
--      select registration_source, count(*) from public.technician_staff group by 1;
-- 2. Counters (empty until the first registration, unless SEPL- codes existed):
--      select * from public.employee_id_sequences order by state_code;
-- 3. No policies (expect 0 rows):
--      select tablename, policyname from pg_policies where schemaname = 'public' and tablename = 'employee_id_sequences';

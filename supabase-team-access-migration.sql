-- =============================================================
-- Team & access — super admins give each registered account access to
-- parts of the app, by email, from the "Team & access" screen.
--
-- Areas (permissions): whatsapp, documents, proforma, ask_ai, vendor_kyc,
-- technicians, storage, settings. A super admin has every area and manages
-- the team. The first super admins come from the SUPER_ADMIN_EMAILS env var
-- on the server (they can never be demoted from the screen); super admins
-- can make other accounts super admin here.
--
-- Everyone works on ONE company workspace: the data of the account in
-- team_settings.company_owner_id (by default the first SUPER_ADMIN_EMAILS
-- account). WhatsApp linking and API keys stay with that owner account.
--
-- An account with no row here has NO access (a "waiting for access" page).
-- Nothing is enforced until this migration has run AND SUPER_ADMIN_EMAILS
-- is set on the server; until then the app behaves exactly as before.
--
-- Same access model as the rest of the app: RLS ON with NO policies; only
-- the backend's service role reads or writes these tables.
--
-- Run in the Supabase SQL Editor. Safe to re-run. No existing data changes.
-- =============================================================

create table if not exists public.team_members (
    user_id           uuid primary key references auth.users(id) on delete cascade,
    is_super_admin    boolean not null default false,
    permissions       text[] not null default '{}'
                      check (permissions <@ array['whatsapp', 'documents', 'proforma', 'ask_ai', 'vendor_kyc', 'technicians', 'storage', 'settings']::text[]),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    updated_by_email  text
);

-- One row: whose data the team works on.
create table if not exists public.team_settings (
    id                smallint primary key default 1 check (id = 1),
    company_owner_id  uuid references auth.users(id) on delete set null,
    updated_at        timestamptz not null default now(),
    updated_by_email  text
);
insert into public.team_settings (id) values (1) on conflict (id) do nothing;

-- Every registered account (for the Team & access screen).
create or replace function public.team_list_accounts()
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz)
language sql stable security definer set search_path = ''
as $$
    select u.id, u.email::text, u.created_at, u.last_sign_in_at
    from auth.users u
    where u.email is not null
    order by lower(u.email);
$$;

-- The account registered with an email (case-insensitive), or no row.
create or replace function public.team_find_account(p_email text)
returns table (user_id uuid, email text)
language sql stable security definer set search_path = ''
as $$
    select u.id, u.email::text from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1;
$$;

revoke all on function public.team_list_accounts() from public, anon, authenticated;
revoke all on function public.team_find_account(text) from public, anon, authenticated;
grant execute on function public.team_list_accounts() to service_role;
grant execute on function public.team_find_account(text) to service_role;

alter table public.team_members enable row level security;
alter table public.team_settings enable row level security;
revoke all on public.team_members, public.team_settings from anon, authenticated;

-- ─── Verify ──────────────────────────────────────────────────
-- 1. No policies (expect 0 rows):
--      select tablename, policyname from pg_policies where schemaname = 'public' and tablename in ('team_members', 'team_settings');
-- 2. Accounts the screen will list:
--      select * from public.team_list_accounts();

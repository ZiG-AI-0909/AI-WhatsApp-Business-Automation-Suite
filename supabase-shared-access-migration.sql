-- Shared data access ("workspaces").
--
-- The app never queries tables with the user's own Supabase session: every
-- request goes through the Express backend, which uses the service-role key
-- (RLS does not apply) and scopes each query to one user_id. RLS policies on
-- the data tables therefore cannot grant shared access inside the app.
--
-- This migration exposes the existing share list in private.user_data_shares
-- to the backend ONLY, through two SECURITY DEFINER functions that just the
-- service role may execute. The backend asks resolve_data_owner() on every
-- request that names another user's workspace and refuses the request unless
-- a share row authorises it. No user_id values are changed.
--
-- Idempotent. Does not modify or delete any data. Run it in the Supabase SQL
-- Editor after reviewing it.

create schema if not exists private;

-- Already present in this project; created only if missing.
create table if not exists private.user_data_shares (
    owner_user_id  uuid not null references auth.users(id) on delete cascade,
    shared_user_id uuid not null references auth.users(id) on delete cascade,
    created_at     timestamptz not null default now(),
    primary key (owner_user_id, shared_user_id),
    check (owner_user_id <> shared_user_id)
);

alter table private.user_data_shares enable row level security;

create index if not exists idx_user_data_shares_shared_user
    on private.user_data_shares(shared_user_id);

-- Returns the user_id whose data the request may act on, or NULL when the
-- authenticated user has no access to the requested owner's data.
create or replace function public.resolve_data_owner(
    p_auth_user_id uuid,
    p_requested_owner_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
    select case
        when p_auth_user_id is null then null
        when p_requested_owner_id is null or p_requested_owner_id = p_auth_user_id then p_auth_user_id
        when exists (
            select 1
            from private.user_data_shares s
            where s.owner_user_id = p_requested_owner_id
              and s.shared_user_id = p_auth_user_id
        ) then p_requested_owner_id
        else null
    end;
$$;

-- Workspaces shared with a user (for the workspace switcher).
create or replace function public.list_data_owners(p_auth_user_id uuid)
returns table(owner_user_id uuid, owner_email text, shared_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
    select s.owner_user_id, u.email::text, s.created_at
    from private.user_data_shares s
    join auth.users u on u.id = s.owner_user_id
    where s.shared_user_id = p_auth_user_id
    order by s.created_at, s.owner_user_id;
$$;

-- Least privilege: the browser roles must never call these (they take the
-- user id as a parameter, so anon/authenticated could probe other users).
revoke all on function public.resolve_data_owner(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_data_owners(uuid) from public, anon, authenticated;
grant execute on function public.resolve_data_owner(uuid, uuid) to service_role;
grant execute on function public.list_data_owners(uuid) to service_role;

notify pgrst, 'reload schema';

-- Verification (read-only), run after the migration:
--   select public.resolve_data_owner('860bbfc5-c97d-4c92-9b57-3318ab1b8cfc', 'e878e7d9-7c5a-4abc-a2bf-cd8c6b0b9e7b');
--     -> e878e7d9-7c5a-4abc-a2bf-cd8c6b0b9e7b   (User 2 may open User 1's data)
--   select public.resolve_data_owner('e878e7d9-7c5a-4abc-a2bf-cd8c6b0b9e7b', '860bbfc5-c97d-4c92-9b57-3318ab1b8cfc');
--     -> null                                    (sharing is one-way)
--   select * from public.list_data_owners('860bbfc5-c97d-4c92-9b57-3318ab1b8cfc');

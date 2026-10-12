-- Atomically increment a tenant-owned conversation's unread count.
-- Only the backend service role may execute this PostgREST-exposed function.
-- PostgreSQL cannot change a function's return type with CREATE OR REPLACE.
drop function if exists public.increment_unread(bigint, uuid);

create or replace function public.increment_unread(
    p_conversation_id bigint,
    p_user_id uuid
)
returns integer
language plpgsql
as $$
declare
    v_unread_count integer;
begin
    update public.conversations
    set unread_count = coalesce(unread_count, 0) + 1
    where id = p_conversation_id
      and user_id = p_user_id
    returning unread_count into v_unread_count;

    return v_unread_count;
end;
$$;

revoke execute on function public.increment_unread(bigint, uuid) from public, anon, authenticated;
grant execute on function public.increment_unread(bigint, uuid) to service_role;

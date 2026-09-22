-- =============================================================
-- Analytics dashboard aggregation (2026-09 performance fix).
--
-- GET /api/analytics/dashboard used to issue 14 PostgREST calls per
-- request (11 exact counts + 3 selects) and the Dashboard view polls it
-- every 10s. Exact counts scan the user's rows — on a large `messages`
-- table that made the endpoint exceed the client's 30s budget and the
-- dashboard showed "Request timed out after 30s".
--
-- PostgREST on this Supabase project rejects aggregate functions in
-- SELECT queries (PGRST123), but a Postgres FUNCTION runs the SQL
-- inside the database, so ONE rpc call computes every metric here.
-- The route now makes 1 rpc + 2 selects (Promise.all) per poll.
--
-- Run this file in the Supabase SQL editor (same flow as the other
-- supabase-*.sql migrations). The backend falls back to the old
-- per-query path until this function exists, so deploying the code
-- first is safe.
-- =============================================================

create or replace function public.get_dashboard_metrics(p_user_id uuid)
returns json
language sql
stable
as $$
select json_build_object(
    -- contacts
    'total_contacts',          (select count(*) from public.contacts where user_id = p_user_id),
    'opted_out',               (select count(*) from public.contacts where user_id = p_user_id and marketing_opt_in = 0),
    -- conversations
    'total_conversations',     (select count(*) from public.conversations where user_id = p_user_id),
    'conversations_open',      (select count(*) from public.conversations where user_id = p_user_id and status = 'open'),
    'conversations_takeover',  (select count(*) from public.conversations where user_id = p_user_id and status = 'human_takeover'),
    'conversations_resolved',  (select count(*) from public.conversations where user_id = p_user_id and status = 'resolved'),
    -- messages
    'total_messages',          (select count(*) from public.messages where user_id = p_user_id),
    'messages_inbound',        (select count(*) from public.messages where user_id = p_user_id and direction = 'inbound'),
    'messages_outbound',       (select count(*) from public.messages where user_id = p_user_id and direction = 'outbound'),
    -- campaigns
    'total_campaigns',         (select count(*) from public.campaigns where user_id = p_user_id),
    'campaigns_running',       (select count(*) from public.campaigns where user_id = p_user_id and status = 'running'),
    'campaigns_sent',          (select coalesce(sum(sent), 0) from public.campaigns where user_id = p_user_id),
    'campaigns_failed',        (select coalesce(sum(failed), 0) from public.campaigns where user_id = p_user_id),
    'campaigns_replies',       (select coalesce(sum(replies), 0) from public.campaigns where user_id = p_user_id),
    'campaigns_opt_outs',      (select coalesce(sum(opt_outs), 0) from public.campaigns where user_id = p_user_id)
);
$$;

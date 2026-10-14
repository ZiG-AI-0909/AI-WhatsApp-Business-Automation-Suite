-- Campaign pause/error state used for recoverable WhatsApp disconnections.
-- Idempotent: safe to run more than once.

alter table public.campaigns
    add column if not exists pause_reason text null,
    add column if not exists last_error text null,
    add column if not exists media_bucket text null,
    add column if not exists media_object_path text null,
    add column if not exists queue_position integer null,
    add column if not exists queued_at timestamptz null,
    add column if not exists source_campaign_id bigint null;

alter table public.campaign_contacts
    add column if not exists contact_data jsonb null;

alter table public.campaign_schedules
    add column if not exists media_bucket text null,
    add column if not exists media_object_path text null;

create index if not exists idx_campaigns_disconnected_paused
    on public.campaigns(user_id, id)
    where status = 'paused' and pause_reason = 'whatsapp_disconnected';
create index if not exists idx_campaigns_user_status_queue_position
    on public.campaigns(user_id, status, queue_position);

comment on column public.campaigns.pause_reason is
    'Reason a campaign was paused, including recoverable WhatsApp connection loss';
comment on column public.campaigns.last_error is
    'Most recent concise campaign-level error';
comment on column public.campaigns.media_bucket is
    'Supabase Storage bucket containing the campaign attachment';
comment on column public.campaigns.media_object_path is
    'Supabase Storage object path for the campaign attachment';
comment on column public.campaigns.queue_position is
    'One-based order of a campaign in its owner’s queue; null when not queued';
comment on column public.campaigns.queued_at is
    'Time the campaign was added to its owner’s queue';
comment on column public.campaigns.source_campaign_id is
    'Campaign this editable draft was duplicated from';
comment on column public.campaign_contacts.contact_data is
    'Sanitized source-row fields for re-rendering duplicated campaign messages';

create or replace function public.enqueue_campaign(
    p_campaign_id bigint,
    p_user_id uuid
)
returns setof public.campaigns
language plpgsql
set search_path = public
as $$
declare
    next_position integer;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
    if not exists (
        select 1 from public.campaigns
        where id = p_campaign_id and user_id = p_user_id
          and status in ('draft', 'stopped')
    ) then
        raise exception 'Campaign is not available to queue';
    end if;

    select coalesce(max(queue_position), 0) + 1 into next_position
    from public.campaigns
    where user_id = p_user_id and status = 'queued';

    return query
    update public.campaigns
    set status = 'queued', queue_position = next_position, queued_at = now(),
        pause_reason = null, last_error = null, completed_at = null, updated_at = now()
    where id = p_campaign_id and user_id = p_user_id
    returning *;
end;
$$;

create or replace function public.unqueue_campaign(
    p_campaign_id bigint,
    p_user_id uuid
)
returns setof public.campaigns
language plpgsql
set search_path = public
as $$
begin
    perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
    return query
    update public.campaigns
    set status = 'draft', queue_position = null, queued_at = null, updated_at = now()
    where id = p_campaign_id and user_id = p_user_id and status = 'queued'
    returning *;

    with ordered as (
        select id, row_number() over (order by queue_position, queued_at, id)::integer as position
        from public.campaigns
        where user_id = p_user_id and status = 'queued'
    )
    update public.campaigns c
    set queue_position = ordered.position
    from ordered
    where c.id = ordered.id and c.user_id = p_user_id;
end;
$$;

create or replace function public.reorder_campaign_queue(
    p_user_id uuid,
    p_ordered_ids bigint[]
)
returns setof public.campaigns
language plpgsql
set search_path = public
as $$
declare
    queued_count integer;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
    select count(*) into queued_count
    from public.campaigns
    where user_id = p_user_id and status = 'queued';

    if coalesce(array_length(p_ordered_ids, 1), 0) <> queued_count
       or (select count(distinct id) from unnest(p_ordered_ids) as requested(id)) <> queued_count
       or exists (
            select 1 from unnest(p_ordered_ids) as requested(id)
            left join public.campaigns c on c.id = requested.id
                and c.user_id = p_user_id and c.status = 'queued'
            where c.id is null
       ) then
        raise exception 'Ordered ids must contain every queued campaign owned by this user exactly once';
    end if;

    update public.campaigns c
    set queue_position = requested.position::integer, updated_at = now()
    from unnest(p_ordered_ids) with ordinality as requested(id, position)
    where c.id = requested.id and c.user_id = p_user_id and c.status = 'queued';

    return query
    select * from public.campaigns
    where user_id = p_user_id and status = 'queued'
    order by queue_position;
end;
$$;

create or replace function public.claim_campaign_to_run(
    p_user_id uuid,
    p_campaign_id bigint default null,
    p_expected_status text default null
)
returns setof public.campaigns
language plpgsql
set search_path = public
as $$
declare
    candidate_id bigint;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
    if exists (
        select 1 from public.campaigns
        where user_id = p_user_id and status = 'running'
    ) then
        return;
    end if;

    if p_campaign_id is null then
        select id into candidate_id
        from public.campaigns
        where user_id = p_user_id and status = 'queued'
        order by queue_position, queued_at, id
        limit 1
        for update;
    else
        select id into candidate_id
        from public.campaigns
        where id = p_campaign_id and user_id = p_user_id
          and status in ('draft', 'stopped', 'paused', 'queued')
          and (p_expected_status is null or status = p_expected_status)
          and (
              p_expected_status is distinct from 'queued'
              or id = (
                  select q.id from public.campaigns q
                  where q.user_id = p_user_id and q.status = 'queued'
                  order by q.queue_position, q.queued_at, q.id
                  limit 1
              )
          )
        for update;
    end if;

    if candidate_id is null then
        return;
    end if;

    return query
    update public.campaigns
    set status = 'running',
        queue_position = null,
        queued_at = null,
        started_at = coalesce(started_at, now()),
        pause_reason = null,
        last_error = null,
        completed_at = null,
        updated_at = now()
    where id = candidate_id and user_id = p_user_id
      and status in ('draft', 'stopped', 'paused', 'queued')
    returning *;

    with ordered as (
        select id, row_number() over (order by queue_position, queued_at, id)::integer as position
        from public.campaigns
        where user_id = p_user_id and status = 'queued'
    )
    update public.campaigns c
    set queue_position = ordered.position
    from ordered
    where c.id = ordered.id and c.user_id = p_user_id;
end;
$$;

revoke all on function public.enqueue_campaign(bigint, uuid) from public, anon, authenticated;
revoke all on function public.unqueue_campaign(bigint, uuid) from public, anon, authenticated;
revoke all on function public.reorder_campaign_queue(uuid, bigint[]) from public, anon, authenticated;
revoke all on function public.claim_campaign_to_run(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.enqueue_campaign(bigint, uuid) to service_role;
grant execute on function public.unqueue_campaign(bigint, uuid) to service_role;
grant execute on function public.reorder_campaign_queue(uuid, bigint[]) to service_role;
grant execute on function public.claim_campaign_to_run(uuid, bigint, text) to service_role;

create index if not exists idx_campaign_contacts_user_status_sent_at
    on public.campaign_contacts(user_id, status, sent_at);

create or replace function public.recount_campaign_counters(
    p_campaign_id bigint,
    p_user_id uuid
)
returns table(processed bigint, sent bigint, failed bigint, opt_outs bigint, skipped bigint)
language plpgsql
set search_path = public
as $$
begin
    return query
    update public.campaigns as c
    set
        sent = totals.sent,
        failed = totals.failed,
        opt_outs = totals.opt_outs,
        skipped = totals.skipped,
        processed = totals.sent + totals.failed + totals.opt_outs + totals.skipped,
        updated_at = now()
    from (
        select
            count(*) filter (where cc.status = 'sent')::bigint as sent,
            count(*) filter (where cc.status = 'failed')::bigint as failed,
            count(*) filter (where cc.status = 'opted_out')::bigint as opt_outs,
            count(*) filter (where cc.status = 'skipped')::bigint as skipped
        from public.campaign_contacts as cc
        where cc.campaign_id = p_campaign_id
          and cc.user_id = p_user_id
    ) as totals
    where c.id = p_campaign_id
      and c.user_id = p_user_id
    returning c.processed, c.sent, c.failed, c.opt_outs, c.skipped;
end;
$$;

revoke all on function public.recount_campaign_counters(bigint, uuid) from public, anon, authenticated;
grant execute on function public.recount_campaign_counters(bigint, uuid) to service_role;

notify pgrst, 'reload schema';

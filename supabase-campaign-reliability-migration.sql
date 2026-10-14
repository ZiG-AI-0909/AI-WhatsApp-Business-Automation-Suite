-- Campaign pause/error state used for recoverable WhatsApp disconnections.
-- Idempotent: safe to run more than once.

alter table public.campaigns
    add column if not exists pause_reason text null,
    add column if not exists last_error text null,
    add column if not exists media_bucket text null,
    add column if not exists media_object_path text null;

alter table public.campaign_schedules
    add column if not exists media_bucket text null,
    add column if not exists media_object_path text null;

create index if not exists idx_campaigns_disconnected_paused
    on public.campaigns(user_id, id)
    where status = 'paused' and pause_reason = 'whatsapp_disconnected';

comment on column public.campaigns.pause_reason is
    'Reason a campaign was paused, including recoverable WhatsApp connection loss';
comment on column public.campaigns.last_error is
    'Most recent concise campaign-level error';
comment on column public.campaigns.media_bucket is
    'Supabase Storage bucket containing the campaign attachment';
comment on column public.campaigns.media_object_path is
    'Supabase Storage object path for the campaign attachment';

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

-- Campaign delivery tracking, consent records and rate-limit cooldowns.
-- Run after supabase-campaign-reliability-migration.sql.
-- Idempotent: safe to run more than once. No data is dropped.
--
-- The backend works without this migration (it logs that it is pending),
-- but delivered/read counts, opt-out records and enforced rate-limit
-- cooldowns are only stored once it has been applied.

-- Delivery receipts per recipient (WhatsApp webhook / WhatsApp Web acks).
alter table public.campaign_contacts
    add column if not exists delivery_status text null,
    add column if not exists delivered_at timestamptz null,
    add column if not exists read_at timestamptz null,
    add column if not exists error_code text null;

comment on column public.campaign_contacts.delivery_status is
    'Latest receipt from WhatsApp: sent, delivered, read or failed';
comment on column public.campaign_contacts.error_code is
    'Provider error code of the last failure (for example 131047)';

-- Campaign-level receipt counters and the earliest safe resume time.
alter table public.campaigns
    add column if not exists delivered bigint not null default 0,
    add column if not exists read_count bigint not null default 0,
    add column if not exists resume_after timestamptz null;

comment on column public.campaigns.resume_after is
    'Set when WhatsApp rate-limited the campaign; resume is refused before this time';

-- Consent records. marketing_opt_in stays the switch the queue checks;
-- these columns record when and how it changed.
alter table public.contacts
    add column if not exists opted_out_at timestamptz null,
    add column if not exists opt_out_source text null,
    add column if not exists opted_in_at timestamptz null,
    add column if not exists opt_in_source text null;

comment on column public.contacts.opted_out_at is
    'When the contact opted out (STOP reply, manual opt-out or WhatsApp marketing opt-out)';
comment on column public.contacts.opt_out_source is
    'reply, manual or whatsapp (error 131050)';

create index if not exists idx_campaign_contacts_campaign_delivery
    on public.campaign_contacts(campaign_id, delivery_status);
create index if not exists idx_campaign_contacts_user_provider_message
    on public.campaign_contacts(user_id, provider_message_id)
    where provider_message_id is not null;

create or replace function public.recount_campaign_delivery(
    p_campaign_id bigint,
    p_user_id uuid
)
returns table(delivered bigint, read_count bigint)
language plpgsql
set search_path = public
as $$
begin
    return query
    update public.campaigns as c
    set delivered = totals.delivered,
        read_count = totals.read_count,
        updated_at = now()
    from (
        select
            count(*) filter (where cc.delivery_status in ('delivered', 'read'))::bigint as delivered,
            count(*) filter (where cc.delivery_status = 'read')::bigint as read_count
        from public.campaign_contacts as cc
        where cc.campaign_id = p_campaign_id
          and cc.user_id = p_user_id
    ) as totals
    where c.id = p_campaign_id
      and c.user_id = p_user_id
    returning c.delivered, c.read_count;
end;
$$;

revoke all on function public.recount_campaign_delivery(bigint, uuid) from public, anon, authenticated;
grant execute on function public.recount_campaign_delivery(bigint, uuid) to service_role;

notify pgrst, 'reload schema';

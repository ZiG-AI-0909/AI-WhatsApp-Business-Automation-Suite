-- Campaign pause/error state used for recoverable WhatsApp disconnections.
-- Idempotent: safe to run more than once.

alter table public.campaigns
    add column if not exists pause_reason text null,
    add column if not exists last_error text null;

create index if not exists idx_campaigns_disconnected_paused
    on public.campaigns(user_id, id)
    where status = 'paused' and pause_reason = 'whatsapp_disconnected';

comment on column public.campaigns.pause_reason is
    'Reason a campaign was paused, including recoverable WhatsApp connection loss';
comment on column public.campaigns.last_error is
    'Most recent concise campaign-level error';

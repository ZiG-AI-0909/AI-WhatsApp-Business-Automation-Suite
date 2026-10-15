-- =============================================================
-- BOQ -> Quotation (supply-only pipe quotations from a confirmed BOQ).
-- Run this in: Supabase Dashboard -> SQL Editor -> New Query
-- AFTER supabase-boq-migration.sql (needs public.boq_documents and
-- public.set_updated_at() from supabase-data-migration.sql).
--
-- Idempotent: safe to rerun. Also upgrades the tables created by the
-- earlier price-list draft of this file in place; no data is dropped
-- (legacy columns and the price_list_items table are left untouched).
-- =============================================================

-- ─── quotations ──────────────────────────────────────────────
create table if not exists public.quotations (
    id                  bigserial primary key,
    user_id             uuid not null references auth.users(id) on delete cascade,
    boq_document_id     bigint references public.boq_documents(id) on delete set null,
    source_quotation_id bigint references public.quotations(id) on delete set null,
    version             integer not null default 1,
    quote_number        text,
    quote_date          date not null default ((now() at time zone 'Asia/Kolkata')::date),
    validity_days       integer not null default 30,
    customer_name       text not null default '',
    customer_address    text not null default '',
    customer_gstin      text not null default '',
    project_name        text not null default '',
    reference_text      text not null default '',
    supply_type         text not null default 'intra',
    gst_percent         numeric(5,2) not null default 18,
    discount_percent    numeric(5,2) not null default 0,
    freight             numeric(14,2) not null default 0,
    status              text not null default 'draft',
    terms               jsonb not null default '[]'::jsonb,
    company             jsonb not null default '{}'::jsonb,
    integrity           jsonb not null default '{}'::jsonb,
    subtotal            numeric(16,2) not null default 0,
    grand_total         numeric(16,2) not null default 0,
    unpriced_lines      integer not null default 0,
    finalized_at        timestamptz,
    sent_at             timestamptz,
    sent_to             text,
    send_claimed_at     timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

alter table public.quotations add column if not exists source_quotation_id bigint references public.quotations(id) on delete set null;
alter table public.quotations add column if not exists version integer not null default 1;
alter table public.quotations add column if not exists quote_number text;
alter table public.quotations add column if not exists quote_date date not null default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.quotations add column if not exists validity_days integer not null default 30;
alter table public.quotations add column if not exists customer_name text not null default '';
alter table public.quotations add column if not exists customer_address text not null default '';
alter table public.quotations add column if not exists customer_gstin text not null default '';
alter table public.quotations add column if not exists project_name text not null default '';
alter table public.quotations add column if not exists reference_text text not null default '';
alter table public.quotations add column if not exists supply_type text not null default 'intra';
alter table public.quotations add column if not exists gst_percent numeric(5,2) not null default 18;
alter table public.quotations add column if not exists discount_percent numeric(5,2) not null default 0;
alter table public.quotations add column if not exists freight numeric(14,2) not null default 0;
alter table public.quotations add column if not exists status text not null default 'draft';
alter table public.quotations add column if not exists terms jsonb not null default '[]'::jsonb;
alter table public.quotations add column if not exists company jsonb not null default '{}'::jsonb;
alter table public.quotations add column if not exists integrity jsonb not null default '{}'::jsonb;
alter table public.quotations add column if not exists subtotal numeric(16,2) not null default 0;
alter table public.quotations add column if not exists grand_total numeric(16,2) not null default 0;
alter table public.quotations add column if not exists unpriced_lines integer not null default 0;
alter table public.quotations add column if not exists finalized_at timestamptz;
alter table public.quotations add column if not exists sent_at timestamptz;
alter table public.quotations add column if not exists sent_to text;
alter table public.quotations add column if not exists send_claimed_at timestamptz;
alter table public.quotations add column if not exists created_at timestamptz not null default now();
alter table public.quotations add column if not exists updated_at timestamptz not null default now();

-- The number is assigned on finalize only, so drafts have none.
alter table public.quotations alter column quote_number drop not null;

alter table public.quotations drop constraint if exists quotations_status_check;
-- accepted/rejected/expired are kept valid only for rows from the earlier draft.
alter table public.quotations add constraint quotations_status_check
    check (status in ('draft', 'final', 'sent', 'accepted', 'rejected', 'expired'));
alter table public.quotations drop constraint if exists quotations_supply_type_check;
alter table public.quotations add constraint quotations_supply_type_check
    check (supply_type in ('intra', 'inter'));
alter table public.quotations drop constraint if exists quotations_gst_percent_check;
alter table public.quotations add constraint quotations_gst_percent_check
    check (gst_percent between 0 and 100);
alter table public.quotations drop constraint if exists quotations_discount_percent_check;
alter table public.quotations add constraint quotations_discount_percent_check
    check (discount_percent between 0 and 100);
alter table public.quotations drop constraint if exists quotations_freight_check;
alter table public.quotations add constraint quotations_freight_check
    check (freight >= 0);
alter table public.quotations drop constraint if exists quotations_validity_days_check;
alter table public.quotations add constraint quotations_validity_days_check
    check (validity_days between 1 and 3650);
alter table public.quotations drop constraint if exists quotations_version_check;
alter table public.quotations add constraint quotations_version_check
    check (version > 0);

-- One version number per BOQ per user. Rows from the earlier draft all
-- have version 1, so number them by creation order first (runs only
-- before the index exists, so later reruns never renumber).
with ranked as (
    select id, row_number() over (partition by user_id, boq_document_id order by created_at, id) as rn
    from public.quotations
    where boq_document_id is not null
)
update public.quotations q
   set version = ranked.rn
  from ranked
 where q.id = ranked.id
   and q.version is distinct from ranked.rn
   and not exists (
       select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'idx_quotations_user_boq_version'
   );

create unique index if not exists idx_quotations_user_boq_version
    on public.quotations(user_id, boq_document_id, version)
    where boq_document_id is not null;
create unique index if not exists idx_quotations_user_quote_number
    on public.quotations(user_id, quote_number)
    where quote_number is not null;
create index if not exists idx_quotations_user_created
    on public.quotations(user_id, created_at desc);
create index if not exists idx_quotations_user_status
    on public.quotations(user_id, status);

comment on table public.quotations is 'Supply-only quotations built from a confirmed BOQ, per tenant (user_id). quote_number is assigned on finalize.';

-- ─── quotation_items ─────────────────────────────────────────
create table if not exists public.quotation_items (
    id              bigserial primary key,
    quotation_id    bigint not null references public.quotations(id) on delete cascade,
    user_id         uuid not null references auth.users(id) on delete cascade,
    line_no         integer not null,
    section         text not null default 'B',
    boq_item_no     text not null default '',
    boq_item_code   text not null default '',
    description     text not null default '',
    boq_description text not null default '',
    size_mm         numeric(10,2),
    unit            text not null default '',
    qty             numeric(16,2),
    rate            numeric(14,2),
    hsn             text not null default '',
    remarks         text not null default '',
    ref_rate        numeric(16,2),
    ref_amount      numeric(18,2),
    include         boolean not null default false,
    spec            jsonb not null default '{}'::jsonb,
    flags           jsonb not null default '[]'::jsonb,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (quotation_id, line_no)
);

alter table public.quotation_items add column if not exists section text not null default 'B';
alter table public.quotation_items add column if not exists boq_item_no text not null default '';
alter table public.quotation_items add column if not exists boq_item_code text not null default '';
alter table public.quotation_items add column if not exists description text not null default '';
alter table public.quotation_items add column if not exists boq_description text not null default '';
alter table public.quotation_items add column if not exists size_mm numeric(10,2);
alter table public.quotation_items add column if not exists unit text not null default '';
alter table public.quotation_items add column if not exists qty numeric(16,2);
alter table public.quotation_items add column if not exists rate numeric(14,2);
alter table public.quotation_items add column if not exists hsn text not null default '';
alter table public.quotation_items add column if not exists remarks text not null default '';
alter table public.quotation_items add column if not exists ref_rate numeric(16,2);
alter table public.quotation_items add column if not exists ref_amount numeric(18,2);
alter table public.quotation_items add column if not exists include boolean not null default false;
alter table public.quotation_items add column if not exists spec jsonb not null default '{}'::jsonb;
alter table public.quotation_items add column if not exists flags jsonb not null default '[]'::jsonb;
alter table public.quotation_items add column if not exists created_at timestamptz not null default now();
alter table public.quotation_items add column if not exists updated_at timestamptz not null default now();

alter table public.quotation_items drop constraint if exists quotation_items_section_check;
alter table public.quotation_items add constraint quotation_items_section_check
    check (section in ('A', 'B'));
alter table public.quotation_items drop constraint if exists quotation_items_rate_check;
alter table public.quotation_items add constraint quotation_items_rate_check
    check (rate is null or rate >= 0);
alter table public.quotation_items drop constraint if exists quotation_items_qty_check;
alter table public.quotation_items add constraint quotation_items_qty_check
    check (qty is null or qty > 0);

create index if not exists idx_quotation_items_user_quote
    on public.quotation_items(user_id, quotation_id);

comment on column public.quotation_items.rate is 'Our supply rate, typed by a human. NULL until typed; never copied from the BOQ.';
comment on column public.quotation_items.ref_rate is 'Customer BOQ contract rate (installed rate). Reference only.';

-- ─── per-user, per-financial-year counter ────────────────────
create table if not exists public.quotation_counters (
    user_id     uuid not null references auth.users(id) on delete cascade,
    fiscal_year text not null,
    last_number integer not null default 0,
    primary key (user_id, fiscal_year)
);

-- ─── RLS (same safety net as boq_documents; the backend uses the
-- service role and scopes every query by user_id) ─────────────
alter table public.quotations enable row level security;
alter table public.quotation_items enable row level security;
alter table public.quotation_counters enable row level security;

drop policy if exists "Tenant isolation for quotations" on public.quotations;
create policy "Tenant isolation for quotations" on public.quotations
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "Tenant isolation for quotation_items" on public.quotation_items;
create policy "Tenant isolation for quotation_items" on public.quotation_items
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "Tenant isolation for quotation_counters" on public.quotation_counters;
create policy "Tenant isolation for quotation_counters" on public.quotation_counters
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop trigger if exists set_quotations_updated_at on public.quotations;
create trigger set_quotations_updated_at
    before update on public.quotations
    for each row execute procedure public.set_updated_at();
drop trigger if exists set_quotation_items_updated_at on public.quotation_items;
create trigger set_quotation_items_updated_at
    before update on public.quotation_items
    for each row execute procedure public.set_updated_at();

-- ─── finalize: atomic sequential number SP/2026-27/0001 ──────
-- Locks the quotation row, re-checks that every included line is priced,
-- takes the next number from the per-user per-financial-year counter
-- (April to March, by the quotation date in IST) and marks it final, all in
-- one transaction, so two finalizes can never share or skip a number.
create or replace function public.finalize_quotation(p_user_id uuid, p_quotation_id bigint)
returns public.quotations
language plpgsql
security definer
set search_path = public
as $$
declare
    v_quote public.quotations;
    v_day date;
    v_start_year integer;
    v_fiscal_year text;
    v_next integer;
begin
    select * into v_quote
      from public.quotations
     where id = p_quotation_id and user_id = p_user_id
     for update;
    if not found then
        raise exception 'quotation_not_found' using errcode = 'P0002';
    end if;
    if v_quote.status <> 'draft' then
        raise exception 'quotation_not_draft' using errcode = 'P0001';
    end if;
    if not exists (
        select 1 from public.quotation_items
         where quotation_id = v_quote.id and user_id = p_user_id and include
    ) then
        raise exception 'quotation_no_lines' using errcode = 'P0001';
    end if;
    if exists (
        select 1 from public.quotation_items
         where quotation_id = v_quote.id and user_id = p_user_id and include
           and (rate is null or rate <= 0 or qty is null or qty <= 0)
    ) then
        raise exception 'quotation_unpriced_lines' using errcode = 'P0001';
    end if;

    v_day := coalesce(v_quote.quote_date, (now() at time zone 'Asia/Kolkata')::date);
    v_start_year := case when extract(month from v_day) >= 4
                         then extract(year from v_day)::integer
                         else extract(year from v_day)::integer - 1 end;
    v_fiscal_year := v_start_year::text || '-' || lpad(((v_start_year + 1) % 100)::text, 2, '0');

    insert into public.quotation_counters as counter (user_id, fiscal_year, last_number)
    values (p_user_id, v_fiscal_year, 1)
    on conflict (user_id, fiscal_year)
    do update set last_number = counter.last_number + 1
    returning counter.last_number into v_next;

    update public.quotations
       set quote_number = 'SP/' || v_fiscal_year || '/'
                          || case when v_next < 10000 then lpad(v_next::text, 4, '0') else v_next::text end,
           status = 'final',
           quote_date = v_day,
           finalized_at = now(),
           updated_at = now()
     where id = v_quote.id
     returning * into v_quote;
    return v_quote;
end;
$$;
revoke all on function public.finalize_quotation(uuid, bigint) from public, anon, authenticated;
grant execute on function public.finalize_quotation(uuid, bigint) to service_role;

-- Used by the backend's startup migration guard.
create or replace function public.quotation_migration_ready()
returns boolean
language sql
security definer
set search_path = public
as $$
    select to_regclass('public.quotations') is not null
       and to_regclass('public.quotation_items') is not null
       and to_regclass('public.quotation_counters') is not null
       and to_regprocedure('public.finalize_quotation(uuid,bigint)') is not null;
$$;
revoke all on function public.quotation_migration_ready() from public, anon, authenticated;
grant execute on function public.quotation_migration_ready() to service_role;

notify pgrst, 'reload schema';

-- BOQ to quotation support. Run after supabase-boq-migration.sql.
-- Idempotent: safe to rerun before or after deploying quotation code.

create table if not exists public.price_list_items (
    id bigserial primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    item_code text not null,
    name text not null,
    category text,
    size text,
    pressure_class text,
    specification text,
    unit text not null,
    rate numeric(14,2) not null check (rate > 0),
    hsn_code text,
    gst_percent numeric(5,2) not null default 18 check (gst_percent between 0 and 100),
    active boolean not null default true,
    updated_at timestamptz not null default now(),
    unique (user_id, item_code)
);

create index if not exists idx_price_list_items_user_item_code
    on public.price_list_items(user_id, item_code);
create index if not exists idx_price_list_items_user_active
    on public.price_list_items(user_id, active);

create table if not exists public.quotations (
    id bigserial primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    boq_document_id bigint references public.boq_documents(id) on delete set null,
    quote_number text not null,
    customer_name text,
    customer_phone text,
    customer_address text,
    customer_state text,
    customer_gstin text,
    project_name text,
    status text not null default 'draft'
        check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired')),
    validity_days integer not null default 30 check (validity_days > 0),
    payment_terms text,
    delivery_terms text,
    freight numeric(14,2) not null default 0 check (freight >= 0),
    discount_percent numeric(5,2) not null default 0 check (discount_percent between 0 and 100),
    notes text,
    subtotal numeric(16,2) not null default 0,
    tax_total numeric(16,2) not null default 0,
    grand_total numeric(16,2) not null default 0,
    sent_at timestamptz,
    send_claimed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, quote_number)
);
alter table public.quotations add column if not exists send_claimed_at timestamptz;
create index if not exists idx_quotations_user_created
    on public.quotations(user_id, created_at desc);
create index if not exists idx_quotations_user_status
    on public.quotations(user_id, status);

create table if not exists public.quotation_items (
    id bigserial primary key,
    quotation_id bigint not null references public.quotations(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    line_no integer not null,
    boq_item_ref jsonb not null default '{}'::jsonb,
    price_list_item_id bigint references public.price_list_items(id) on delete set null,
    description text not null default '',
    size text,
    unit text,
    quantity numeric(16,3) not null default 0 check (quantity >= 0),
    rate numeric(14,2),
    discount_percent numeric(5,2) not null default 0 check (discount_percent between 0 and 100),
    gst_percent numeric(5,2) not null default 0 check (gst_percent between 0 and 100),
    hsn_code text,
    amount numeric(16,2) not null default 0,
    match_status text not null default 'unmatched'
        check (match_status in ('matched', 'manual', 'unmatched')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (quotation_id, line_no)
);
create index if not exists idx_quotation_items_user_quote
    on public.quotation_items(user_id, quotation_id);

create table if not exists public.quotation_audit (
    id bigserial primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    quotation_id bigint not null references public.quotations(id) on delete cascade,
    quotation_item_id bigint references public.quotation_items(id) on delete set null,
    actor_user_id uuid not null references auth.users(id),
    field_name text not null,
    old_value jsonb,
    new_value jsonb,
    created_at timestamptz not null default now()
);
create index if not exists idx_quotation_audit_user_quote
    on public.quotation_audit(user_id, quotation_id, created_at desc);

create table if not exists public.quotation_counters (
    user_id uuid not null references auth.users(id) on delete cascade,
    fiscal_year text not null,
    last_number integer not null default 0,
    primary key (user_id, fiscal_year)
);

alter table public.price_list_items enable row level security;
alter table public.quotations enable row level security;
alter table public.quotation_items enable row level security;
alter table public.quotation_audit enable row level security;
alter table public.quotation_counters enable row level security;

drop policy if exists "Tenant isolation for price_list_items" on public.price_list_items;
create policy "Tenant isolation for price_list_items" on public.price_list_items
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "Tenant isolation for quotations" on public.quotations;
create policy "Tenant isolation for quotations" on public.quotations
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "Tenant isolation for quotation_items" on public.quotation_items;
create policy "Tenant isolation for quotation_items" on public.quotation_items
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "Tenant isolation for quotation_audit" on public.quotation_audit;
create policy "Tenant isolation for quotation_audit" on public.quotation_audit
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "Tenant isolation for quotation_counters" on public.quotation_counters;
create policy "Tenant isolation for quotation_counters" on public.quotation_counters
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.next_quotation_number(p_user_id uuid, p_fiscal_year text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    next_value integer;
begin
    insert into public.quotation_counters(user_id, fiscal_year, last_number)
    values (p_user_id, p_fiscal_year, 1)
    on conflict (user_id, fiscal_year)
    do update set last_number = public.quotation_counters.last_number + 1
    returning last_number into next_value;
    return next_value;
end;
$$;
revoke all on function public.next_quotation_number(uuid, text) from public, anon, authenticated;
grant execute on function public.next_quotation_number(uuid, text) to service_role;

create or replace function public.quotation_migration_ready()
returns boolean
language sql
security definer
set search_path = public
as $$
    select to_regclass('public.price_list_items') is not null
       and to_regclass('public.quotations') is not null
       and to_regclass('public.quotation_items') is not null
       and to_regclass('public.quotation_audit') is not null
       and to_regclass('public.quotation_counters') is not null
       and to_regprocedure('public.next_quotation_number(uuid,text)') is not null;
$$;
revoke all on function public.quotation_migration_ready() from public, anon, authenticated;
grant execute on function public.quotation_migration_ready() to service_role;

notify pgrst, 'reload schema';

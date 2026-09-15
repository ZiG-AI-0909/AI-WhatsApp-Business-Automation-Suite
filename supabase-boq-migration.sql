-- =============================================================
-- Document Intelligence (BOQ / requirement extraction) storage.
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- AFTER supabase-multitenant-migration.sql
-- =============================================================
create table if not exists public.boq_documents (
    id            bigserial primary key,
    filename      text not null,
    file_ext      text default '',
    document_text text default '',
    status        text default 'review',
    items         text default '[]',
    warnings      text default '[]',
    user_id       uuid references auth.users(id),
    created_at    timestamptz default now(),
    updated_at    timestamptz default now()
);

comment on table public.boq_documents is 'Processed BOQ / requirement documents with extracted line items, per tenant (user_id)';

alter table public.boq_documents enable row level security;

-- Same RLS safety net as other tenant tables: the backend uses the service
-- role key; application-layer user_id scoping is the real enforcement.
create policy "Tenant isolation for boq_documents" on public.boq_documents
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists idx_boq_documents_user on public.boq_documents(user_id);

drop trigger if exists set_boq_documents_updated_at on public.boq_documents;
create trigger set_boq_documents_updated_at
    before update on public.boq_documents
    for each row execute procedure public.set_updated_at();

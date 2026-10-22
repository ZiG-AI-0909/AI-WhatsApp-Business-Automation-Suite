-- =============================================================
-- Storage monitoring, alerts and "Download now + clean up"
--
-- What it measures: every object in Supabase Storage (all buckets), read
-- from storage.objects.metadata->>'size' — the byte size Supabase recorded
-- for each stored object (exact per object; the plan's billed figure can
-- differ slightly). The plan's capacity is NOT available from the
-- database, so an administrator enters it on the Storage page
-- (storage_settings.capacity_bytes); until then no percentage is shown.
--
-- Download + clean up: an administrator picks folders, downloads them as
-- one ZIP, the server confirms the browser received the complete ZIP
-- (byte count + CRC-32), the administrator confirms it is saved, and only
-- then exactly those files are removed from storage. Files not in the ZIP,
-- files changed since, and files still used by a pending campaign stay.
--
-- Access model (same as vendor KYC): RLS ON with NO policies on every
-- table, and every function is executable by service_role only. The
-- browser never reads these tables; the backend (/api/storage/*) does,
-- and only users in private.kyc_staff can see details or change anything.
--
-- Requires supabase-vendor-kyc-migration.sql (private.kyc_staff).
-- Run in the Supabase SQL Editor. Safe to re-run. On a database where the
-- earlier version of this file (Google Drive backup) was run, it removes
-- those backup tables — only if they are still empty — and functions.
-- =============================================================

-- ─── Remove the earlier Google Drive backup objects ──────────
drop function if exists public.storage_monitor_backup_candidates(text[], integer, integer);
drop function if exists public.storage_monitor_backup_counts(text[]);
drop function if exists public.storage_monitor_files(text, text, bigint, text, text, integer, integer);
do $$
declare
    t text;
    has_data boolean;
begin
    foreach t in array array['storage_file_backups', 'storage_backup_runs', 'storage_drive_folders', 'storage_drive_connection']
    loop
        if to_regclass('public.' || t) is not null then
            -- storage_drive_connection always has its one settings row; it
            -- counts as data only if a Drive was ever connected.
            if t = 'storage_drive_connection' then
                execute 'select exists (select 1 from public.storage_drive_connection where refresh_token_encrypted is not null)' into has_data;
            else
                execute format('select exists (select 1 from public.%I)', t) into has_data;
            end if;
            if has_data then
                raise notice '% has data; left in place.', t;
            else
                execute format('drop table public.%I', t);
            end if;
        end if;
    end loop;
end;
$$;

-- ─── Settings (single row) ───────────────────────────────────
create table if not exists public.storage_settings (
    id                        smallint primary key default 1 check (id = 1),
    capacity_bytes            bigint check (capacity_bytes > 0),          -- file storage quota of your plan; NULL = not set
    db_capacity_bytes         bigint check (db_capacity_bytes > 0),       -- optional, database size quota
    warn_early_pct            smallint not null default 70 check (warn_early_pct between 1 and 99),
    warn_high_pct             smallint not null default 85 check (warn_high_pct between 1 and 99),
    warn_critical_pct         smallint not null default 95 check (warn_critical_pct between 1 and 99),
    reminder_hours            integer  not null default 24 check (reminder_hours between 0 and 720),  -- 0 = no reminders
    notify_all_staff          boolean  not null default true,              -- email everyone in private.kyc_staff
    extra_recipient_emails    text[]   not null default '{}',
    updated_at                timestamptz not null default now(),
    updated_by                uuid references auth.users(id) on delete set null,
    check (warn_early_pct < warn_high_pct and warn_high_pct < warn_critical_pct)
);
insert into public.storage_settings (id) values (1) on conflict (id) do nothing;
alter table public.storage_settings
    drop column if exists backup_enabled,
    drop column if exists backup_frequency_hours,
    drop column if exists critical_backup_enabled,
    drop column if exists excluded_buckets;

-- Alert state: the highest level already announced (0 = none).
create table if not exists public.storage_alert_state (
    id                smallint primary key default 1 check (id = 1),
    level             smallint not null default 0,
    last_notified_at  timestamptz,
    last_percent      numeric(6,2),
    updated_at        timestamptz not null default now()
);
insert into public.storage_alert_state (id) values (1) on conflict (id) do nothing;

-- ─── Usage history (for the trend chart) ─────────────────────
create table if not exists public.storage_usage_snapshots (
    id              bigserial primary key,
    taken_at        timestamptz not null default now(),
    used_bytes      bigint not null,
    file_count      bigint not null,
    capacity_bytes  bigint,
    db_bytes        bigint,
    by_bucket       jsonb not null default '[]'::jsonb
);
create index if not exists storage_usage_snapshots_taken_idx on public.storage_usage_snapshots (taken_at desc);

-- ─── Notification history ────────────────────────────────────
create table if not exists public.storage_notifications (
    id                bigserial primary key,
    created_at        timestamptz not null default now(),
    kind              text not null,
    level             smallint not null default 0,
    percent_used      numeric(6,2),
    used_bytes        bigint,
    capacity_bytes    bigint,
    message           text not null,
    email_status      text not null default 'pending' check (email_status in ('pending', 'sent', 'partial', 'failed', 'not_configured', 'no_recipients')),
    email_recipients  integer not null default 0,
    email_error       text
);
create index if not exists storage_notifications_created_idx on public.storage_notifications (created_at desc);
-- Kinds: threshold | reminder | cleanup_done (no fixed list, so a new kind needs no migration).
alter table public.storage_notifications drop constraint if exists storage_notifications_kind_check;

-- ─── Download archives ("Download now" + clean up) ───────────
create table if not exists public.storage_archives (
    id              uuid primary key default gen_random_uuid(),
    created_at      timestamptz not null default now(),
    created_by      uuid references auth.users(id) on delete set null,
    name            text not null,                 -- the ZIP file name
    status          text not null default 'ready'
                    check (status in ('ready', 'downloaded', 'verified', 'cleaned', 'cancelled')),
    selection       jsonb not null default '{}'::jsonb,   -- folders + "older than" filter
    file_count      integer not null default 0,
    total_bytes     bigint not null default 0,
    zip_bytes       bigint,                         -- size of the last complete ZIP sent
    zip_crc32       text,                           -- CRC-32 of that ZIP (8 hex)
    downloaded_at   timestamptz,
    verified_at     timestamptz,                    -- the browser reported the same size + CRC
    verified_by     uuid references auth.users(id) on delete set null,
    cleaned_at      timestamptz,
    cleaned_by      uuid references auth.users(id) on delete set null,
    cleaned_files   integer not null default 0,
    cleaned_bytes   bigint not null default 0,
    kept_files      integer not null default 0,
    note            text
);
create index if not exists storage_archives_created_idx on public.storage_archives (created_at desc);
-- Who did each step, as an email other administrators can read (the uuid
-- columns above keep the link to the account).
alter table public.storage_archives
    add column if not exists created_by_email     text,
    add column if not exists downloaded_by        uuid references auth.users(id) on delete set null,
    add column if not exists downloaded_by_email  text,
    add column if not exists download_count       integer not null default 0,
    add column if not exists verified_by_email    text,
    add column if not exists cleaned_by_email     text;

create table if not exists public.storage_archive_files (
    id           bigserial primary key,
    archive_id   uuid not null references public.storage_archives(id) on delete cascade,
    bucket_id    text not null,
    object_name  text not null,
    object_id    uuid,
    etag         text,            -- eTag when listed
    size_bytes   bigint not null default 0,
    mime_type    text,
    updated_at   timestamptz,
    zip_path     text not null,   -- path inside the ZIP
    status       text not null default 'listed'
                 check (status in ('listed', 'included', 'missing', 'deleted', 'kept')),
    sent_md5     text,            -- md5 of the bytes put in the ZIP
    note         text,            -- why a file was kept
    unique (archive_id, bucket_id, object_name)
);
create index if not exists storage_archive_files_archive_idx on public.storage_archive_files (archive_id, status);

-- ─── Job locks: one worker at a time, survives restarts ──────
create table if not exists public.storage_job_locks (
    name          text primary key,
    holder        text not null,
    locked_until  timestamptz not null
);

-- RLS on, no policies, no grants for anon/authenticated. Written out per
-- table so the SQL Editor's RLS check can see it.
alter table public.storage_settings          enable row level security;
alter table public.storage_alert_state       enable row level security;
alter table public.storage_usage_snapshots   enable row level security;
alter table public.storage_notifications     enable row level security;
alter table public.storage_archives          enable row level security;
alter table public.storage_archive_files     enable row level security;
alter table public.storage_job_locks         enable row level security;
revoke all on public.storage_settings, public.storage_alert_state, public.storage_usage_snapshots,
              public.storage_notifications, public.storage_archives, public.storage_archive_files,
              public.storage_job_locks
    from anon, authenticated;

-- ─── Functions (service_role only) ───────────────────────────

-- Usage per bucket, from Supabase's own object metadata.
create or replace function public.storage_monitor_usage()
returns table (bucket_id text, file_count bigint, total_bytes bigint, last_change timestamptz)
language sql stable security definer set search_path = ''
as $$
    select o.bucket_id,
           count(*)::bigint,
           coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint,
           max(coalesce(o.updated_at, o.created_at))
    from storage.objects o
    where o.name not like '%.emptyFolderPlaceholder'
    group by o.bucket_id;
$$;

create or replace function public.storage_monitor_db_size()
returns bigint
language sql stable security definer set search_path = ''
as $$ select pg_database_size(current_database())::bigint; $$;

-- Top-level folders per bucket ('' = files at the bucket root).
create or replace function public.storage_monitor_folders()
returns table (bucket_id text, folder text, file_count bigint, total_bytes bigint, oldest timestamptz, newest timestamptz)
language sql stable security definer set search_path = ''
as $$
    select o.bucket_id,
           case when position('/' in o.name) > 0 then split_part(o.name, '/', 1) else '' end,
           count(*)::bigint,
           coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint,
           min(coalesce(o.updated_at, o.created_at)),
           max(coalesce(o.updated_at, o.created_at))
    from storage.objects o
    where o.name not like '%.emptyFolderPlaceholder'
    group by 1, 2;
$$;

-- Files of one folder ('' = bucket root), optionally only older ones.
create or replace function public.storage_monitor_folder_files(p_bucket text, p_folder text, p_older_than timestamptz default null)
returns table (object_id uuid, bucket_id text, name text, size_bytes bigint, mime_type text, etag text, updated_at timestamptz)
language sql stable security definer set search_path = ''
as $$
    select o.id, o.bucket_id, o.name, coalesce((o.metadata->>'size')::bigint, 0), o.metadata->>'mimetype',
           o.metadata->>'eTag', coalesce(o.updated_at, o.created_at)
    from storage.objects o
    where o.bucket_id = p_bucket
      and o.name not like '%.emptyFolderPlaceholder'
      and (case when position('/' in o.name) > 0 then split_part(o.name, '/', 1) else '' end) = p_folder
      and (p_older_than is null or coalesce(o.updated_at, o.created_at) < p_older_than)
    order by o.name;
$$;

-- Current state of specific objects (for download and clean-up checks).
create or replace function public.storage_monitor_object_state(p_ids uuid[])
returns table (object_id uuid, bucket_id text, name text, size_bytes bigint, etag text)
language sql stable security definer set search_path = ''
as $$
    select o.id, o.bucket_id, o.name, coalesce((o.metadata->>'size')::bigint, 0), o.metadata->>'eTag'
    from storage.objects o
    where o.id = any (p_ids);
$$;

-- Paged file list. p_sort: 'size' | 'newest' | 'oldest'.
create or replace function public.storage_monitor_files(
    p_bucket text default null, p_mime_prefix text default null, p_min_bytes bigint default null,
    p_search text default null, p_sort text default 'size', p_limit integer default 50, p_offset integer default 0)
returns table (object_id uuid, bucket_id text, name text, size_bytes bigint, mime_type text,
               created_at timestamptz, updated_at timestamptz, total_count bigint)
language sql stable security definer set search_path = ''
as $$
    with f as (
        select o.id, o.bucket_id, o.name, coalesce((o.metadata->>'size')::bigint, 0) as size_bytes,
               o.metadata->>'mimetype' as mime_type, o.created_at, coalesce(o.updated_at, o.created_at) as updated_at
        from storage.objects o
        where o.name not like '%.emptyFolderPlaceholder'
          and (p_bucket is null or o.bucket_id = p_bucket)
          and (p_mime_prefix is null or o.metadata->>'mimetype' like p_mime_prefix || '%')
          and (p_min_bytes is null or coalesce((o.metadata->>'size')::bigint, 0) >= p_min_bytes)
          and (p_search is null or o.name ilike '%' || p_search || '%')
    )
    select f.id, f.bucket_id, f.name, f.size_bytes, f.mime_type, f.created_at, f.updated_at, count(*) over ()
    from f
    order by case when p_sort = 'size' then f.size_bytes end desc nulls last,
             case when p_sort = 'oldest' then f.updated_at end asc,
             f.updated_at desc
    limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset);
$$;

-- Email addresses of KYC staff (storage alert recipients).
create or replace function public.storage_monitor_staff_emails()
returns table (email text)
language sql stable security definer set search_path = ''
as $$
    select u.email::text from private.kyc_staff s join auth.users u on u.id = s.user_id where u.email is not null;
$$;

-- Atomic lease: true when p_holder now holds p_name for p_seconds.
create or replace function public.storage_monitor_try_lock(p_name text, p_holder text, p_seconds integer)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare got text;
begin
    insert into public.storage_job_locks as l (name, holder, locked_until)
    values (p_name, p_holder, now() + make_interval(secs => p_seconds))
    on conflict (name) do update
        set holder = excluded.holder, locked_until = excluded.locked_until
        where l.locked_until < now() or l.holder = excluded.holder
    returning holder into got;
    return coalesce(got = p_holder, false);
end;
$$;

create or replace function public.storage_monitor_unlock(p_name text, p_holder text)
returns void
language sql security definer set search_path = ''
as $$ delete from public.storage_job_locks where name = p_name and holder = p_holder; $$;

do $$
declare f text;
begin
    foreach f in array array['storage_monitor_usage()', 'storage_monitor_db_size()', 'storage_monitor_folders()',
                             'storage_monitor_folder_files(text, text, timestamptz)', 'storage_monitor_object_state(uuid[])',
                             'storage_monitor_files(text, text, bigint, text, text, integer, integer)',
                             'storage_monitor_staff_emails()',
                             'storage_monitor_try_lock(text, text, integer)', 'storage_monitor_unlock(text, text)']
    loop
        execute format('revoke all on function public.%s from public, anon, authenticated', f);
        execute format('grant execute on function public.%s to service_role', f);
    end loop;
end;
$$;

-- ─── Verify ──────────────────────────────────────────────────
--   select * from public.storage_monitor_usage();
--   select * from public.storage_monitor_folders();
--   select * from public.storage_settings;

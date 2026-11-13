-- 1) Automatic monthly invoices and 2) weekly database backup to Google Drive.
-- Both run on Supabase's built-in scheduler (pg_cron + pg_net, included in the free plan)
-- and reuse the private 'homework_archive_secret' already stored in Vault.

insert into public.settings (setting_key, value, description)
values ('AUTO_INVOICE_ENABLED', 'TRUE', 'Generate this month''s invoices automatically on the 1st at 6 AM (TRUE or FALSE)'),
       ('AUTO_BACKUP_ENABLED', 'TRUE', 'Back up the database to the connected Google Drive every Sunday at 2 AM (TRUE or FALSE)')
on conflict (setting_key) do nothing;

alter table public.google_drive_connections add column if not exists backup_folder_id text;

-- History of backups, shown in Admin → Settings.
create table if not exists public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'RUNNING' check (status in ('RUNNING','OK','FAILED')),
  trigger text not null default 'SCHEDULED' check (trigger in ('SCHEDULED','MANUAL')),
  file_name text not null default '',
  drive_file_id text,
  drive_connection_id uuid references public.google_drive_connections(id) on delete set null,
  size_bytes bigint not null default 0,
  table_count integer not null default 0,
  row_count integer not null default 0,
  error text not null default ''
);
alter table public.backup_runs enable row level security;
revoke all on public.backup_runs from anon, authenticated;
grant all on public.backup_runs to service_role;

-- Tables included in the backup: every public table except secrets and short-lived rate-limit rows.
create or replace function public.backup_table_names()
returns setof text language sql security definer set search_path = public as $$
  select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname not in ('google_drive_connections','google_drive_oauth_states','login_rate_limits','registration_rate_limits','backup_runs')
  order by c.relname;
$$;

-- One table as a JSON array.
create or replace function public.backup_export_table(p_table text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not exists (select 1 from public.backup_table_names() t where t = p_table) then
    raise exception 'table not allowed';
  end if;
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from public.%I t', p_table) into v;
  return v;
end; $$;

revoke all on function public.backup_table_names() from public, anon, authenticated;
revoke all on function public.backup_export_table(text) from public, anon, authenticated;
grant execute on function public.backup_table_names() to service_role;
grant execute on function public.backup_export_table(text) to service_role;

-- Invoices: 1st of every month, 06:00 IST (00:30 UTC).
select cron.unschedule(jobid) from cron.job where jobname = 'cmz-auto-invoices';
select cron.schedule(
  'cmz-auto-invoices', '30 0 1 * *',
  $$select net.http_post(
    url := 'https://krjkkkwxqvvxeifxmgjx.supabase.co/functions/v1/api',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_xAhDwzA3EZteyMSM3qooww_S1YlVX36',
      'x-archive-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'homework_archive_secret' limit 1)
    ), body := '{"action":"cron.autoInvoices"}'::jsonb,
    timeout_milliseconds := 120000
  );$$
);

-- Backup: every Sunday 02:00 IST (Saturday 20:30 UTC).
select cron.unschedule(jobid) from cron.job where jobname = 'cmz-weekly-backup';
select cron.schedule(
  'cmz-weekly-backup', '30 20 * * 6',
  $$select net.http_post(
    url := 'https://krjkkkwxqvvxeifxmgjx.supabase.co/functions/v1/backup-drive',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_xAhDwzA3EZteyMSM3qooww_S1YlVX36',
      'x-archive-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'homework_archive_secret' limit 1)
    ), body := '{"action":"scheduled"}'::jsonb,
    timeout_milliseconds := 120000
  );$$
);

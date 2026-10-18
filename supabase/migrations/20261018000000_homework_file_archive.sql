-- Homework attachments live in private storage until their deadline, then are
-- copied to the centre's Google Drive before the Supabase copy is removed.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('homework-files', 'homework-files', false, 10485760,
  array['application/pdf','image/jpeg','image/png','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.homework_files (
  id text primary key,
  homework_id text not null references public.homework(id) on delete cascade,
  submission_id text references public.homework_submissions(id) on delete cascade,
  uploaded_by_type text not null check (uploaded_by_type in ('TEACHER','STUDENT')),
  uploaded_by_id text not null,
  file_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 180),
  mime_type text not null,
  file_size bigint not null check (file_size between 1 and 10485760),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  drive_file_id text,
  drive_connection_id uuid,
  archive_error text,
  check ((uploaded_by_type = 'TEACHER' and submission_id is null) or
         (uploaded_by_type = 'STUDENT' and submission_id is not null))
);
create index homework_files_due_archive_idx on public.homework_files(homework_id, archived_at);
create index homework_files_drive_connection_idx on public.homework_files(drive_connection_id);
alter table public.homework_files enable row level security;

-- Refresh tokens are encrypted by the Edge Function before insertion. RLS is
-- enabled with no client policies; only the service role can read them.
create table public.google_drive_connections (
  id uuid primary key default gen_random_uuid(),
  account_email text not null,
  refresh_token_ciphertext text not null,
  created_at timestamptz not null default now(),
  connected_by text not null,
  is_primary boolean not null default false,
  drive_folder_id text,
  disconnected_at timestamptz
);
create unique index google_drive_one_primary_idx on public.google_drive_connections(is_primary)
  where is_primary and disconnected_at is null;
alter table public.google_drive_connections enable row level security;
alter table public.homework_files add constraint homework_files_drive_connection_fk
  foreign key (drive_connection_id) references public.google_drive_connections(id) on delete restrict;

create table public.google_drive_oauth_states (
  state text primary key,
  app_user_id uuid not null references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.google_drive_oauth_states enable row level security;

-- The archive worker runs hourly. Add the Vault secret named
-- homework_archive_secret as described in docs/homework-drive-setup.md.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname = 'cmz-archive-homework-files';
select cron.schedule(
  'cmz-archive-homework-files', '0 * * * *',
  $$select net.http_post(
    url := 'https://krjkkkwxqvvxeifxmgjx.supabase.co/functions/v1/homework-drive',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_xAhDwzA3EZteyMSM3qooww_S1YlVX36',
      'x-archive-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'homework_archive_secret' limit 1)
    ), body := '{}'::jsonb
  );$$
);

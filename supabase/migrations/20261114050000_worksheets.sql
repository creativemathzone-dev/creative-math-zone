-- AI worksheet maker (board-style test papers with answer keys).
-- No Supabase Storage is used: worksheets are plain text rows. After 7 days the
-- full text (questions + answer key) is moved to the centre's Google Drive and
-- removed from the database; only a small index row stays for the library.

create table if not exists public.worksheets (
  id text primary key,
  created_by uuid references public.app_users(id) on delete set null,
  teacher_id text references public.teachers(id) on delete set null,
  subject_id text references public.subjects(id) on delete set null,
  batch_id text references public.batches(id) on delete set null,
  class_name text not null default '',
  board text not null default '',
  chapter text not null default '',
  difficulty text not null default 'MIXED' check (difficulty in ('EASY','MEDIUM','HARD','MIXED')),
  total_marks integer not null default 20 check (total_marks between 5 and 100),
  duration_min integer not null default 45 check (duration_min between 5 and 240),
  title text not null check (length(title) between 1 and 150),
  set_label text not null default 'A',
  parent_id text references public.worksheets(id) on delete set null,
  questions text not null default '',
  answer_key text not null default '',
  model text not null default '',
  archived_at timestamptz,
  drive_file_id text,
  drive_connection_id uuid references public.google_drive_connections(id) on delete set null,
  archive_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists worksheets_library_idx on public.worksheets(subject_id, class_name, board, created_at desc);
create index if not exists worksheets_archive_idx on public.worksheets(updated_at) where archived_at is null;
alter table public.worksheets enable row level security;
revoke all on public.worksheets from anon, authenticated;
grant all on public.worksheets to service_role;

-- Homework can point at a worksheet (the questions are not copied into homework).
alter table public.homework add column if not exists worksheet_id text references public.worksheets(id) on delete set null;
create index if not exists homework_worksheet_idx on public.homework(worksheet_id) where worksheet_id is not null;

alter table public.google_drive_connections add column if not exists worksheet_folder_id text;

-- Hourly: move worksheets older than 7 days to Google Drive (reuses the Vault secret).
select cron.unschedule(jobid) from cron.job where jobname = 'cmz-worksheet-archive';
select cron.schedule(
  'cmz-worksheet-archive', '40 * * * *',
  $$select net.http_post(
    url := 'https://krjkkkwxqvvxeifxmgjx.supabase.co/functions/v1/worksheets',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_xAhDwzA3EZteyMSM3qooww_S1YlVX36',
      'x-archive-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'homework_archive_secret' limit 1)
    ), body := '{"action":"worker"}'::jsonb,
    timeout_milliseconds := 120000
  );$$
);

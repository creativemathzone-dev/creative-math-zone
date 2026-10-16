-- Private PDFs shared by teachers with students in a class session.
-- Files expire exactly seven days after upload and are removed by a scheduled function.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('class-materials', 'class-materials', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['application/pdf'];

create table public.class_materials (
  id text primary key,
  session_id text not null references public.class_sessions(id) on delete cascade,
  teacher_id text not null references public.teachers(id) on delete cascade,
  file_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 180),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index class_materials_session_expiry_idx on public.class_materials(session_id, expires_at);
create index class_materials_expiry_idx on public.class_materials(expires_at);
alter table public.class_materials enable row level security;

-- Supabase Cron invokes a narrowly scoped cleanup function hourly. The function
-- only deletes storage objects whose expiry has already passed.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname = 'cmz-delete-expired-class-materials';
select cron.schedule(
  'cmz-delete-expired-class-materials',
  '0 * * * *',
  $$select net.http_post(
    url := 'https://krjkkkwxqvvxeifxmgjx.supabase.co/functions/v1/cleanup-class-materials',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', 'sb_publishable_xAhDwzA3EZteyMSM3qooww_S1YlVX36'),
    body := '{}'::jsonb
  );$$
);

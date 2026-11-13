-- Doubt solving portal.
-- Students post doubts (text + up to 3 compressed photos) for a subject they take.
-- Students in the same class who take that subject can see them; subject teachers
-- solve them. Student answers stay PENDING until a subject teacher approves them.
-- Photos go straight to the connected Google Drive. Only if Drive is unavailable
-- is a photo kept briefly in the private 'doubt-files' bucket; the hourly worker
-- moves it to Drive and deletes anything still left in Supabase after 7 days.

create table if not exists public.doubts (
  id text primary key,
  student_id text not null references public.students(id) on delete cascade,
  subject_id text not null references public.subjects(id),
  class_name text not null,
  chapter text not null default '',
  title text not null check (length(title) between 3 and 200),
  body text not null default '' check (length(body) <= 4000),
  status text not null default 'OPEN' check (status in ('OPEN','CLAIMED','ANSWERED','RESOLVED')),
  hidden boolean not null default false,
  claimed_by text references public.teachers(id) on delete set null,
  claimed_at timestamptz,
  first_teacher_answer_at timestamptz,
  first_answered_by text references public.teachers(id) on delete set null,
  resolved_at timestamptz,
  me_too_count integer not null default 0 check (me_too_count >= 0),
  academic_year text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists doubts_feed_idx on public.doubts(class_name, subject_id, created_at desc);
create index if not exists doubts_student_idx on public.doubts(student_id, created_at desc);
create index if not exists doubts_status_idx on public.doubts(status, created_at desc);

create table if not exists public.doubt_answers (
  id text primary key,
  doubt_id text not null references public.doubts(id) on delete cascade,
  author_type text not null check (author_type in ('TEACHER','STUDENT')),
  author_id text not null,
  body text not null default '' check (length(body) <= 6000),
  status text not null default 'PENDING' check (status in ('APPROVED','PENDING','REJECTED','HIDDEN')),
  is_follow_up boolean not null default false,
  review_note text not null default '',
  reviewed_by text references public.teachers(id) on delete set null,
  reviewed_at timestamptz,
  points_awarded integer not null default 0 check (points_awarded >= 0),
  created_at timestamptz not null default now()
);
create index if not exists doubt_answers_doubt_idx on public.doubt_answers(doubt_id, created_at);
create index if not exists doubt_answers_author_idx on public.doubt_answers(author_type, author_id, status, reviewed_at desc);
create index if not exists doubt_answers_pending_idx on public.doubt_answers(status) where status = 'PENDING';

create table if not exists public.doubt_files (
  id text primary key,
  doubt_id text not null references public.doubts(id) on delete cascade,
  answer_id text references public.doubt_answers(id) on delete cascade,
  uploaded_by_type text not null check (uploaded_by_type in ('TEACHER','STUDENT')),
  uploaded_by_id text not null,
  file_name text not null check (length(file_name) between 1 and 180),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  file_size integer not null check (file_size between 1 and 3145728),
  storage_path text unique,
  drive_file_id text,
  drive_connection_id uuid references public.google_drive_connections(id) on delete restrict,
  archive_error text,
  expired_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists doubt_files_owner_idx on public.doubt_files(doubt_id, answer_id);
create index if not exists doubt_files_pending_idx on public.doubt_files(created_at) where storage_path is not null;

create table if not exists public.doubt_me_too (
  doubt_id text not null references public.doubts(id) on delete cascade,
  student_id text not null references public.students(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (doubt_id, student_id)
);

-- Separate Drive folder for doubts inside the same connected Google account.
alter table public.google_drive_connections add column if not exists doubt_folder_id text;

alter table public.doubts enable row level security;
alter table public.doubt_answers enable row level security;
alter table public.doubt_files enable row level security;
alter table public.doubt_me_too enable row level security;
revoke all on public.doubts, public.doubt_answers, public.doubt_files, public.doubt_me_too from anon, authenticated;
grant all on public.doubts, public.doubt_answers, public.doubt_files, public.doubt_me_too to service_role;

insert into public.settings (setting_key, value, description)
values ('DOUBT_DAILY_LIMIT', '5', 'Maximum doubts one student can post per day'),
       ('DOUBT_APPROVAL_POINTS', '10', 'Points a student earns when a teacher approves their answer')
on conflict (setting_key) do nothing;

-- Temporary fallback bucket (only used while Google Drive is unavailable).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('doubt-files', 'doubt-files', false, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

-- Keep me_too_count in step with the rows.
create or replace function public.toggle_doubt_me_too(p_doubt_id text, p_student_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_on boolean; v_count integer;
begin
  if exists (select 1 from public.doubt_me_too where doubt_id = p_doubt_id and student_id = p_student_id) then
    delete from public.doubt_me_too where doubt_id = p_doubt_id and student_id = p_student_id;
    v_on := false;
  else
    insert into public.doubt_me_too (doubt_id, student_id) values (p_doubt_id, p_student_id);
    v_on := true;
  end if;
  select count(*) into v_count from public.doubt_me_too where doubt_id = p_doubt_id;
  update public.doubts set me_too_count = v_count where id = p_doubt_id;
  return jsonb_build_object('on', v_on, 'count', v_count);
end; $$;
revoke all on function public.toggle_doubt_me_too(text, text) from public, anon, authenticated;
grant execute on function public.toggle_doubt_me_too(text, text) to service_role;

-- Permanent student delete also removes their doubt answers.
create or replace function public.delete_student_permanently(p_student_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
begin
  if not exists (select 1 from public.students where id = p_student_id for update) then
    raise exception 'student not found';
  end if;

  delete from public.homework_submissions where student_id = p_student_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('homework_submissions', v_n);

  delete from public.doubt_answers where author_type = 'STUDENT' and author_id = p_student_id;
  delete from public.doubts where student_id = p_student_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('doubts', v_n);

  delete from public.payment_submissions
   where student_id = p_student_id
      or invoice_id in (select id from public.invoices where student_id = p_student_id);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('payment_submissions', v_n);

  update public.payments set receipt_id = null where student_id = p_student_id;
  update public.receipts set reissue_of = null
   where reissue_of in (select id from public.receipts where student_id = p_student_id);
  update public.receipts set reissued_by = null
   where reissued_by in (select id from public.receipts where student_id = p_student_id);
  delete from public.receipts
   where student_id = p_student_id
      or payment_id in (select id from public.payments where student_id = p_student_id);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('receipts', v_n);

  delete from public.payments where student_id = p_student_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('payments', v_n);

  delete from public.invoices where student_id = p_student_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoices', v_n);

  delete from public.student_fees where student_id = p_student_id;
  delete from public.discounts where student_id = p_student_id;

  delete from public.attendance_logs where student_id = p_student_id;
  delete from public.attendance where student_id = p_student_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('attendance', v_n);
  delete from public.change_history where student_id = p_student_id;

  delete from public.student_subjects where student_id = p_student_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('subjects', v_n);
  delete from public.registrations where student_id = p_student_id;
  delete from public.app_users where user_type = 'STUDENT' and linked_id = p_student_id;
  delete from public.students where id = p_student_id;

  return v_counts;
end;
$$;
revoke all on function public.delete_student_permanently(text) from public, anon, authenticated;
grant execute on function public.delete_student_permanently(text) to service_role;

-- Hourly worker: move fallback photos to Drive, drop Supabase copies after 7 days.
-- Reuses the homework archive secret already stored in Vault.
select cron.unschedule(jobid) from cron.job where jobname = 'cmz-doubt-files-worker';
select cron.schedule(
  'cmz-doubt-files-worker', '20 * * * *',
  $$select net.http_post(
    url := 'https://krjkkkwxqvvxeifxmgjx.supabase.co/functions/v1/doubt-files',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_xAhDwzA3EZteyMSM3qooww_S1YlVX36',
      'x-archive-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'homework_archive_secret' limit 1)
    ), body := '{"action":"worker"}'::jsonb
  );$$
);

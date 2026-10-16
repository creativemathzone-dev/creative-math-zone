-- Teacher homework, reusable material links, and student submission tracking.
-- Expired assignments are retained for teacher reporting, but hidden from
-- students and submissions are rejected after the due date.
create table public.homework (
  id text primary key,
  teacher_id text not null references public.teachers(id) on delete cascade,
  batch_id text not null references public.batches(id) on delete cascade,
  subject_id text references public.subjects(id) on delete set null,
  title text not null check (length(title) between 1 and 150),
  instructions text not null default '',
  materials jsonb not null default '[]'::jsonb,
  due_at timestamptz,
  status text not null default 'Active' check (status in ('Active','Archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.homework_submissions (
  id text primary key,
  homework_id text not null references public.homework(id) on delete cascade,
  student_id text not null references public.students(id) on delete cascade,
  answer text not null default '',
  attachment_url text not null default '',
  status text not null default 'SUBMITTED' check (status in ('SUBMITTED','REVIEWED')),
  feedback text not null default '',
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique(homework_id, student_id)
);

create index homework_teacher_batch_due_idx on public.homework(teacher_id, batch_id, due_at desc);
create index homework_student_status_idx on public.homework_submissions(student_id, submitted_at desc);
alter table public.homework enable row level security;
alter table public.homework_submissions enable row level security;

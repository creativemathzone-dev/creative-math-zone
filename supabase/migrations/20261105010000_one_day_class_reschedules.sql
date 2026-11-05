-- One-off date changes for a recurring timetable slot. The weekly timetable stays unchanged.
create table if not exists public.class_reschedules (
  id text primary key,
  timetable_id text not null references public.timetable(id) on delete cascade,
  teacher_id text not null references public.teachers(id),
  batch_id text not null references public.batches(id),
  subject_id text not null references public.subjects(id),
  co_subject_id text references public.subjects(id) on delete set null,
  room_id text references public.rooms(id) on delete set null,
  original_date date not null,
  rescheduled_date date not null,
  start_time time not null,
  end_time time not null,
  reason text not null default '',
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CANCELLED')),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint class_reschedules_different_date check (original_date <> rescheduled_date),
  constraint class_reschedules_valid_time check (end_time > start_time),
  constraint class_reschedules_one_override_per_occurrence unique (timetable_id, original_date)
);

create index if not exists class_reschedules_batch_date_idx
  on public.class_reschedules (batch_id, rescheduled_date desc, created_at desc);
create index if not exists class_reschedules_teacher_date_idx
  on public.class_reschedules (teacher_id, original_date, rescheduled_date)
  where status = 'ACTIVE';

alter table public.class_reschedules enable row level security;

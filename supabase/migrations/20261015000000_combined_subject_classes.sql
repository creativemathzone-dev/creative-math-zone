alter table public.timetable
  add column if not exists co_subject_id text references public.subjects(id) on delete set null;

alter table public.class_sessions
  add column if not exists co_subject_id text references public.subjects(id) on delete set null;

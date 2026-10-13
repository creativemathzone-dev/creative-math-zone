-- A timetable slot may have only one open session on a given date.
-- This protects against duplicate starts from two teachers/devices at once.
create unique index if not exists class_sessions_one_open_slot_per_day
  on public.class_sessions (timetable_id, session_date)
  where timetable_id is not null and status = 'OPEN';

create unique index if not exists class_sessions_unique_open_attendance_code
  on public.class_sessions (attendance_code)
  where status = 'OPEN';

-- Fast roster and class-history lookups used by the teacher and admin portals.
create index if not exists student_subjects_teacher_class_roster_idx
  on public.student_subjects (teacher_id, batch_id, subject_id, student_id);

create index if not exists class_sessions_teacher_date_idx
  on public.class_sessions (teacher_id, session_date desc, start_time desc);

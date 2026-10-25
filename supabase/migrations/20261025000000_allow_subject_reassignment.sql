-- Keep ended assignments as history while allowing the same subject to be
-- assigned again to the student within the same academic year.
alter table public.student_subjects
  drop constraint if exists student_subjects_student_id_subject_id_academic_year_key;

create unique index if not exists student_subjects_one_active_assignment_per_year_idx
  on public.student_subjects (student_id, subject_id, academic_year)
  where upper(status) = 'ACTIVE';

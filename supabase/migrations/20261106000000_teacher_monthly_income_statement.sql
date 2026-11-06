-- Monthly teacher statement based on each student's assigned subject fee.
-- A NULL subject_id identifies one statement per teacher/month. Existing
-- subject-level teacher_income rows remain available as historical records.
alter table public.teacher_income
  add column if not exists expected_amount numeric(12,2) not null default 0 check (expected_amount >= 0),
  add column if not exists collected_amount numeric(12,2) not null default 0 check (collected_amount >= 0),
  add column if not exists outstanding_amount numeric(12,2) not null default 0 check (outstanding_amount >= 0),
  add column if not exists institute_contribution numeric(12,2) not null default 0 check (institute_contribution >= 0),
  add column if not exists student_details jsonb not null default '[]'::jsonb;

create unique index if not exists teacher_income_monthly_statement_key
  on public.teacher_income (teacher_id, month, academic_year)
  where subject_id is null;

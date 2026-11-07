-- Let one teacher payment option (one QR / UPI ID / link) cover multiple subjects.
alter table public.teacher_payment_methods
  add column if not exists subject_ids text[] not null default '{}'::text[];

update public.teacher_payment_methods
set subject_ids = array[subject_id]::text[]
where cardinality(subject_ids) = 0;

create index if not exists teacher_payment_methods_subject_ids_gin_idx
  on public.teacher_payment_methods using gin (subject_ids);

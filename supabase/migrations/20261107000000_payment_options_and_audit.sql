-- Teacher-owned payment options, student payment claims, and receipt reissue links.
create table if not exists public.teacher_payment_methods (
  id uuid primary key default gen_random_uuid(),
  teacher_id text not null references public.teachers(id) on delete cascade,
  subject_id text not null references public.subjects(id) on delete cascade,
  upi_id text not null default '',
  payment_link text not null default '',
  qr_path text not null default '',
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  review_note text not null default '',
  reviewed_by uuid references public.app_users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (upi_id <> '' or payment_link <> '' or qr_path <> '')
);
create index if not exists teacher_payment_methods_lookup_idx
  on public.teacher_payment_methods(subject_id, teacher_id, status, created_at desc);

create table if not exists public.payment_submissions (
  id uuid primary key default gen_random_uuid(),
  invoice_id text not null references public.invoices(id),
  student_id text not null references public.students(id),
  amount numeric(12,2) not null check (amount > 0),
  payment_mode text not null default 'UPI' check (payment_mode in ('UPI','BANK_TRANSFER')),
  transaction_reference text not null,
  allocations jsonb not null default '[]'::jsonb check (jsonb_typeof(allocations) = 'array'),
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','APPROVED','REJECTED')),
  review_note text not null default '',
  reviewed_by uuid references public.app_users(id) on delete set null,
  reviewed_at timestamptz,
  payment_id text references public.payments(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists payment_submissions_review_idx on public.payment_submissions(status, created_at desc);
create index if not exists payment_submissions_student_idx on public.payment_submissions(student_id, created_at desc);

alter table public.receipts add column if not exists reissue_of text references public.receipts(id) on delete set null;
alter table public.receipts add column if not exists reissued_by text references public.receipts(id) on delete set null;
create index if not exists receipts_reissue_of_idx on public.receipts(reissue_of) where reissue_of is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('teacher-payment-qr', 'teacher-payment-qr', false, 1572864, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 1572864,
  allowed_mime_types = array['image/png','image/jpeg','image/webp'];

revoke all on public.teacher_payment_methods, public.payment_submissions from anon, authenticated;
grant all on public.teacher_payment_methods, public.payment_submissions to service_role;

-- Creative Math Zone relational foundation.
-- Data is intentionally empty. Import from Apps Script only after mapping and validation.
-- RLS is enabled below without client policies, so the browser cannot access records yet.

create extension if not exists pgcrypto;

create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  username text not null unique,
  user_type text not null check (user_type in ('ADMIN','TEACHER','STUDENT')),
  role text not null check (role in ('SUPER_ADMIN','ACCOUNTS_ADMIN','TEACHER','STUDENT')),
  linked_id text,
  status text not null default 'Active' check (status in ('Active','Inactive','Locked')),
  must_change_password boolean not null default false,
  extra_permissions text[] not null default '{}',
  last_login timestamptz,
  last_logout timestamptz,
  password_changed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index app_users_username_case_insensitive_uidx on public.app_users(lower(username));

create table public.settings (
  setting_key text primary key,
  value text not null default '',
  description text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.app_users(id) on delete set null
);

create table public.subjects (
  id text primary key,
  name text not null unique,
  status text not null default 'Active' check (status in ('Active','Inactive'))
);
create table public.batches (
  id text primary key,
  name text not null,
  class text not null default '',
  section text not null default '',
  academic_year text not null,
  status text not null default 'Active' check (status in ('Active','Inactive')),
  unique(name, academic_year)
);
create table public.rooms (
  id text primary key,
  name text not null unique,
  capacity integer not null default 0 check (capacity >= 0),
  status text not null default 'Active' check (status in ('Active','Inactive'))
);
create table public.teachers (
  id text primary key,
  name text not null,
  photo_url text not null default '',
  mobile text not null default '',
  email text not null default '',
  address text not null default '',
  qualification text not null default '',
  joining_date date,
  status text not null default 'Active' check (status in ('Active','Inactive')),
  username text,
  income_method text not null default '',
  default_rate_per_student numeric(12,2) not null default 0 check (default_rate_per_student >= 0),
  income_visible_to_teacher boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.students (
  id text primary key,
  registration_year text not null default '',
  registration_date date,
  roll_no text not null default '',
  name text not null,
  photo_url text not null default '',
  dob date,
  gender text not null default '',
  mobile text not null default '',
  email text not null default '',
  address text not null default '',
  school text not null default '',
  board text not null default '',
  current_class text not null default '',
  current_batch_id text references public.batches(id) on delete set null,
  parent_name text not null default '',
  relationship text not null default '',
  parent_mobile text not null default '',
  parent_whatsapp text not null default '',
  parent_email text not null default '',
  previous_percentage numeric(5,2) check (previous_percentage between 0 and 100),
  status text not null default 'Active',
  academic_year text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.student_subjects (
  id text primary key,
  student_id text not null references public.students(id) on delete cascade,
  subject_id text not null references public.subjects(id),
  teacher_id text references public.teachers(id) on delete set null,
  batch_id text references public.batches(id) on delete set null,
  start_date date,
  end_date date,
  status text not null default 'Active',
  fee_override numeric(12,2) check (fee_override is null or fee_override >= 0),
  teacher_rate_override numeric(12,2) check (teacher_rate_override is null or teacher_rate_override >= 0),
  academic_year text not null default '',
  created_at timestamptz not null default now(),
  unique(student_id, subject_id, academic_year)
);

create table public.timetable (
  id text primary key,
  day text not null,
  start_time time not null,
  end_time time not null,
  batch_id text not null references public.batches(id),
  subject_id text not null references public.subjects(id),
  teacher_id text not null references public.teachers(id),
  room_id text references public.rooms(id) on delete set null,
  academic_year text not null,
  status text not null default 'Active',
  check(end_time > start_time)
);
create table public.class_sessions (
  id text primary key,
  timetable_id text references public.timetable(id) on delete set null,
  session_date date not null,
  start_time time not null,
  end_time time not null,
  teacher_id text not null references public.teachers(id),
  batch_id text not null references public.batches(id),
  subject_id text not null references public.subjects(id),
  room_id text references public.rooms(id) on delete set null,
  attendance_code text not null default '',
  code_created_at timestamptz,
  code_expires_at timestamptz,
  status text not null default 'Scheduled',
  started_at timestamptz,
  closed_at timestamptz,
  academic_year text not null
);
create table public.attendance (
  id text primary key,
  session_id text not null references public.class_sessions(id) on delete cascade,
  student_id text not null references public.students(id),
  subject_id text not null references public.subjects(id),
  batch_id text not null references public.batches(id),
  session_date date not null,
  status text not null,
  marked_by uuid references public.app_users(id) on delete set null,
  marked_at timestamptz not null default now(),
  method text not null default '',
  location_verified boolean not null default false,
  academic_year text not null,
  unique(session_id, student_id)
);
create table public.attendance_logs (
  id text primary key,
  attendance_id text references public.attendance(id) on delete set null,
  session_id text not null references public.class_sessions(id) on delete cascade,
  student_id text not null references public.students(id),
  old_status text not null default '',
  new_status text not null,
  changed_by uuid references public.app_users(id) on delete set null,
  changed_at timestamptz not null default now(),
  reason text not null default ''
);

create table public.fee_structure (
  id text primary key,
  item_type text not null,
  subject_id text references public.subjects(id) on delete set null,
  description text not null default '',
  amount numeric(12,2) not null check (amount >= 0),
  academic_year text not null,
  status text not null default 'Active'
);
create table public.student_fees (
  id text primary key,
  student_id text not null references public.students(id),
  subject_id text references public.subjects(id) on delete set null,
  standard_amount numeric(12,2) not null check (standard_amount >= 0),
  discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0),
  final_amount numeric(12,2) not null check (final_amount >= 0),
  effective_from date not null,
  effective_to date,
  academic_year text not null,
  status text not null default 'Active',
  created_at timestamptz not null default now(),
  reason text not null default '',
  check (effective_to is null or effective_to >= effective_from)
);
create table public.invoices (
  id text primary key,
  student_id text not null references public.students(id),
  month text not null,
  academic_year text not null,
  line_items jsonb not null default '[]',
  total_amount numeric(12,2) not null check (total_amount >= 0),
  paid_amount numeric(12,2) not null default 0 check (paid_amount >= 0),
  balance_amount numeric(12,2) not null check (balance_amount >= 0),
  status text not null,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(student_id, month, academic_year)
);
create table public.payments (
  id text primary key,
  student_id text not null references public.students(id),
  invoice_id text references public.invoices(id) on delete set null,
  payment_date date not null,
  amount numeric(12,2) not null check (amount > 0),
  payment_mode text not null,
  transaction_reference text not null default '',
  received_by uuid references public.app_users(id) on delete set null,
  status text not null default 'Active',
  notes text not null default '',
  receipt_id text,
  academic_year text not null,
  voided_by uuid references public.app_users(id) on delete set null,
  void_date timestamptz,
  void_reason text not null default '',
  allocations jsonb not null default '[]'
);
create table public.receipts (
  id text primary key,
  payment_id text not null references public.payments(id),
  student_id text not null references public.students(id),
  receipt_date date not null,
  amount numeric(12,2) not null check (amount > 0),
  format text not null default '',
  status text not null default 'Active',
  voided_by uuid references public.app_users(id) on delete set null,
  void_date timestamptz,
  void_reason text not null default '',
  academic_year text not null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.payments add constraint payments_receipt_fk foreign key(receipt_id) references public.receipts(id) on delete set null deferrable initially deferred;
create table public.discounts (
  id text primary key,
  student_id text not null references public.students(id),
  subject_id text references public.subjects(id) on delete set null,
  original_amount numeric(12,2) not null check (original_amount >= 0),
  discount_amount numeric(12,2) not null check (discount_amount >= 0),
  discount_type text not null,
  reason text not null default '',
  approved_by uuid references public.app_users(id) on delete set null,
  discount_date date not null,
  status text not null default 'Active',
  academic_year text not null
);
create table public.teacher_income (
  id text primary key,
  teacher_id text not null references public.teachers(id),
  subject_id text references public.subjects(id) on delete set null,
  month text not null,
  student_count integer not null default 0 check (student_count >= 0),
  rate_per_student numeric(12,2) not null default 0,
  gross_income numeric(12,2) not null default 0,
  adjustment numeric(12,2) not null default 0,
  adjustment_reason text not null default '',
  final_payable numeric(12,2) not null default 0,
  status text not null default 'Pending',
  academic_year text not null,
  created_at timestamptz not null default now(),
  unique(teacher_id, subject_id, month, academic_year)
);
create table public.teacher_payments (
  id text primary key,
  teacher_id text not null references public.teachers(id),
  income_id text references public.teacher_income(id) on delete set null,
  payment_date date not null,
  amount numeric(12,2) not null check (amount > 0),
  payment_mode text not null,
  upi_reference text not null default '',
  paid_by uuid references public.app_users(id) on delete set null,
  notes text not null default ''
);

create table public.notices (
  id text primary key,
  title text not null,
  body text not null,
  audience text not null,
  batch_id text references public.batches(id) on delete set null,
  posted_by uuid references public.app_users(id) on delete set null,
  posted_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'Active',
  academic_year text not null default ''
);
create table public.admin_logs (
  id text primary key,
  logged_at timestamptz not null default now(),
  user_id uuid references public.app_users(id) on delete set null,
  username text not null default '',
  role text not null default '',
  action text not null,
  entity_type text not null default '',
  entity_id text not null default '',
  details text not null default '',
  result text not null default ''
);
create table public.change_history (
  id text primary key,
  student_id text not null references public.students(id),
  field text not null,
  old_value text not null default '',
  new_value text not null default '',
  changed_by uuid references public.app_users(id) on delete set null,
  changed_at timestamptz not null default now(),
  reason text not null default '',
  academic_year text not null default ''
);
create table public.registrations (
  id text primary key,
  submitted_at timestamptz not null default now(),
  status text not null default 'Pending',
  name text not null,
  current_class text not null default '',
  dob date,
  gender text not null default '',
  mobile text not null default '',
  email text not null default '',
  address text not null default '',
  school text not null default '',
  board text not null default '',
  previous_percentage numeric(5,2) check (previous_percentage between 0 and 100),
  parent_name text not null default '',
  relationship text not null default '',
  parent_mobile text not null default '',
  parent_whatsapp text not null default '',
  parent_email text not null default '',
  requested_subjects jsonb not null default '[]',
  reviewed_by uuid references public.app_users(id) on delete set null,
  reviewed_at timestamptz,
  reject_reason text not null default '',
  student_id text references public.students(id) on delete set null
);

create index students_name_idx on public.students using gin (to_tsvector('simple', name));
create index attendance_student_date_idx on public.attendance(student_id, session_date desc);
create index attendance_session_idx on public.attendance(session_id);
create index invoices_student_status_idx on public.invoices(student_id, status);
create index payments_student_date_idx on public.payments(student_id, payment_date desc);
create index registrations_status_date_idx on public.registrations(status, submitted_at desc);
create index notices_audience_status_idx on public.notices(audience, status, expires_at);

-- All application tables are private by default. The trusted API layer will use
-- a server-only service credential and enforce role checks before access.
do $$
declare t text;
begin
  foreach t in array array[
    'app_users','settings','subjects','batches','rooms','teachers','students','student_subjects',
    'timetable','class_sessions','attendance','attendance_logs','fee_structure','student_fees',
    'invoices','payments','receipts','discounts','teacher_income','teacher_payments','notices',
    'admin_logs','change_history','registrations'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

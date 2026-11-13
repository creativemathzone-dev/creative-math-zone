-- Free fee reminders and absent alerts.
--  * App push notifications (Web Push, no paid service) to phones where the student
--    app/site is open with notifications allowed.
--  * A one-tap WhatsApp list for the office (wa.me links sent from the centre's own WhatsApp).

-- Server-only secrets (holds the Web Push VAPID key pair, created automatically on first use).
create table if not exists public.app_secrets (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
grant all on public.app_secrets to service_role;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.app_users(id) on delete cascade,
  student_id text references public.students(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  fail_count integer not null default 0
);
create index if not exists push_subscriptions_student_idx on public.push_subscriptions(student_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant all on public.push_subscriptions to service_role;

-- One row per reminder; the unique key stops the same reminder being created twice.
create table if not exists public.reminder_log (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('FEE','ABSENT')),
  student_id text not null references public.students(id) on delete cascade,
  ref_id text not null,
  stage text not null,
  title text not null default '',
  message text not null,
  phone text not null default '',
  push_devices integer not null default 0,
  push_delivered integer not null default 0,
  whatsapp_status text not null default 'PENDING' check (whatsapp_status in ('PENDING','SENT','SKIPPED','NO_PHONE')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_by uuid references public.app_users(id) on delete set null,
  unique (kind, ref_id, student_id, stage)
);
create index if not exists reminder_log_pending_idx on public.reminder_log(whatsapp_status, created_at desc);
alter table public.reminder_log enable row level security;
revoke all on public.reminder_log from anon, authenticated;
grant all on public.reminder_log to service_role;

insert into public.settings (setting_key, value, description)
values ('FEE_REMINDERS_ENABLED', 'TRUE', 'Fee reminders 3 days before, on the due date and weekly while overdue, at 9 AM (TRUE or FALSE)'),
       ('ABSENT_ALERTS_ENABLED', 'TRUE', 'Absent alerts after a class is closed (TRUE or FALSE)')
on conflict (setting_key) do nothing;

-- Never put the push keys or device addresses into backups.
create or replace function public.backup_table_names()
returns setof text language sql security definer set search_path = public as $$
  select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname not in ('google_drive_connections','google_drive_oauth_states','login_rate_limits','registration_rate_limits',
                          'backup_runs','app_secrets','push_subscriptions')
  order by c.relname;
$$;
revoke all on function public.backup_table_names() from public, anon, authenticated;
grant execute on function public.backup_table_names() to service_role;

-- Fee reminders: every day at 09:00 IST (03:30 UTC).
select cron.unschedule(jobid) from cron.job where jobname = 'cmz-fee-reminders';
select cron.schedule(
  'cmz-fee-reminders', '30 3 * * *',
  $$select net.http_post(
    url := 'https://krjkkkwxqvvxeifxmgjx.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_xAhDwzA3EZteyMSM3qooww_S1YlVX36',
      'x-archive-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'homework_archive_secret' limit 1)
    ), body := '{"action":"fees"}'::jsonb,
    timeout_milliseconds := 120000
  );$$
);

-- Absent alerts: every 10 minutes, for classes closed in the last few hours.
select cron.unschedule(jobid) from cron.job where jobname = 'cmz-absent-alerts';
select cron.schedule(
  'cmz-absent-alerts', '*/10 * * * *',
  $$select net.http_post(
    url := 'https://krjkkkwxqvvxeifxmgjx.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_xAhDwzA3EZteyMSM3qooww_S1YlVX36',
      'x-archive-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'homework_archive_secret' limit 1)
    ), body := '{"action":"absent"}'::jsonb,
    timeout_milliseconds := 60000
  );$$
);

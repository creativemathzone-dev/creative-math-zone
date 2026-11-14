-- One login for everyone + an extra lock for admin accounts + "Forgot password?" requests.
--
-- Admin PIN: an admin who sets a PIN must enter it once after every sign-in (password or
-- passkey). The server remembers which sign-in sessions were unlocked; every admin request
-- in every function checks this, so the lock cannot be skipped by signing in another way.

-- 1) Admin PIN (stored only as a bcrypt hash).
alter table public.app_users add column if not exists admin_pin_hash text;

create table if not exists public.admin_pin_sessions (
  session_id uuid primary key,
  app_user_id uuid not null references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists admin_pin_sessions_user_idx on public.admin_pin_sessions(app_user_id);
alter table public.admin_pin_sessions enable row level security;
revoke all on public.admin_pin_sessions from anon, authenticated;
grant all on public.admin_pin_sessions to service_role;

create or replace function public.set_admin_pin(p_user uuid, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.app_users
     set admin_pin_hash = case when coalesce(p_pin, '') = '' then null else crypt(p_pin, gen_salt('bf', 8)) end
   where id = p_user and user_type = 'ADMIN';
  -- Every other device must enter the new PIN.
  delete from public.admin_pin_sessions where app_user_id = p_user;
end; $$;

create or replace function public.check_admin_pin(p_user uuid, p_pin text)
returns boolean language sql security definer set search_path = public, extensions as $$
  select coalesce((select admin_pin_hash is not null and admin_pin_hash = crypt(coalesce(p_pin, ''), admin_pin_hash)
                     from public.app_users where id = p_user), false);
$$;

-- True when this sign-in may use admin features: not an admin, no PIN set, or PIN entered for this session.
create or replace function public.admin_session_ok(p_auth_user uuid, p_session text)
returns boolean language sql security definer set search_path = public as $$
  select coalesce((
    select case when u.user_type <> 'ADMIN' or u.admin_pin_hash is null then true
                else exists (select 1 from public.admin_pin_sessions s where s.app_user_id = u.id and s.session_id::text = coalesce(p_session, '')) end
      from public.app_users u where u.auth_user_id = p_auth_user), true);
$$;

revoke all on function public.set_admin_pin(uuid, text) from public, anon, authenticated;
revoke all on function public.check_admin_pin(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_session_ok(uuid, text) from public, anon, authenticated;
grant execute on function public.set_admin_pin(uuid, text) to service_role;
grant execute on function public.check_admin_pin(uuid, text) to service_role;
grant execute on function public.admin_session_ok(uuid, text) to service_role;

-- 2) "Forgot password?" requests, shown to the admins who can reset that account.
create table if not exists public.password_reset_requests (
  id text primary key,
  app_user_id uuid not null references public.app_users(id) on delete cascade,
  username text not null,
  user_type text not null,
  linked_id text,
  note text not null default '',
  status text not null default 'PENDING' check (status in ('PENDING', 'DONE', 'DISMISSED')),
  created_at timestamptz not null default now(),
  handled_by uuid references public.app_users(id) on delete set null,
  handled_at timestamptz
);
create index if not exists password_reset_requests_status_idx on public.password_reset_requests(status, created_at desc);
alter table public.password_reset_requests enable row level security;
revoke all on public.password_reset_requests from anon, authenticated;
grant all on public.password_reset_requests to service_role;

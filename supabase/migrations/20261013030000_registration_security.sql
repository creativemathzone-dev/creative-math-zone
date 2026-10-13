-- Keep a pending applicant's chosen password inside Supabase Auth.
-- The registration row stores only the linked Auth ID, never a password or password hash.
alter table public.registrations
  add column if not exists registration_auth_user_id uuid references auth.users(id) on delete set null;

create table if not exists public.registration_rate_limits (
  rate_key text primary key,
  window_started_at timestamptz not null default now(),
  hit_count integer not null default 0 check (hit_count >= 0)
);
alter table public.registration_rate_limits enable row level security;

create or replace function public.consume_registration_limit(p_rate_key text, p_window_seconds integer, p_max_hits integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_hits integer;
begin
  if p_rate_key !~ '^[a-f0-9]{64}$' or p_window_seconds < 1 or p_window_seconds > 86400
    or p_max_hits < 1 or p_max_hits > 1000 then
    raise exception 'Invalid registration rate limit parameters';
  end if;

  insert into public.registration_rate_limits(rate_key, window_started_at, hit_count)
  values (p_rate_key, now(), 1)
  on conflict (rate_key) do update
    set window_started_at = case
          when public.registration_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= now() then now()
          else public.registration_rate_limits.window_started_at
        end,
        hit_count = case
          when public.registration_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= now() then 1
          else public.registration_rate_limits.hit_count + 1
        end
  returning hit_count into current_hits;

  return current_hits <= p_max_hits;
end;
$$;

revoke all on function public.consume_registration_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_registration_limit(text, integer, integer) to service_role;

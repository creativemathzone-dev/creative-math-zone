-- Keep repeated password guesses from reaching Supabase Auth indefinitely.
-- Only the trusted Edge Function service role can use these hashed keys.
create table if not exists public.login_rate_limits (
  rate_key text primary key check (rate_key ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null default now(),
  hit_count integer not null default 0 check (hit_count >= 0),
  last_attempt_at timestamptz not null default now()
);

alter table public.login_rate_limits enable row level security;
revoke all on table public.login_rate_limits from public, anon, authenticated;
grant all on table public.login_rate_limits to service_role;
create index if not exists login_rate_limits_last_attempt_idx on public.login_rate_limits (last_attempt_at);

create or replace function public.consume_login_rate_limit(p_rate_key text, p_window_seconds integer, p_max_hits integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_hits integer;
begin
  if p_rate_key is null or p_rate_key !~ '^[a-f0-9]{64}$'
    or p_window_seconds is null or p_window_seconds < 60 or p_window_seconds > 14400
    or p_max_hits is null
    or p_max_hits < 3 or p_max_hits > 20 then
    raise exception 'Invalid login rate limit parameters';
  end if;

  insert into public.login_rate_limits(rate_key, window_started_at, hit_count, last_attempt_at)
  values (p_rate_key, now(), 1, now())
  on conflict (rate_key) do update
    set window_started_at = case
          when public.login_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= now() then now()
          else public.login_rate_limits.window_started_at
        end,
        hit_count = case
          when public.login_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= now() then 1
          else public.login_rate_limits.hit_count + 1
        end,
        last_attempt_at = now()
  returning hit_count into current_hits;

  delete from public.login_rate_limits where last_attempt_at < now() - interval '1 day';
  return current_hits <= p_max_hits;
end;
$$;

create or replace function public.clear_login_rate_limit(p_rate_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_rate_key is null or p_rate_key !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid login rate limit key';
  end if;
  delete from public.login_rate_limits where rate_key = p_rate_key;
end;
$$;

revoke all on function public.consume_login_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_login_rate_limit(text, integer, integer) to service_role;
revoke all on function public.clear_login_rate_limit(text) from public, anon, authenticated;
grant execute on function public.clear_login_rate_limit(text) to service_role;

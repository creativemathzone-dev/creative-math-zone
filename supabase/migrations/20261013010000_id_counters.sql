-- Generate readable IDs without collisions when multiple staff add records at once.
create table public.id_counters (
  counter_name text primary key,
  last_value bigint not null default 0 check (last_value >= 0)
);

alter table public.id_counters enable row level security;

create or replace function public.next_id(p_counter_name text, p_prefix text, p_width integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  next_value bigint;
begin
  if p_counter_name !~ '^[a-z_]{1,40}$' or p_width < 1 or p_width > 12 or length(p_prefix) > 80 then
    raise exception 'Invalid ID counter parameters';
  end if;

  insert into public.id_counters(counter_name, last_value)
  values (p_counter_name, 1)
  on conflict (counter_name) do update set last_value = id_counters.last_value + 1
  returning last_value into next_value;

  return p_prefix || lpad(next_value::text, p_width, '0');
end;
$$;

revoke all on function public.next_id(text, text, integer) from public, anon, authenticated;
grant execute on function public.next_id(text, text, integer) to service_role;

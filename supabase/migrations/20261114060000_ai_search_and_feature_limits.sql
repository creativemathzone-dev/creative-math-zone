-- AI search bar + a separate daily AI limit for each feature (all free, Gemini free tier).
-- The search AI only turns a question into one of a fixed list of safe, read-only searches.
-- Names are replaced with placeholders before the question is sent; results come from the database.

-- Per-feature counters (the overall counter stays in ai_usage).
create table if not exists public.ai_feature_usage (
  day date not null,
  feature text not null,
  calls integer not null default 0,
  primary key (day, feature)
);
alter table public.ai_feature_usage enable row level security;
revoke all on public.ai_feature_usage from anon, authenticated;
grant all on public.ai_feature_usage to service_role;

-- Take one call from today's allowance: both the feature limit and the overall limit must allow it.
create or replace function public.ai_take_feature(p_feature text, p_feature_limit integer, p_total_limit integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_day date := (now() at time zone 'Asia/Kolkata')::date; v_total integer; v_feature integer;
begin
  insert into public.ai_usage(day, calls) values (v_day, 0) on conflict (day) do nothing;
  insert into public.ai_feature_usage(day, feature, calls) values (v_day, p_feature, 0) on conflict (day, feature) do nothing;
  select calls into v_total from public.ai_usage where day = v_day for update;
  select calls into v_feature from public.ai_feature_usage where day = v_day and feature = p_feature for update;
  if v_total >= greatest(p_total_limit, 0) or v_feature >= greatest(p_feature_limit, 0) then return false; end if;
  update public.ai_usage set calls = calls + 1 where day = v_day;
  update public.ai_feature_usage set calls = calls + 1 where day = v_day and feature = p_feature;
  return true;
end; $$;
revoke all on function public.ai_take_feature(text, integer, integer) from public, anon, authenticated;
grant execute on function public.ai_take_feature(text, integer, integer) to service_role;

-- Give a call back when the AI failed (failed tries never use up the allowance).
create or replace function public.ai_refund_feature(p_feature text)
returns void language plpgsql security definer set search_path = public as $$
declare v_day date := (now() at time zone 'Asia/Kolkata')::date;
begin
  update public.ai_usage set calls = calls - 1 where day = v_day and calls > 0;
  update public.ai_feature_usage set calls = calls - 1 where day = v_day and feature = p_feature and calls > 0;
end; $$;
revoke all on function public.ai_refund_feature(text) from public, anon, authenticated;
grant execute on function public.ai_refund_feature(text) to service_role;

-- Same question (with names already hidden) on the same day = no new AI call.
create table if not exists public.ai_search_cache (
  day date not null,
  question_key text not null,
  plan jsonb not null,
  created_at timestamptz not null default now(),
  primary key (day, question_key)
);
alter table public.ai_search_cache enable row level security;
revoke all on public.ai_search_cache from anon, authenticated;
grant all on public.ai_search_cache to service_role;

insert into public.settings (setting_key, value, description)
values ('AI_SEARCH_ENABLED', 'TRUE', 'AI search bar for admin and teachers (TRUE or FALSE)'),
       ('AI_LIMIT_SEARCH', '50', 'AI search bar: maximum AI questions per day'),
       ('AI_LIMIT_WORKSHEETS', '20', 'Worksheet maker: maximum AI papers per day (Set B counts as one)'),
       ('AI_LIMIT_DOUBTS', '20', 'Doubt AI drafts: maximum per day')
on conflict (setting_key) do nothing;

-- The overall cap now covers all AI features together. Raise the old default (40) so the
-- per-feature limits fit; a value the admin already changed is left alone.
update public.settings set value = '100' where setting_key = 'AI_DAILY_LIMIT' and value = '40';
update public.settings set description = 'Overall maximum AI uses per day, all features together (safety cap for the free quota)' where setting_key = 'AI_DAILY_LIMIT';

-- Free AI drafts for doubts (Google Gemini free tier, no billing).
-- Teachers ask for a draft; it is shown only to teachers/admin and must be
-- checked and posted by a teacher. Only the question text and photos are sent.

create table if not exists public.doubt_ai_drafts (
  doubt_id text primary key references public.doubts(id) on delete cascade,
  status text not null default 'OK' check (status in ('OK','FAILED')),
  body text not null default '',
  model text not null default '',
  error text not null default '',
  requested_by text not null default '',
  created_at timestamptz not null default now()
);
alter table public.doubt_ai_drafts enable row level security;
revoke all on public.doubt_ai_drafts from anon, authenticated;
grant all on public.doubt_ai_drafts to service_role;

-- Daily usage counter so the free quota is never exceeded.
create table if not exists public.ai_usage (
  day date primary key,
  calls integer not null default 0
);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;
grant all on public.ai_usage to service_role;

-- Atomically take one call from today's allowance (India date). Returns false when the cap is reached.
create or replace function public.ai_take(p_limit integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_day date := (now() at time zone 'Asia/Kolkata')::date; v_calls integer;
begin
  insert into public.ai_usage(day, calls) values (v_day, 0) on conflict (day) do nothing;
  update public.ai_usage set calls = calls + 1 where day = v_day and calls < greatest(p_limit, 0) returning calls into v_calls;
  return v_calls is not null;
end; $$;
revoke all on function public.ai_take(integer) from public, anon, authenticated;
grant execute on function public.ai_take(integer) to service_role;

insert into public.settings (setting_key, value, description)
values ('AI_DOUBT_DRAFTS_ENABLED', 'TRUE', 'Teachers can ask the free AI for a draft solution to a doubt (TRUE or FALSE)'),
       ('AI_DAILY_LIMIT', '40', 'Maximum AI drafts per day, to stay inside the free quota'),
       ('AI_MODEL', 'gemini-flash-latest', 'Google Gemini model used for AI drafts')
on conflict (setting_key) do nothing;

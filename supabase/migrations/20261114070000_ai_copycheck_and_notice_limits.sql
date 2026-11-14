-- Daily limits for the AI copy-checking helper and the AI notice writer (free Gemini tier).
-- Copy-check photos are sent to the AI once and never stored (no Supabase Storage, no Drive).
insert into public.settings (setting_key, value, description)
values ('AI_LIMIT_COPYCHECK', '30', 'AI copy checking: maximum answer sheets per day'),
       ('AI_LIMIT_NOTICES', '3', 'AI notice writer: maximum drafts per day')
on conflict (setting_key) do nothing;

-- Seed a clean installation with editable centre settings and safe defaults.
insert into public.settings (setting_key, value, description)
values
  ('CENTRE_NAME', 'Creative Math Zone', 'Centre name shown in portals and receipts'),
  ('ACADEMIC_YEAR', '2026-27', 'Current academic year (yyyy-yy)'),
  ('ADDRESS', '', 'Centre address shown on receipts'),
  ('MOBILE', '', 'Centre contact numbers'),
  ('EMAIL', '', 'Centre contact email'),
  ('WEBSITE', 'creativemathzone.in', 'Centre website'),
  ('TAGLINE', 'Eat Math, Drink Math, Dream Math', 'Centre tagline'),
  ('LOGO_URL', '', 'Public URL of the centre logo'),
  ('STUDENT_ID_PREFIX', 'CMZ', 'Prefix for new student IDs'),
  ('ATTENDANCE_CODE_MINUTES', '5', 'Minutes an attendance code remains valid'),
  ('SESSION_TIMEOUT_MINUTES', '30', 'Automatic logout after idle minutes'),
  ('LOGIN_MAX_ATTEMPTS', '5', 'Wrong passwords allowed before temporary lockout'),
  ('LOGIN_LOCK_MINUTES', '15', 'Temporary account lockout duration in minutes'),
  ('LATE_FEE_ENABLED', 'FALSE', 'Whether late fees are enabled'),
  ('REGISTRATION_ENABLED', 'TRUE', 'Whether online registration is enabled'),
  ('REGISTRATION_MAX_PER_HOUR', '15', 'Maximum online registration requests per hour'),
  ('LOCATION_CHECK_ENABLED', 'TRUE', 'Whether location checks are enabled for attendance'),
  ('SUBJECT_BLOCKED_PAIRS', '', 'Subject ID pairs that cannot be taken together')
on conflict (setting_key) do nothing;

# Static web portal

These pages are the new static copies of the Admin, Teacher, and Student portals. They send API requests to the Supabase Edge Function.

Before publishing, replace `PASTE_YOUR_SUPABASE_PUBLISHABLE_KEY_HERE` in `config.js` with the project's **publishable key**. Never use a secret or service-role key in this file. The publishable key is intended for browser use; the server still checks login and permissions.

The Edge Function must be deployed and the remaining SQL migrations applied before these pages can sign in. Keep the Apps Script site available until the new site has been fully checked and data has been migrated.

# Static web portal

These pages are the new static copies of the Admin, Teacher, and Student portals. They send API requests to the Supabase Edge Function.

`config.js` is already configured with the project's **publishable key**. Never put a secret or service-role key in this file. The publishable key is intended for browser use; the server still checks login and permissions.

The Edge Function is deployed and all SQL migrations have been applied. Create and link the first admin account before publishing and signing in. Keep the Apps Script site available until the new site has been fully checked and data has been migrated.

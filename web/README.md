# Static web portal

These pages are the new static copies of the Admin, Teacher, and Student portals. They send API requests to the Supabase Edge Function.

`config.js` is already configured with the project's **publishable key**. Never put a secret or service-role key in this file. The publishable key is intended for browser use; the server still checks login and permissions.

Shared scripts: `doubts.js` (Doubts portal), `push.js` (fee/absent alerts), `passkeys.js`, `pwa.js` and `service-worker.js` (installable app, notifications). After changing a cached script, raise `CACHE_NAME` in `service-worker.js` so phones pick up the new version.

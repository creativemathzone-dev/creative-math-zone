# Supabase project bootstrap

These steps are for a new, empty Supabase project. They do not copy or modify the live Apps Script spreadsheet.

1. Create a Supabase project and keep its database password and secret keys out of source control.
2. Apply `supabase/migrations/20261013000000_initial_schema.sql` in the Supabase SQL editor or with the Supabase CLI.
3. In Supabase Auth, create the first admin's account using the email address they will use for recovery.
4. Link that Auth user to an application account in the SQL editor, substituting the new Auth user UUID and chosen username:

   ```sql
   insert into public.app_users (auth_user_id, username, user_type, role, status)
   values ('AUTH-USER-UUID', 'admin', 'ADMIN', 'SUPER_ADMIN', 'Active');
   ```

5. Store project secrets in Supabase, deploy the `api` Edge Function, then configure the frontend URL and custom-domain DNS after a frontend host is selected.

The function expects Supabase's `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` maps, which Supabase provides in deployed Edge Function runtimes. A secret key bypasses RLS, so only the server function may use it. For local function serving, copy `.env.example` to `supabase/functions/.env` and replace the placeholders with local-only keys.

The function is an incomplete migration slice. Do not point the production domain at it yet: the existing portals call many actions that have not been ported.

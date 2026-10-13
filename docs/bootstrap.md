# Supabase project bootstrap

These steps are for a new, empty Supabase project. They do not copy or modify the live Apps Script spreadsheet.

1. Create a Supabase project and keep its database password and secret keys out of source control.
2. Apply migrations in filename order. The project owner has already applied `20261013000000_initial_schema.sql` and `20261013010000_id_counters.sql`. Before deploying the API, also apply `20261013020000_default_settings.sql`, `20261013030000_registration_security.sql`, `20261013040000_finance_transactions.sql`, and `20261013050000_attendance_constraints.sql`.
3. In Supabase Auth, create the first admin's account using the email address they will use for recovery.
4. Link that Auth user to an application account in the SQL editor, substituting the new Auth user UUID and chosen username:

   ```sql
   insert into public.app_users (auth_user_id, username, user_type, role, status)
   values ('AUTH-USER-UUID', 'admin', 'ADMIN', 'SUPER_ADMIN', 'Active');
   ```

5. Store project secrets in Supabase, deploy the `api` Edge Function, then configure the frontend URL and custom-domain DNS after a frontend host is selected.

The function expects Supabase's `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` maps, which Supabase provides in deployed Edge Function runtimes. A secret key bypasses RLS, so only the server function may use it. For local function serving, copy `.env.example` to `supabase/functions/.env` and replace the placeholders with local-only keys.

Public registration creates an Auth identity immediately and stores only its Auth user ID on the pending registration. This lets the applicant keep the password they chose without putting a password or password hash in the application database. Approval links that identity to the new student; rejection deletes it. The registration rate-limit RPC and Auth ID column are created by `20261013030000_registration_security.sql`.

Finance writes that affect an invoice, payment, or receipt use database transactions so concurrent payments cannot overpay an invoice or leave its receipt and balance out of sync. Those transaction functions are created by `20261013040000_finance_transactions.sql`.

The function is an incomplete migration slice. Do not point the production domain at it yet: the existing portals call many actions that have not been ported.

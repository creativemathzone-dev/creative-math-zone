# Supabase project bootstrap

These steps are for a new, empty Supabase project. They do not copy or modify the live Apps Script spreadsheet.

1. Create a Supabase project and keep its database password and secret keys out of source control.
2. Apply migrations in filename order. The project owner has already applied `20261013000000_initial_schema.sql` and `20261013010000_id_counters.sql`. Before deploying the API, also apply `20261013020000_default_settings.sql`, `20261013030000_registration_security.sql`, `20261013040000_finance_transactions.sql`, `20261013050000_attendance_constraints.sql`, and `20261013060000_teacher_payment_transaction.sql`.
3. In Supabase Auth, create the first admin's account using the email address they will use for recovery.
4. Link that Auth user to an application account in the SQL editor, substituting the new Auth user UUID and chosen username:

   ```sql
   insert into public.app_users (auth_user_id, username, user_type, role, status)
   values ('AUTH-USER-UUID', 'admin', 'ADMIN', 'SUPER_ADMIN', 'Active');
   ```

5. Put only the project's **publishable key** in `web/config.js`. Never put a secret or service-role key in browser files.
6. Store the server-side keys in Supabase and deploy the `api` Edge Function. Publish the `web/` folder on a static host after its pages are ready.
7. Leave `creativemathzone.in` pointed at the existing site until the new pages and migrated data have been checked.

The function expects Supabase's `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` maps, which Supabase provides in deployed Edge Function runtimes. A secret key bypasses RLS, so only the server function may use it. For local function serving, copy `.env.example` to `supabase/functions/.env` and replace the placeholders with local-only keys.

Public registration creates an Auth identity immediately and stores only its Auth user ID on the pending registration. This lets the applicant keep the password they chose without putting a password or password hash in the application database. Approval links that identity to the new student; rejection deletes it. The registration rate-limit RPC and Auth ID column are created by `20261013030000_registration_security.sql`.

Finance writes that affect an invoice, payment, or receipt use database transactions so concurrent payments cannot overpay an invoice or leave its receipt and balance out of sync. Those transaction functions are created by `20261013040000_finance_transactions.sql`.

The new portal pages are prepared but not deployed. Apply all migrations and deploy the function before trying to sign in. Do not point the production domain at the new site until the pages and migrated data have been checked.

# Creative Math Zone

This repository is the new home for the Creative Math Zone class management app. The original Apps Script source is preserved in [`legacy-appscript/`](legacy-appscript/) as the migration reference.

## Direction

- GitHub stores and versions the application code.
- Supabase PostgreSQL is the planned system of record.
- The existing admin, teacher, student, attendance, fee, invoice, and receipt workflows are the migration scope.
- The database starts empty. The old Apps Script and Google Sheet remain untouched until a separately planned data import and cutover.
- `creativemathzone.in` can be connected after a hosting provider is selected and the production app is ready.

The supplied Apps Script has 24 logical data tables and a single action-based API. One hundred students by itself is not a meaningful capacity problem for Apps Script; the reasons to move are relational integrity, concurrent writes, maintainability, and a clearer deployment path. A PostgreSQL-backed application can handle this workload comfortably.

## Database foundation

The initial schema is in [`supabase/migrations/20261013000000_initial_schema.sql`](supabase/migrations/20261013000000_initial_schema.sql). It defines the core relational model and enables row-level security on application data. The server-side action router in `supabase/functions/api/` covers configuration and authentication, student and teacher records, registrations, master data, timetable and notices, fee structures and discounts, invoices/payments/receipts, teacher income, reports, attendance, and the portal reads. The browser-ready copies are in [`web/`](web/) and call the Supabase Edge Function; the original files in `legacy-appscript/` remain the migration reference. The new pages are not deployed yet.

The initial schema and seven database migrations have been applied to the user's Supabase project. A new migration, `20261013070000_login_rate_limits.sql`, adds login attempt throttling and must be applied before the API is deployed. Follow [`docs/bootstrap.md`](docs/bootstrap.md) for beginner-friendly setup steps.

## Legacy reference

`legacy-appscript/` contains the supplied Apps Script files and portal pages, retained to map existing screens, actions, validations, and business rules.

## Next implementation steps

1. Apply `20261013070000_login_rate_limits.sql` in the Supabase SQL Editor.
2. Create and link the first admin account.
3. Run the manual `Deploy Supabase API` workflow; the scoped token is stored as a GitHub Actions secret.
4. Enable GitHub Pages with the Actions source, then run the manual `Publish Creative Math Zone portal` workflow.
5. Check every portal and permission against the empty project, then fix any issues before use.
6. Prepare and verify a Google Sheets export/import before cutover. Keep the Apps Script site live until the new site and migrated data are ready.

Never put a Supabase secret key in browser code or commit secrets to GitHub.

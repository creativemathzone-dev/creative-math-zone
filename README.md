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

The initial schema is in [`supabase/migrations/20261013000000_initial_schema.sql`](supabase/migrations/20261013000000_initial_schema.sql). It defines the core relational model and enables row-level security on application data. The server-side action router in `supabase/functions/api/` now covers configuration and authentication, student and teacher records, registrations, master data, timetable and notices, fee structures and student discounts, invoices/payments/receipts, student and teacher portal reads, and core class attendance actions. Finance payment/receipt updates run through database transactions. The Apps Script pages still call `google.script.run`, so they are reference screens and are not yet connected to the Supabase backend.

The first two database migrations (`20261013000000_initial_schema.sql` and `20261013010000_id_counters.sql`) have already been applied to the user's Supabase project. The remaining migrations, including `20261013050000_attendance_constraints.sql`, must be applied in filename order before deploying the latest API. Follow [`docs/bootstrap.md`](docs/bootstrap.md) for beginner-friendly setup steps.

## Legacy reference

`legacy-appscript/` contains the supplied Apps Script files and portal pages, retained to map existing screens, actions, validations, and business rules.

## Next implementation steps

1. Finish remaining admin workflows such as teacher income management and reports.
2. Port the existing portals off `google.script.run` and connect them to the Supabase API.
3. Apply the remaining migrations, deploy the Edge Function, and configure a static host.
4. Exercise the app against a non-production Supabase project.
5. Prepare and verify a Google Sheets export/import before cutover.

Never put a Supabase secret key in browser code or commit secrets to GitHub.

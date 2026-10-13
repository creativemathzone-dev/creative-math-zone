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

The initial schema is in [`supabase/migrations/20261013000000_initial_schema.sql`](supabase/migrations/20261013000000_initial_schema.sql). It defines the core relational model and enables row-level security on application data. The first server-side action router is in `supabase/functions/api/`; it currently covers configuration, login/session identity, password changes, settings and master-data lookups, master-data add/edit, and read-only student lookup. Student/teacher account creation, attendance, finance, registrations, notices, and reports still need to be migrated before this can replace Apps Script. The ID-counter migration must be applied before using master-data add actions.

## Legacy reference

`legacy-appscript/` contains an unchanged copy of the files supplied for the migration. Do not deploy it as the new backend. It is retained to map existing screens, actions, validations, and business rules.

## Next implementation steps

1. Review the schema against the real workflows and decide the deployment host for the web app/API.
2. Implement authentication, server-side role checks, and the API that replaces `google.script.run`.
3. Port the existing portals to call that API.
4. Exercise the application against a non-production Supabase project.
5. Prepare and verify a Google Sheets export/import before cutover.

Never put a Supabase secret key in browser code or commit secrets to GitHub.

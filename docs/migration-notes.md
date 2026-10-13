# Migration notes

## API replacement

The legacy portals expect an action API with the shape `api(action, payload)`. Preserve those action names where practical so each screen can be moved incrementally. The new request should carry a Supabase access token in `Authorization: Bearer <token>` and a JSON body containing `action` and `payload`. Responses should retain `{ ok, data }` and `{ ok, code, error }` so the current screens can keep their error handling while the transport changes.

Authorization must be enforced in trusted server code for every action. Hiding controls in the browser is only a usability feature. The service-role key must remain on the server. RLS is enabled and has no browser access policies in the initial migration, so a not-yet-implemented API cannot accidentally expose records through the public key.

## Data and account migration

The new schema is empty by design. The Apps Script spreadsheet has not been provided, so this work has not read or copied student records. Before import, export each sheet as CSV, retain the original IDs, map headers to the new column names, and validate foreign keys and money totals in a staging project.

The old app stores its own password hashes and session tokens. Those are not Supabase Auth credentials. Plan an account activation/password reset for existing users during cutover rather than copying old hashes into `app_users`. New public registrations use Supabase Auth directly; pending registration rows contain no password or password hash.

## Original data areas

The migration starts with 24 logical areas from the Apps Script schema: settings, users, students, student subjects, teachers, subjects, batches, rooms, timetable, class sessions, attendance, attendance logs, fee structure, student fees, invoices, payments, receipts, discounts, teacher income, teacher payments, notices, admin logs, change history, and registrations.

# Automatic invoices and weekly backups (free)

Both run on Supabase's built-in scheduler (`pg_cron` + `pg_net`, included in the
free plan) and use the Google Drive account connected in **Admin → Settings →
Homework file archive**. Nothing here needs a paid plan.

## Automatic invoices

- Runs on the **1st of every month at 6:00 AM IST** and generates that month's
  invoices with exactly the same rules as the **Generate invoices** button.
- Students who already have an invoice for the month are skipped, so running the
  button again later (for students added mid-month) is safe.
- Result is written to **Activity log** as `AUTO_GENERATE_INVOICES` (user `system`).
- Turn off: set `AUTO_INVOICE_ENABLED` to `FALSE` in Admin → Settings.

## Weekly backup

- Runs every **Sunday at 2:00 AM IST**. Super Admin can also click
  **Back up now** in Admin → Settings → Database backups.
- Saves one file `cmz-backup-YYYY-MM-DD-xxxx.json.gz` to the Drive folder
  **Creative Math Zone Backups**. The newest 8 backups are kept; older ones are deleted.
- Contains every row of every app table (students, subjects, attendance, invoices,
  payments, receipts, homework, doubts, settings, logs …).
- **Not included:** login passwords (they live in Supabase Auth — users reset them
  after a restore), Google Drive tokens, and uploaded files (those are already in Drive).
- Turn off: set `AUTO_BACKUP_ENABLED` to `FALSE`.
- Keep the Drive account private. The file contains student personal data.

## Restoring (only if something goes badly wrong)

1. Download the backup from Admin → Settings → Database backups (or from Drive).
2. Unzip it (7-Zip on Windows opens `.gz`). It is plain JSON: `{ "tables": { "students": [ … ], … } }`.
3. To restore single records, copy them from the JSON. For a full restore, create a
   fresh Supabase project, run every file in `supabase/migrations/` in order, then
   import each table's rows (ask for help — the order matters because of foreign keys).

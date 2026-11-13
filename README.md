# Creative Math Zone

Class management system for Creative Math Zone: admin, teacher and student portals
for students, subjects, timetable, attendance, homework, doubts, fees, invoices,
receipts, teacher income, notices and reports.

Live site: https://creativemathzone.in/

## How it is built

- **Website** – static pages in [`web/`](web/), published to GitHub Pages by the
  manual **Publish Creative Math Zone portal** workflow. Android apps are served from
  [`downloads/`](downloads/README.md) (files kept in the `apps` GitHub Release).
- **Server** – Supabase Edge Functions in [`supabase/functions/`](supabase/functions/)
  (`api`, `notify`, `doubt-files`, `backup-drive`, `homework-drive`,
  `google-drive-oauth`, `cleanup-class-materials`), deployed by the manual
  **Deploy Supabase API** workflow.
- **Database** – Supabase PostgreSQL. Schema changes are in
  [`supabase/migrations/`](supabase/migrations/) and are run by hand in the Supabase
  SQL Editor (the workflows do not apply them).
- **Files** – homework files, doubt photos and weekly backups go to the centre's
  connected Google Drive.

## Automatic jobs (free, Supabase scheduler)

| Job | When |
|---|---|
| Close finished classes, mark absentees | every minute |
| Absent alerts | every 10 minutes |
| Fee reminders | daily 9 AM IST |
| Monthly invoices | 1st of month, 6 AM IST |
| Database backup to Google Drive | Sunday 2 AM IST |
| Move homework files / doubt photos to Drive | hourly |

Each can be switched off in Admin → Settings. See
[`docs/backups-and-auto-invoices.md`](docs/backups-and-auto-invoices.md).

## Checks

`node --test tests/critical-flows.test.mjs` (or `deno test --allow-read tests/`) runs
before every deploy.

## History

The system was migrated from a Google Apps Script app. That original source was
retired from this repository; it is preserved in git under the tag
`legacy-appscript-archive` (`git checkout legacy-appscript-archive -- legacy-appscript`
restores it).

Never put a Supabase secret key in browser code or commit secrets to GitHub.

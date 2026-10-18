# Homework attachments and Google Drive archive setup

Homework files are private. Teachers may attach up to five PDF/JPG/PNG/DOCX
files to an assignment; students may attach up to five files to a submission.
Each file is limited to 10 MB. Files are archived after the assignment deadline.
The worker deletes a Supabase object only after Google Drive accepts the upload.
If the connection is missing or upload fails, the Supabase copy stays and the
worker retries on its next hourly run. Homework and submission records remain
in the portal. Teachers can permanently delete a file from its homework page.

## One-time Supabase setup

1. In Supabase Dashboard → SQL Editor, run the complete migration
   `supabase/migrations/20261018000000_homework_file_archive.sql`.
2. In Google Cloud Console, enable the Google Drive API and create an OAuth
   client of type **Web application**. Add this authorized redirect URI:
   `https://krjkkkwxqvvxeifxmgjx.supabase.co/functions/v1/google-drive-oauth`
   The app requests `openid`, `email`, and `https://www.googleapis.com/auth/drive.file`.
3. In Supabase → Edge Functions → Secrets, add:
   - `GOOGLE_DRIVE_CLIENT_ID`: the OAuth client ID
   - `GOOGLE_DRIVE_CLIENT_SECRET`: the OAuth client secret
   - `GOOGLE_DRIVE_REDIRECT_URI`: the exact redirect URI above
   - `GOOGLE_DRIVE_CONNECT_RETURN_URL`: `https://creativemathzone.in/web/admin.html`
   - `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY`: base64 encoding of a random 32-byte key
   - `HOMEWORK_ARCHIVE_CRON_SECRET`: a separate random secret string
4. Store the same `HOMEWORK_ARCHIVE_CRON_SECRET` in Supabase Vault as a secret
   named `homework_archive_secret`. In SQL Editor, run this after replacing the
   placeholder with the same random value entered in Edge Function Secrets:
   ```sql
   select vault.create_secret('REPLACE_WITH_HOMEWORK_ARCHIVE_CRON_SECRET',
     'homework_archive_secret', 'Authorization for the hourly homework archive worker');
   ```
   The migration schedules the hourly archive worker and reads this value from Vault.
5. Run the **Deploy Supabase API** workflow to deploy `google-drive-oauth` and
   `homework-drive` with the existing API.
6. Sign into Admin as Super Admin → Settings → Homework file archive →
   **Connect / change Google account**. Sign in with the centre-owned account
   and approve access. Older accounts stay connected for existing archives.

## Changing the Google account

Connect the replacement account in Admin Settings. Use **Transfer archive and
disconnect** beside an older account to copy its archived files into the new
account. Transfers run in batches of 50; repeat until the old connection
disconnects automatically. Each new Drive copy is confirmed before the old
copy is deleted or the app record is changed.

Google Drive quota comes from the connected account. This implementation
archives into that account's My Drive; it does not use organization shared
drives.

# Free database backup

This backup utility is separate from the Google Drive homework archive. It only
reads the database and writes a timestamped ZIP; it does not deploy code or
change the live project.

## Create a backup on Windows

1. Install the Supabase CLI and Docker Desktop. Start Docker Desktop.
2. In Supabase Dashboard, open the project and click **Connect**. Copy the
   PostgreSQL connection string. Keep it private; it contains the database
   password. Do not paste it into chat or save it in this repository.
3. Make a private folder in the centre's Google Drive for desktop, for example
   `Creative Math Zone/Database Backups`. If Drive for desktop is not installed,
   choose a local folder and upload the ZIP to Drive afterward.
4. From the repository folder, run in PowerShell:

   ```powershell
   .\scripts\backup-supabase.ps1 -Destination "D:\Google Drive\Creative Math Zone\Database Backups"
   ```

   Replace the example path with the actual private folder path. The script
   prompts for the database connection string with hidden input. The connection
   string is not written to a file. The resulting ZIP contains `roles.sql`,
   `schema.sql`, `data.sql`, and a manifest.
5. Check that the ZIP appears in Drive and keep more than one dated copy. Google
   Drive storage is shared with Gmail and Photos; monitor available space.

## Important restore limits

- This is a logical export of the database schemas and data supported by
  Supabase CLI. It is not a one-click restore. Follow the current Supabase
  restore guide and restore to a new project first; do not experiment on the
  live production database.
- Supabase CLI excludes managed `auth` and `storage` schemas from its default
  dump. Supabase Auth identities therefore are not included in this ZIP. The
  app's uploaded homework PDFs are handled separately by the existing Google
  Drive homework archive. Confirm the new project's Auth configuration and
  user-account recovery plan before treating a restore as complete.
- A ZIP created by this script is not password-encrypted. Store it in a Drive
  folder shared only with trusted centre administrators. Do not place it in a
  public GitHub repository or share link.
- Google Drive's free storage allowance is shared across Drive, Gmail, and
  Photos. This method uses free Supabase CLI/Docker and the centre's existing
  Drive quota; it does not create Supabase automatic backups or guarantee that
  the Drive account will remain within its free quota.

## Recovery

For recovery, first create a separate Supabase project and follow Supabase's
official [Backup and Restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
instructions. Have the repository migrations available and plan how to recreate
or recover Auth users, then verify the restored project before switching the
website to it. Do not run restore commands against the current production
database.

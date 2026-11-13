# Android apps (APK)

The four APK files are **not stored in the code** any more. They live in the
GitHub Release named **apps**:
https://github.com/creativemathzone-dev/creative-math-zone/releases/tag/apps

When the **Publish Creative Math Zone portal** workflow runs, it copies them into
`downloads/`, so the website links stay the same:

- https://creativemathzone.in/downloads/CreativeMathZone.apk
- https://creativemathzone.in/downloads/CreativeMathZoneStudent.apk
- https://creativemathzone.in/downloads/CreativeMathZoneTeacher.apk
- https://creativemathzone.in/downloads/CreativeMathZoneAdmin.apk

## Updating an app

1. Build the new APK with the **same file name**.
2. Upload it over the old one:
   `gh release upload apps CreativeMathZoneStudent.apk --clobber`
   (or on GitHub: Releases → apps → Edit → delete the old file → attach the new one).
3. Run **Actions → Publish Creative Math Zone portal → Run workflow**.

APK files placed in this folder locally are ignored by git.

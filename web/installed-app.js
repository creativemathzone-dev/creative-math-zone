(() => {
  // Download buttons always stay visible (people must be able to download updates again).
  // After a tap, a short "download started" note appears under the button.
  const downloads = [
    ['cmz-apk-download', 'cmz-apk-installed'],
    ['apk-download', 'apk-installed'],
    ['student-apk-download', 'student-apk-installed'],
    ['teacher-apk-download', 'teacher-apk-installed'],
    ['admin-apk-download', 'admin-apk-installed'],
  ];
  // Older versions of this page hid the buttons forever after one download; forget that.
  try {
    ['cmz-cmz-apk-download-started', 'cmz-main-apk-download-started-v2', 'cmz-main-apk-download-started', 'cmz-student-apk-download-started',
      'cmz-teacher-apk-download-started', 'cmz-admin-apk-download-started'].forEach((key) => localStorage.removeItem(key));
  } catch {}
  downloads.forEach(([linkId, messageId]) => {
    const link = document.getElementById(linkId), message = document.getElementById(messageId);
    if (!link || !message) return;
    link.hidden = false;
    message.hidden = true;
    link.addEventListener('click', () => { message.hidden = false; });
  });
})();

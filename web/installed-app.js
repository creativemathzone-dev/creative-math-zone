(() => {
  const APK_DOWNLOAD_KEY = 'cmz-apk-download-started';
  const apkLink = document.getElementById('android-apk-link');
  const apkDownload = document.getElementById('apk-download');
  const installedMessage = document.getElementById('android-app-installed');
  const installedPageMessage = document.getElementById('apk-installed');
  const sourceNote = document.getElementById('apk-source-note');
  const downloadStartedMessage = document.getElementById('apk-download-started');

  const hideDownloadLink = () => {
    if (apkLink) apkLink.hidden = true;
    if (apkDownload) apkDownload.hidden = true;
    if (sourceNote) sourceNote.hidden = true;
    if (installedMessage) installedMessage.hidden = false;
    if (installedPageMessage) installedPageMessage.hidden = false;
    if (downloadStartedMessage) downloadStartedMessage.hidden = false;
  };

  try {
    if (localStorage.getItem(APK_DOWNLOAD_KEY) === 'true') hideDownloadLink();
  } catch {}

  if (apkDownload) {
    apkDownload.addEventListener('click', () => {
      try {
        localStorage.setItem(APK_DOWNLOAD_KEY, 'true');
        hideDownloadLink();
      } catch {}
    });
  }
})();

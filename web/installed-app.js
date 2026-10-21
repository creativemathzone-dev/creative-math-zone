(() => {
  const downloadOptions = [
    {
      key: 'cmz-apk-download-started',
      linkIds: ['android-apk-link', 'apk-download'],
      messageIds: ['android-app-installed', 'apk-installed'],
      sourceNoteIds: ['apk-source-note'],
    },
    {
      key: 'cmz-student-apk-download-started',
      linkIds: ['student-apk-download'],
      messageIds: ['student-apk-installed'],
      sourceNoteIds: ['student-apk-source-note'],
    },
    {
      key: 'cmz-teacher-apk-download-started',
      linkIds: ['teacher-apk-download'],
      messageIds: ['teacher-apk-installed'],
      sourceNoteIds: ['teacher-apk-source-note'],
    },
    {
      key: 'cmz-admin-apk-download-started',
      linkIds: ['admin-apk-download'],
      messageIds: ['admin-apk-installed'],
      sourceNoteIds: ['admin-apk-source-note'],
    },
  ];

  const setVisible = (ids, hidden) => {
    ids.forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.hidden = hidden;
    });
  };

  const markDownloadStarted = (option) => {
    setVisible(option.linkIds, true);
    setVisible(option.sourceNoteIds, true);
    setVisible(option.messageIds, false);
  };

  downloadOptions.forEach((option) => {
    try {
      if (localStorage.getItem(option.key) === 'true') markDownloadStarted(option);
    } catch {}

    const downloadLink = document.getElementById(option.linkIds.at(-1));
    if (!downloadLink) return;

    downloadLink.addEventListener('click', () => {
      try {
        localStorage.setItem(option.key, 'true');
        markDownloadStarted(option);
      } catch {}
    });
  });
})();

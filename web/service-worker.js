const CACHE_NAME = 'cmz-pwa-v13';
const SHELL_FILES = [
  './',
  './index.html',
  './admin.html',
  './teacher.html',
  './student.html',
  './student-app.html',
  './teacher-app.html',
  './admin-app.html',
  './download.html',
  './config.js',
  './passkeys.js',
  './doubts.js',
  './push.js',
  './pwa.js',
  './installed-app.js',
  './manifest.webmanifest',
  './student-app.webmanifest',
  './teacher-app.webmanifest',
  './admin-app.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/creative-math-zone-logo.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('cmz-pwa-') && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Fee reminders and absent alerts (free Web Push).
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const base = new URL('./', self.registration.scope);
  event.waitUntil(self.registration.showNotification(data.title || 'Creative Math Zone', {
    body: data.body || '',
    icon: new URL('icons/icon-192.png', base).href,
    badge: new URL('icons/icon-192.png', base).href,
    tag: data.tag || undefined,
    data: { url: data.url || new URL('student.html', base).href }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || new URL('student.html', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.split('#')[0] === target.split('#')[0] && 'focus' in c) return c.focus();
    return self.clients.openWindow(target);
  }));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const base = new URL('./', self.registration.scope);
  if (request.method !== 'GET' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
        return response;
      }).catch(async () => (await caches.match(request)) || caches.match(new URL('./index.html', base).href))
    );
    return;
  }

  const isShellFile = SHELL_FILES.some(file => new URL(file, base).pathname === url.pathname);
  if (!isShellFile) return;
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }))
  );
});

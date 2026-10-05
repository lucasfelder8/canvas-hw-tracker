const CACHE = 'hw-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/vendor/qrcode.js', '/icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first for the app shell so updates show up; never cache the API.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/app.webmanifest') return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'HW Tracker', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'HW Tracker', {
    body: d.body || '',
    tag: d.tag,
    data: { url: d.url || '/' },
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (target.startsWith('/')) {
      for (const w of wins) { if ('focus' in w) return w.focus(); }
    }
    return clients.openWindow(target);
  })());
});

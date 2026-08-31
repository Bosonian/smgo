const CACHE = 'smgo-v51';
const SHELL = ['./', './index.html', './app.js', './style.css', './manifest.json',
               './favicon.ico', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Today's card data: network-first, cache for offline fallback
  if (url.pathname.endsWith('/data/today.json')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // API mutations must not look successful while offline. The PWA only marks a
  // record synced on res.ok, so a synthetic 200 here would silently lose work.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline', queued: true }), {
          status: 503,
          statusText: 'Offline',
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // Shell assets: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

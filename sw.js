/* Service worker for the Portfolio dashboard PWA.
   Bump CACHE on each release (match your YYMMDD_N version) to retire old caches. */
const CACHE = 'ledger-260624_10';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-32.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Let everything cross-origin (Finnhub, Twelve Data, Firebase, fonts, CDNs) hit the
  // network untouched — never cache or block live data.
  if (url.origin !== self.location.origin) return;

  // The page itself: network-first so new deploys appear immediately; cache only as
  // an offline fallback.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Same-origin static assets (icons, manifest): serve fast from cache, refresh in background.
  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(res => { caches.open(CACHE).then(c => c.put(req, res.clone())); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});

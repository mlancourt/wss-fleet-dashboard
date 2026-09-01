/* WSS Fleet service worker.
 *
 * Caches the SHELL only. Fleet data is never served from cache — a stale board
 * that looks live is worse than no board at all (CLAUDE.md, PWA traps).
 *
 * Bump CACHE when any shell file changes; activate purges every other version.
 */
const CACHE = 'wss-fleet-shell-v1';

// Relative paths: this must work at the domain root AND under /<repo>/.
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'dates.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // a missing shell file must not wedge install
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isData = url.pathname.includes('/api/') || url.pathname.endsWith('.json');

  // Data: network-first, and NEVER cached. Offline means "can't load", not
  // "here's yesterday's fleet".
  if (isData || url.origin !== self.location.origin) return;

  // Navigations: network-first so a deploy lands immediately, shell as fallback.
  if (req.mode === 'navigate') {
    ev.respondWith(
      fetch(req).catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Shell assets: serve cached, revalidate in the background.
  ev.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});

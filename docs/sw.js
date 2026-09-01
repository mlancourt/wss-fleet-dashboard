/* WSS Fleet service worker.
 *
 * Caches the SHELL only. Fleet data is never served from cache — a stale board
 * that looks live is worse than no board at all (CLAUDE.md, PWA traps).
 *
 * Bump CACHE when any shell file changes; activate purges every other version.
 */
const CACHE = 'wss-fleet-shell-v3';

// Relative paths: this must work at the domain root AND under /<repo>/.
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'api.js',
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

  // Shell (HTML, JS, CSS, icons): network-first, cache as the offline fallback.
  // Not stale-while-revalidate — that serves a new index.html with last
  // deploy's app.js for one load, and a half-updated page is worse than a
  // slightly slower one. The shell is ~20 KB; LTE can afford it.
  ev.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.match(req).then((cached) =>
        cached || (req.mode === 'navigate' ? caches.match('index.html') : undefined)
      ).then((r) => r || Response.error())
    )
  );
});

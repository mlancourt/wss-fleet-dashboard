/* WSS Fleet service worker.
 *
 * Caches the SHELL only. Fleet data is never served from cache — a stale board
 * that looks live is worse than no board at all (CLAUDE.md, PWA traps).
 *
 * Bump CACHE when any shell file changes; activate purges every other version.
 */
const CACHE = 'wss-fleet-shell-v28';

// Relative paths: this must work at the domain root AND under /<repo>/.
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'api.js',
  'dates.js',
  'metrics.js',
  'holds.js',
  'service.js',
  'leads.js',
  'notes.js',
  'attachments.js',
  'map.js',
  // D52: the vendored Wisconsin map. Big (~145 KB) and never changing between
  // deploys, which is exactly what the shell cache is for — a tech opening the
  // map in a warehouse should not be waiting on it.
  'wi-map.svg',
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

  // Documents (schema 6) are NEVER precached and NEVER runtime-cached — the
  // read (`/api/doc/<id>`) and, at S2, the upload (`POST /api/doc`) alike. They
  // are already excluded by the /api/ rule below, and a POST never reaches this
  // handler at all; naming the path here is deliberate, so that a future change
  // to either rule cannot quietly start caching them.
  //
  // Why: a doc is a one-off read a tech asked for by name, and it is the
  // largest thing this app will ever fetch. On one bar of LTE he pays for
  // exactly the file he tapped, once — never for one he didn't, and never for
  // a shelf of them warmed up on his behalf. A second read is free anyway: the
  // id is the content hash, so the Worker sends `immutable` and the browser's
  // own HTTP cache is the right and only place for it.
  if (url.pathname.includes('/api/doc')) return;

  const isData = url.pathname.includes('/api/') || url.pathname.endsWith('.json');

  // Data: network-first, and NEVER cached. Offline means "can't load", not
  // "here's yesterday's fleet".
  if (isData || url.origin !== self.location.origin) return;

  // Shell (HTML, JS, CSS, icons): network-first, cache as the offline fallback.
  // `cache: 'no-cache'` = always revalidate with the server. GitHub Pages sends
  // max-age=600, and a plain fetch() would hand back the browser's HTTP-cached
  // copy for 10 minutes after a deploy — i.e. yesterday's app.js. Revalidation
  // is a 304 on unchanged files, so it costs one small round-trip per file.
  ev.respondWith(
    fetch(req, { cache: 'no-cache' }).then((res) => {
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

/* ============================================================
   FOLIO — service worker
   Caches the app shell so the tool keeps working offline after
   the first visit, and opportunistically caches the CDN
   libraries (pdf.js, marked, FileSaver, JSZip, Tesseract.js) as
   they're requested, so a second run doesn't need the network
   even for those.

   NOTE: service workers can't register from a file:// page — this
   only takes effect when Folio is served over http(s) (e.g. a
   static host, or `python -m http.server` locally).
   ============================================================ */

const CACHE_VERSION = 'folio-v1';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // App shell: cache-first, refresh the cache in the background.
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE_VERSION).then((c) => c.put(req, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  } else {
    // CDN libraries (pdf.js, marked, FileSaver, JSZip, Tesseract, language
    // data): cache-first once fetched, so a later offline run can still
    // use them. Opaque cross-origin responses are cached as-is.
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res) caches.open(CACHE_VERSION).then((c) => c.put(req, res.clone()));
          return res;
        }).catch(() => cached);
      })
    );
  }
});

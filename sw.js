// Offline support.
//
// Each VERSION precaches a complete, consistent copy of the app and serves it
// cache-first, so the app opens instantly and works offline. Deploying a new
// version changes this file, the browser installs the new worker in the
// background, and the page reloads itself once the new worker takes over
// (see `watchForUpdates` in js/app.js).
//
// Bump VERSION on every deploy that changes app files, and keep SHELL in sync
// with the files the app loads.
const VERSION = 'v6';
const CACHE = `time-tracker-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/store.js',
  'js/time.js',
  'js/ui.js',
  'js/entry-dialog.js',
  'js/reports.js',
  'js/export.js',
  'js/config.js',
  'js/google.js',
  'js/sync.js',
  'js/settings.js',
  'js/ribbon.js',
  'vendor/temporal-polyfill.js',
  'vendor/pdf.js',
  'vendor/fonts/NotoSans-Regular.ttf',
  'vendor/fonts/NotoSans-Bold.ttf',
  'vendor/fonts/web/golos-text-cyrillic-400-normal.woff2',
  'vendor/fonts/web/golos-text-cyrillic-500-normal.woff2',
  'vendor/fonts/web/golos-text-cyrillic-600-normal.woff2',
  'vendor/fonts/web/golos-text-latin-400-normal.woff2',
  'vendor/fonts/web/golos-text-latin-500-normal.woff2',
  'vendor/fonts/web/golos-text-latin-600-normal.woff2',
  'vendor/fonts/web/unbounded-cyrillic-500-normal.woff2',
  'vendor/fonts/web/unbounded-cyrillic-700-normal.woff2',
  'vendor/fonts/web/unbounded-latin-500-normal.woff2',
  'vendor/fonts/web/unbounded-latin-700-normal.woff2',
  'icons/icon.svg',
  'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' bypasses the HTTP cache so we never precache a stale file.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('time-tracker-') && k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // App navigations (any hash route) get the cached shell.
    const cached = request.mode === 'navigate'
      ? await cache.match('./')
      : await cache.match(request, { ignoreSearch: true });
    return cached ?? fetch(request);
  })());
});

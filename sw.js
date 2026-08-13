const CACHE_VERSION = 'v36';
const CACHE_NAME = `splitbill-${CACHE_VERSION}`;

// Assets to cache on install
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  console.log('[SW] Install event');
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(() => {
        // Silently fail if offline
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log('[SW] Activate event');
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Only handle GET requests
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Skip GitHub, raw.githubusercontent, and external API calls
  if (url.hostname !== self.location.hostname) {
    return;
  }

  // Network-first for index.html (check for updates)
  // Nota: em GitHub Pages (project page) o caminho é /SplitBill/…,
  // por isso comparamos por sufixo e por modo de navegação.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/style.css') || url.pathname.endsWith('/app.js')) {
    e.respondWith(
      fetch(e.request.url, { cache: 'no-store' }) // no-store: nao reusa HTML stale do CDN/browser
        .then((response) => {
          // Check if response is valid
          if (!response || response.status !== 200 || response.type === 'error') {
            return caches.match(e.request);
          }

          // Clone and cache the response
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });

          // Return fresh response
          return response;
        })
        .catch(() => {
          // Offline: serve from cache
          return caches.match(e.request);
        })
    );
    return;
  }

  // Cache-first for everything else
  e.respondWith(
    caches.match(e.request).then((response) => {
      return (
        response ||
        fetch(e.request).then((response) => {
          if (!response || response.status !== 200) {
            return response;
          }
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
          return response;
        })
      );
    })
  );
});

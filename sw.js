const CACHE_VERSION = 'v111';
const CACHE_NAME = `splitbill-${CACHE_VERSION}`;

// Assets to cache on install
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/apple-touch-icon.png',
  '/leao.png'
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

// Notificações push (dívidas, pagamentos, gamebox livre, hora do Sá) — a Edge
// Function push-notificar manda um payload {title, body, url}; aqui só se
// mostra a notificação, seja qual for o momento que a originou.
self.addEventListener('push', (e) => {
  let data = { title: 'SplitBill', body: 'Tens uma novidade na app.', url: '/SplitBill/' };
  try { Object.assign(data, e.data.json()); } catch (err) { /* payload vazio ou não-JSON */ }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/SplitBill/apple-touch-icon.png',
      badge: '/SplitBill/apple-touch-icon.png',
      data: { url: data.url || '/SplitBill/' }
    })
  );
});

// Clique na notificação: foca uma janela já aberta da app, ou abre uma nova.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/SplitBill/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.includes('/SplitBill/') && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

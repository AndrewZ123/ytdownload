// Music PWA Service Worker
const CACHE_NAME = 'music-pwa-v1';
const SHELL_URLS = [
  '/player',
  '/music/manifest.json',
  '/music/index.html'
];

// Install - cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => 
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch - network first for API, cache first for app shell
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // Audio streaming - cache first (for offline playback)
  if (url.pathname.startsWith('/api/music/stream/')) {
    event.respondWith(
      caches.open('music-offline').then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            // Don't cache range requests partially
            if (response.ok) {
              const clone = response.clone();
              cache.put(event.request, clone);
            }
            return response;
          });
        })
      )
    );
    return;
  }

  // Cover art - cache first
  if (url.pathname.startsWith('/api/music/cover/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached || new Response('', { status: 404 }));
        })
      )
    );
    return;
  }

  // App shell - cache first
  if (url.pathname === '/player' || url.pathname === '/music/index.html' || url.pathname === '/music/manifest.json') {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // API calls - network only
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Everything else - network first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
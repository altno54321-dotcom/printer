/**
 * Manual Duplex PDF - Service Worker
 * Strategy: Cache First for core assets and external PDF library, Network Fallback.
 * Ensures complete offline operation without caching sensitive user PDF documents.
 */

'use strict';

const CACHE_NAME = 'duplex-pdf-v1.0.0';

// Essential application shell and vendor library assets
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.9/dist/pdf-lib.min.js'
];

// Install Event: Precaches application shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        // Cache assets gracefully so that a missing optional asset doesn't abort installation
        const cachePromises = PRECACHE_ASSETS.map(async (url) => {
          try {
            const response = await fetch(url, { mode: url.startsWith('http') ? 'cors' : 'no-cors' });
            if (response.ok || response.type === 'opaque') {
              await cache.put(url, response);
            }
          } catch (err) {
            console.warn(`[Service Worker] Pre-cache skipped for: ${url}`, err);
          }
        });
        await Promise.allSettled(cachePromises);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate Event: Deletes obsolete caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((name) => {
            if (name !== CACHE_NAME) {
              return caches.delete(name);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch Event: Cache First, Network Fallback
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Never intercept or cache non-GET requests or internal blob/data URLs
  if (req.method !== 'GET' || req.url.startsWith('blob:') || req.url.startsWith('data:')) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      // If not in cache, fetch from network and dynamically cache same-origin assets or trusted CDN scripts
      return fetch(req)
        .then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200) {
            return networkResponse;
          }

          // Cache valid responses for app assets or external CDN library
          const isSameOrigin = req.url.startsWith(self.location.origin);
          const isPdfLibCdn = req.url.includes('cdn.jsdelivr.net/npm/pdf-lib');

          if (isSameOrigin || isPdfLibCdn) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(req, responseToCache);
            });
          }

          return networkResponse;
        })
        .catch(() => {
          // If offline and request is an HTML page navigation, fallback to index.html
          if (req.mode === 'navigate') {
            return caches.match('./index.html');
          }
          // Do not return HTML for scripts or icons
          return new Response('Network error occurred while offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({ 'Content-Type': 'text/plain' })
          });
        });
    })
  );
});
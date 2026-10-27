/**
 * Manual Duplex PDF - Service Worker
 * Version: 1.00
 * Anti-Hoarding Strategy:
 *  - Network-First for App Shell (HTML, CSS, JS) -> Always pulls fresh code when online
 *  - Cache-First for external library CDNs
 *  - Immediate cache wiping on version increment
 */

'use strict';

const SW_VERSION = '1.00';
const CACHE_NAME = `duplex-pdf-v${SW_VERSION}`;

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

// Install: Activate immediately without waiting
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cachePromises = PRECACHE_ASSETS.map(async (url) => {
        try {
          const res = await fetch(url, { cache: 'no-cache' });
          if (res.ok || res.type === 'opaque') {
            await cache.put(url, res);
          }
        } catch (err) {
          console.warn(`[SW] Pre-caching skipped: ${url}`);
        }
      });
      await Promise.allSettled(cachePromises);
    })
  );
});

// Activate: Delete ALL outdated caches immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log(`[SW] Purging old cache: ${key}`);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Network-First for local files, Cache-First for CDNs
self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET' || req.url.startsWith('blob:') || req.url.startsWith('data:')) {
    return;
  }

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // Network-First: Always load the freshest code when online
    event.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(() => {
          // If offline, use cache
          return caches.match(req).then((cached) => {
            if (cached) return cached;
            if (req.mode === 'navigate') {
              return caches.match('./index.html');
            }
            return new Response('Offline: resource unavailable', { status: 503 });
          });
        })
    );
    return;
  }

  // Cache-First for external library CDNs
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkResponse;
      });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});

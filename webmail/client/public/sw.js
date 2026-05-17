/**
 * Duperhuman service worker — Phase 4 PWA support.
 *
 * Strategy by request type:
 *
 *   /assets/*               — cache-first. Vite ships content-hashed
 *                             filenames so anything older than the
 *                             currently-built bundle is naturally a
 *                             cache miss on the new URL.
 *   navigation requests     — network-first, fall back to cached
 *                             /index.html so the app keeps opening
 *                             when the user is offline.
 *   /api/*                  — pass-through. The mail data layer caches
 *                             into IndexedDB on its own; we don't want
 *                             stale API responses fighting Dexie.
 *   anything else GET       — pass-through with no caching.
 *
 *   POST/PUT/DELETE/PATCH   — always network-only. Never cache mutations.
 *
 * The version constant + activate handler delete any older caches; bumping
 * VERSION forces a clean cache refresh on the next page load.
 */

'use strict';

const VERSION    = '2026-05-16-1';
const STATIC_CACHE = `dh-static-${VERSION}`;

// On install, just take over — we lazy-cache assets as they're requested
// rather than precaching, because Vite's content-hashed asset list isn't
// known to the SW without an injected manifest.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== STATIC_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GETs. Anything else is a no-op pass-through.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only — never proxy cross-origin (fonts, gravatar, etc.).
  if (url.origin !== self.location.origin) return;

  // Never cache API calls. The Dexie cache lives in the app.
  if (url.pathname.startsWith('/api/')) return;

  // Navigation requests (HTML): network-first, fall back to cached shell.
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstShell(req));
    return;
  }

  // Built assets and other same-origin GETs: cache-first.
  if (url.pathname.startsWith('/assets/') || /\.(js|css|svg|woff2?|png|jpg|webp|ico)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Anything else: try network, fall back to cache if present.
  event.respondWith(networkWithCacheFallback(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    // Out-of-cache + offline. Return a meaningful response so the page
    // can show its own fallback rather than a generic network error.
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function networkFirstShell(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put('/index.html', res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match('/index.html');
    if (cached) return cached;
    return new Response('<h1>Offline</h1>', {
      status: 503,
      headers: { 'Content-Type': 'text/html' },
    });
  }
}

async function networkWithCacheFallback(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

// Allow the page to send {type:'SKIP_WAITING'} to force an immediate update
// after a deploy. main.tsx hooks this when it detects an updated SW.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

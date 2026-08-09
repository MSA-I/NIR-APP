/* SupplyFlow service worker — static app shell + Web Push.
 *
 * Only same-origin navigation and immutable static assets are cached. API calls,
 * Supabase responses and business data never enter this cache: live financial
 * state remains network-authoritative.
 */

const SHELL_CACHE = 'supplyflow-shell-v1';
const STATIC_DESTINATIONS = new Set(['script', 'style', 'font', 'image', 'manifest']);
const SHELL_FILES = new Set([
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]);

function isShellAsset(url, request) {
  return url.origin === self.location.origin
    && STATIC_DESTINATIONS.has(request.destination)
    && (url.pathname.startsWith('/assets/') || SHELL_FILES.has(url.pathname));
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const response = await fetch('/');
    if (!response.ok) throw new Error('app_shell_unavailable');
    const html = await response.clone().text();
    const assets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)]
      .map((match) => match[1]);
    const cache = await caches.open(SHELL_CACHE);
    await cache.put('/', response);
    await cache.addAll([...new Set([...SHELL_FILES].filter((path) => path !== '/').concat(assets))]);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('supplyflow-shell-') && key !== SHELL_CACHE)
        .map((key) => caches.delete(key)),
    )),
  ]));
});

async function cacheStatic(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function navigateWithShell(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put('/', response.clone());
    }
    return response;
  } catch {
    return (await caches.match('/')) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(navigateWithShell(event.request));
    return;
  }
  if (isShellAsset(url, event.request)) {
    event.respondWith(cacheStatic(event.request));
  }
});

self.addEventListener('push', (event) => {
  // Payload contract with supabase/functions/send-push: { title, body, url }.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not JSON — show what we can rather than dropping the notification.
    data = { title: 'SupplyFlow', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'SupplyFlow';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    dir: 'rtl',
    lang: 'he',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Prefer an already-open tab: focus it and route it (SPA — navigate keeps the session).
      for (const client of clients) {
        if ('focus' in client) {
          return client.focus().then((focused) =>
            'navigate' in focused ? focused.navigate(url) : undefined);
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

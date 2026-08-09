/* SupplyFlow service worker — Web Push delivery + APP-SHELL cache (never data).
 *
 * Until 09.08.2026 this worker did push only ("Web Push delivery only") — the deliberate
 * no-cache stance existed because a cached stale balance is a wrong balance. That stance is
 * UNCHANGED where it matters: no /rest/v1, /auth/v1, /storage/v1 or /functions/v1 response is
 * ever cached — live financial state always comes from the network. What changed (#101,
 * DEBT-REGISTER §2): the STATIC SHELL — index.html, hashed JS/CSS — is precached, so an
 * offline reload brings the app up (and the IndexedDB queue with it) instead of the browser's
 * dinosaur. Hashed assets are immutable by construction, so serving them from cache can never
 * be stale. No workbox runtime: vite-plugin-pwa (injectManifest) only fills self.__WB_MANIFEST
 * at build time; in dev it is undefined and the guard below makes the worker push-only again.
 */

const MANIFEST = (self.__WB_MANIFEST || []).map((entry) =>
  typeof entry === 'string' ? { url: entry, revision: null } : entry);
const PRECACHE = MANIFEST.map((entry) => new URL(entry.url, self.location.origin).pathname);
// One cache per deploy: index.html is the only non-hashed precache entry, so its manifest
// revision changes every build — keying the cache on it makes activate() cleanup exact
// (the previous deploy's cache, runtime-cached chunks included, is dropped whole).
const INDEX_ENTRY = MANIFEST.find((entry) => entry.url.endsWith('index.html'));
const CACHE_NAME = `supplyflow-shell-${(INDEX_ENTRY && INDEX_ENTRY.revision) || 'dev'}`;

const isApiRequest = (url) =>
  url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/') ||
  url.pathname.startsWith('/storage/') || url.pathname.startsWith('/functions/') ||
  url.pathname.startsWith('/realtime/');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .catch(() => { /* a failed warm-up must not block install — push still matters */ })
      // Take over immediately, exactly as before — this is what keeps the
      // controllerchange update contract in src/main.tsx alive.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('supplyflow-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Same-origin GETs only, and never the API: data stays live, always.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || isApiRequest(url)) return;

  // Navigations: network first (a fresh deploy wins), cached shell when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/index.html', { cacheName: CACHE_NAME }).then((hit) => hit || Response.error())),
    );
    return;
  }

  // Hashed immutable assets: cache first; anything fetched online joins the cache at runtime,
  // so the online-only chunks excluded from PRECACHE still open offline once visited.
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request, { cacheName: CACHE_NAME }).then((hit) =>
        hit || fetch(event.request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => { void cache.put(event.request, copy); });
          }
          return response;
        })),
    );
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

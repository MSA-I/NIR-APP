/* SupplyFlow service worker — Web Push delivery + APP-SHELL cache (never data).
 *
 * Only the static shell is cached. API, Auth, Storage, Edge Function and Realtime
 * responses always stay network-authoritative.
 */

const MANIFEST = (self.__WB_MANIFEST || []).map((entry) =>
  typeof entry === 'string' ? { url: entry, revision: null } : entry);
const PRECACHE = MANIFEST.map((entry) => new URL(entry.url, self.location.origin).pathname);
// One cache per deploy: index.html is the only non-hashed precache entry, so its manifest
// revision changes every build and activation can remove the previous deploy exactly.
const INDEX_ENTRY = MANIFEST.find((entry) => entry.url.endsWith('index.html'));
const CACHE_NAME = `supplyflow-shell-${(INDEX_ENTRY && INDEX_ENTRY.revision) || 'dev'}`;

const isApiRequest = (url) =>
  url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/') ||
  url.pathname.startsWith('/storage/') || url.pathname.startsWith('/functions/') ||
  url.pathname.startsWith('/realtime/');

// The operator console (operator.html, a second Vite entry) shares this origin, so this worker
// — whose scope is '/' — controls its pages too. Its navigations must NEVER be answered with
// the cached tenant shell: online they pass through untouched, offline they fail honestly.
// The console is also excluded from the precache (vite.config.ts globIgnores).
const isOperatorNavigation = (url) =>
  url.pathname === '/operator' || url.pathname === '/operator.html' ||
  url.pathname.startsWith('/operator/');

// The supplier portal (portal.html, a third Vite entry) gets the same treatment for a sharper
// reason: its visitors are suppliers holding a bearer token, and they must never be answered
// with the cached tenant shell. Online it passes through untouched; offline it fails honestly.
const isPortalNavigation = (url) =>
  url.pathname === '/portal' || url.pathname === '/portal.html' ||
  url.pathname.startsWith('/portal/');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      // A partial shell must never take control. The previous worker remains active until the
      // complete new shell has been cached.
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
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || isApiRequest(url)) return;

  // Navigations use the network first; the cached shell is only an offline fallback.
  if (event.request.mode === 'navigate') {
    if (isOperatorNavigation(url) || isPortalNavigation(url)) return;
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/index.html', { cacheName: CACHE_NAME }).then((hit) => hit || Response.error())),
    );
    return;
  }

  // Hashed assets are immutable. Chunks excluded from the initial precache join the current
  // deploy's cache only after they have been fetched successfully.
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

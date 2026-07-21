/* SupplyFlow service worker — Web Push delivery only.
 *
 * Deliberately NO offline caching and NO workbox: this app shows live financial
 * state (balances, due payments). A cached stale balance is a wrong balance —
 * the network is the source of truth, always. The worker exists solely so the
 * browser has somewhere to deliver push messages and route the click.
 */

self.addEventListener('install', () => {
  // Take over immediately — there is no cache to warm up.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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

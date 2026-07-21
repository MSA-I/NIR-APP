import { supabase } from './supabase';

/**
 * Web Push client — subscription lifecycle for the current device.
 *
 * The moving parts and where they live:
 *   public/sw.js                          — receives the push, shows the notification
 *   push_subscriptions (migration 0015)   — one row per device that opted in (RLS: own rows)
 *   send-push Edge Function               — the only place the VAPID *private* key exists
 *   VITE_VAPID_PUBLIC_KEY                 — build-time env (.env.example); the public half
 *                                           is safe in the bundle by design (it only lets a
 *                                           push service verify who is allowed to send)
 *
 * No key configured is a supported state ('no-key'): dev environments without push
 * simply show "לא מוגדר בסביבה זו" in Settings instead of a broken toggle.
 */

// House style for VITE_ env access — a cast, like src/lib/supabase.ts:3. Unlike the
// supabase vars this one is optional: its absence disables a feature, not the app.
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export type PushStatus = 'unsupported' | 'no-key' | 'denied' | 'subscribed' | 'not-subscribed';

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Installed to the home screen / opened as an app window. On iOS this is a precondition
 *  for push — Safari only exposes the Push API to installed web apps. */
export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    // iOS Safari legacy flag, still the reliable signal there.
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    // iPadOS reports itself as macOS; the touch check tells them apart.
    || (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);
}

export function hasVapidKey(): boolean {
  return !!VAPID_PUBLIC_KEY;
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!isPushSupported()) return 'unsupported';
  if (!VAPID_PUBLIC_KEY) return 'no-key';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? 'subscribed' : 'not-subscribed';
  } catch {
    return 'not-subscribed';
  }
}

/** applicationServerKey wants raw bytes; the VAPID public key ships base64url-encoded. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

/**
 * Subscribes this device and records it for the send-push function.
 * MUST be called from a click handler — browsers only grant Notification.requestPermission
 * from a user gesture. Returns null on success, a Hebrew error message otherwise.
 */
export async function subscribePush(profile: { id: string; org_id: string }): Promise<string | null> {
  if (!isPushSupported()) return 'הדפדפן הזה אינו תומך בהתראות דחיפה';
  if (!VAPID_PUBLIC_KEY) return 'התראות דחיפה אינן מוגדרות בסביבה זו';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'לא ניתן אישור להתראות בדפדפן';

  try {
    // Fail fast when main.tsx's registration never succeeded — `serviceWorker.ready`
    // would otherwise wait forever and leave the Settings toggle stuck on busy.
    if (!(await navigator.serviceWorker.getRegistration())) {
      return 'רישום שירות ההתראות נכשל — רענן את הדף ונסה שוב';
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });

    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      await sub.unsubscribe();
      return 'המנוי שהתקבל מהדפדפן חסר — נסה שוב';
    }

    // ignoreDuplicates (ON CONFLICT DO NOTHING): re-subscribing the same endpoint is a
    // no-op, which matches 0015's deliberate lack of an UPDATE policy — a subscription
    // is never edited, only created and deleted.
    const res = await supabase.from('push_subscriptions').upsert({
      org_id: profile.org_id,
      user_id: profile.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent,
    }, { onConflict: 'endpoint', ignoreDuplicates: true });

    if (res.error) {
      // Do not keep a browser subscription the server never heard about.
      await sub.unsubscribe();
      return 'שמירת המנוי נכשלה — נסה שוב';
    }
    return null;
  } catch {
    return 'הפעלת ההתראות נכשלה — נסה שוב';
  }
}

/** Unsubscribes this device and removes its row. Returns null on success. */
export async function unsubscribePush(): Promise<string | null> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return null; // already off — nothing to undo

    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    // RLS limits the delete to the caller's own row; a failure leaves a dead endpoint
    // that send-push cleans up on its first 404/410, so it is not surfaced as an error.
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    return null;
  } catch {
    return 'כיבוי ההתראות נכשל — נסה שוב';
  }
}

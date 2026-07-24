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

export interface PushCleanupResult {
  /** null means there was no browser subscription to remove. */
  localRemoved: boolean | null;
  /** null means there was no endpoint whose authenticated server row could be targeted. */
  serverRemoved: boolean | null;
  warning: string | null;
}

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
    if (!sub) return 'not-subscribed';
    // A browser subscription alone is not "subscribed": the endpoint is per-DEVICE, so after
    // a user switch on this device its DB row may still belong to the previous user — a row
    // RLS hides from us. "Subscribed" is only honest when WE own the row; otherwise report
    // not-subscribed so the toggle re-claims the endpoint (claim_push_subscription, 0015).
    const { data, error } = await supabase.from('push_subscriptions')
      .select('id').eq('endpoint', sub.endpoint).maybeSingle();
    return !error && data ? 'subscribed' : 'not-subscribed';
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
 * The DB row's org/user come from auth_org()/auth.uid() inside claim_push_subscription,
 * never from the caller — so there is no profile argument to lie with.
 */
export async function subscribePush(): Promise<string | null> {
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

    // claim_push_subscription (SECURITY DEFINER, 0015) deletes any existing row for this
    // endpoint — regardless of owner — and inserts a fresh one for the current user. A plain
    // upsert under RLS could not do that: after a user switch on the same browser the old
    // owner's row is invisible to us, so ON CONFLICT DO NOTHING would silently keep routing
    // this device's pushes to the previous user's org while we report "subscribed".
    const res = await supabase.rpc('claim_push_subscription', {
      p_endpoint: json.endpoint,
      p_p256dh: json.keys.p256dh,
      p_auth: json.keys.auth,
      p_user_agent: navigator.userAgent,
    });

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
    // RLS limits the delete to the caller's own row — matching 0 rows is legitimate (the
    // endpoint may have been claimed by another user of this device); a failure leaves a
    // dead endpoint that send-push cleans up on its first 404/410, so it is not surfaced.
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    return null;
  } catch {
    return 'כיבוי ההתראות נכשל — נסה שוב';
  }
}

/**
 * Best-effort cleanup for the current browser immediately before logout.
 *
 * Server and browser cleanup are deliberately attempted independently: a database/RLS
 * failure must not prevent us from invalidating the device endpoint, while a browser
 * failure must not prevent removal of the authenticated row. The caller must always
 * continue logout, but surface `warning` verbatim instead of claiming full removal.
 */
export async function cleanupPushBeforeSignOut(): Promise<PushCleanupResult> {
  if (!isPushSupported()) return { localRemoved: null, serverRemoved: null, warning: null };

  let sub: PushSubscription | null = null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    sub = await reg?.pushManager.getSubscription() ?? null;
  } catch {
    return {
      localRemoved: false,
      serverRemoved: null,
      warning: 'לא ניתן היה לבדוק את מנוי ההתראות במכשיר. ההתנתקות הושלמה, אך יש לבטל את ההתראות בהגדרות האתר בדפדפן לפני שימוש במכשיר משותף.',
    };
  }

  if (!sub) return { localRemoved: null, serverRemoved: null, warning: null };

  const endpoint = sub.endpoint;
  let serverRemoved = false;
  let localRemoved = false;

  try {
    // Returning the deleted id is the proof: a mutation with no error but zero RLS-visible
    // rows is not enough to claim that the server record was removed.
    const { data, error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).select('id');
    serverRemoved = !error && Array.isArray(data) && data.length > 0;
  } catch {
    serverRemoved = false;
  }

  try {
    localRemoved = await sub.unsubscribe();
  } catch {
    localRemoved = false;
  }

  if (serverRemoved && localRemoved) return { serverRemoved, localRemoved, warning: null };

  if (localRemoved) {
    return {
      serverRemoved,
      localRemoved,
      warning: 'מנוי ההתראות במכשיר בוטל, אך ניקוי הרשומה בשרת לא אומת. כדי לנסות שוב, יש להתחבר מחדש ולהפעיל ואז לכבות את ההתראות בהגדרות.',
    };
  }

  if (serverRemoved) {
    return {
      serverRemoved,
      localRemoved,
      warning: 'רשומת ההתראות בשרת הוסרה, אך ביטול המנוי בדפדפן לא אומת. יש לבטל את ההתראות בהגדרות האתר בדפדפן לפני שימוש במכשיר משותף.',
    };
  }

  return {
    serverRemoved,
    localRemoved,
    warning: 'ניקוי מנוי ההתראות נכשל בשרת ובדפדפן. ההתנתקות הושלמה, אך יש לבטל את ההתראות בהגדרות האתר בדפדפן; אפשר גם להתחבר מחדש ולנסות שוב.',
  };
}

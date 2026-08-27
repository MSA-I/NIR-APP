import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import { BellRing, SlidersHorizontal } from 'lucide-react';
import { ICON, Note, Skeleton, useToast } from './ui';
import { getPushStatus, subscribePush, unsubscribePush, isIOS, isStandalone, type PushStatus } from '../lib/push';
import { useQuery } from '../lib/useQuery';
import { DOMAIN } from '../lib/query/keys';
import {
  NOTIFICATION_EVENT_LABELS,
  readNotificationPreferences,
  setNotificationPreference,
  type NotificationPreference,
} from '../lib/notifications';

/* ---------- push notifications (per-device, not per-org) ---------- */

// Extracted from Settings.tsx (audit round: adversarial review): /settings is owner-only, but
// operational pushes target owner+office — office users need this toggle reachable, so
// the same card now also renders on /alerts (FINANCE guard covers both roles).

// Status → the one line shown under the toggle. 'no-key' is a legitimate environment
// (dev without VAPID keys) and must read as configuration, not as a failure.
const PUSH_STATUS_LINE: Record<PushStatus, string> = {
  unsupported: 'הדפדפן הזה אינו תומך בהתראות דחיפה',
  'no-key': 'לא מוגדר בסביבה זו',
  denied: 'ההתראות נחסמו בהגדרות הדפדפן — כדי להפעיל יש לאפשר אותן שם',
  subscribed: 'התראות פעילות במכשיר זה',
  'not-subscribed': 'התראות כבויות במכשיר זה',
};

/**
 * The notification card, in two parts that answer two different questions.
 *
 *   `PushDeviceCard`      — "does THIS browser buzz?"  (push_subscriptions, per device, 0015)
 *   `NotificationMatrix`  — "which events reach me at all?" (notification_preferences, per member,
 *                            migration 0068)
 *
 * They are deliberately separate cards: a member can be subscribed on their phone and still have
 * muted Push for price increases, and one card conflating the two would make that state unreadable.
 * Both render from the single `<PushSection />` that /alerts already places (FINANCE guard =
 * owner+office = exactly the notification audience of 0068's `eligible` CTE).
 */
export function PushSection() {
  return (
    <>
      <PushDeviceCard />
      <NotificationMatrix />
    </>
  );
}

function PushDeviceCard() {
  const toast = useToast();
  const [status, setStatus] = useState<PushStatus | null>(null); // null = still checking
  const [busy, setBusy] = useState(false);

  useEffect(() => { void getPushStatus().then(setStatus); }, []);

  // iOS Safari exposes the Push API only to an installed app — before that the honest
  // instruction is "install first", not a dead toggle that fails silently.
  const iosNeedsInstall = isIOS() && !isStandalone();
  const canToggle = status === 'subscribed' || status === 'not-subscribed';

  async function toggle() {
    if (!canToggle) return;
    setBusy(true);
    const err = status === 'subscribed' ? await unsubscribePush() : await subscribePush();
    setBusy(false);
    if (err) toast(err, 'error');
    else toast(status === 'subscribed' ? 'ההתראות כובו במכשיר זה' : 'ההתראות הופעלו במכשיר זה');
    setStatus(await getPushStatus());
  }

  return (
    <div className="card card-pad space-y-4">
      <div>
        <h2 className="section-title flex items-center gap-2"><BellRing size={ICON.md} /> התראות דחיפה</h2>
        <p className="text-sm text-ink-muted mt-1">
          התראה מיידית למכשיר זה על עליית מחיר, חשד לחשבונית כפולה ותשלום שמתקרב לפירעון או עבר אותו.
        </p>
      </div>

      {iosNeedsInstall && (
        <Note tone="info">
          ב-iPhone יש להוסיף את האפליקציה למסך הבית (שיתוף ← הוספה למסך הבית) לפני הפעלת התראות
        </Note>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-ink-muted">
          {status === null ? 'בודק…' : iosNeedsInstall ? 'התראות יהיו זמינות לאחר ההוספה למסך הבית' : PUSH_STATUS_LINE[status]}
        </span>
        {(canToggle || iosNeedsInstall) && (
          <button
            className={status === 'subscribed' ? 'btn-ghost' : 'btn-primary'}
            disabled={busy || iosNeedsInstall || !canToggle}
            onClick={() => void toggle()}
          >
            {status === 'subscribed' ? 'כבה התראות במכשיר זה' : 'הפעל התראות למכשיר זה'}
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- per-event preferences (migration 0068) ---------- */

type Channel = 'push' | 'inapp';

const CHANNEL_LABEL: Record<Channel, string> = {
  push: 'דחיפה למכשיר',
  inapp: 'התראה במערכת',
};

/** The one line under each event, stating what the current pair of switches actually does. */
function deliveryLine(preference: NotificationPreference): string {
  if (!preference.inapp_enabled) return 'לא נרשמת בפעמון — ולכן גם לא נשלחת דחיפה למכשיר';
  if (!preference.push_enabled) return 'מופיעה בפעמון ובמסך ההתראות; לא נשלחת דחיפה למכשיר';
  return 'מופיעה בפעמון ובמסך ההתראות, ונשלחת גם כדחיפה למכשיר';
}

/**
 * The preference matrix: one row per catalogued event code, two switches per row.
 *
 * **Opt-in is the default and this screen keeps it that way.** An absent row comes back from
 * `read_notification_preferences()` as both flags `true` with `configured = false`, so it renders
 * "on" and nothing is written until the member actually changes something. Opening this card must
 * never turn into a write — that is what would make 0068 change an installation's behaviour by
 * existing (migration 0068).
 *
 * **Muting Push does not mute the bell.** `push_enabled = false` removes the Web Push leg and
 * LEAVES the `notifications` row, because the unread badge of OPEN-DECISIONS #39 counts those rows.
 * Muting the in-app notification is the one that removes the record — and Push travels with it,
 * since Push rides on the row. The copy below says both out loud rather than leaving a member to
 * discover which switch silences the audit trail.
 */
export function NotificationMatrix() {
  const { errorText } = useT();
  const toast = useToast();
  const { data, loading, error, refetch } = useQuery<NotificationPreference[]>(
    () => readNotificationPreferences(),
    [],
    [DOMAIN.notifications, 'preferences'],
  );
  const [pending, setPending] = useState<string | null>(null);

  async function change(preference: NotificationPreference, channel: Channel, next: boolean) {
    setPending(preference.event_code);
    try {
      // Both columns travel on every write: the row holds both, so the untouched channel is sent
      // back exactly as it is displayed rather than being defaulted a second time.
      await setNotificationPreference(
        preference.event_code,
        channel === 'push' ? next : preference.push_enabled,
        channel === 'inapp' ? next : preference.inapp_enabled,
      );
      await refetch();
      toast('העדפת ההתראה נשמרה');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="card card-pad space-y-4">
      <div>
        <h2 className="section-title flex items-center gap-2">
          <SlidersHorizontal size={ICON.md} /> אילו התראות מגיעות אליי
        </h2>
        <p className="text-sm text-ink-muted mt-1">
          ההגדרה היא שלך בלבד ותקפה בכל המכשירים. כברירת מחדל הכול פעיל.
          <strong className="font-medium"> כיבוי הדחיפה מסיר רק את ההתראה למכשיר</strong> — ההתראה
          ממשיכה להופיע בפעמון ובמסך ההתראות. כיבוי ההתראה במערכת הוא זה שמסיר את הרשומה עצמה, ואיתה
          גם הדחיפה.
        </p>
      </div>

      {/* The house skeleton idiom (ui.tsx:41-48): one spoken "טוען", not three narrated boxes. */}
      {loading && (
        <div className="space-y-3" role="status" aria-busy="true">
          <span className="sr-only">טוען העדפות התראה</span>
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}

      {error && <Note tone="alert" role="alert">{error}</Note>}

      {data && (
        <ul className="divide-y divide-line-soft">
          {data.map((preference) => {
            const copy = NOTIFICATION_EVENT_LABELS[preference.event_code];
            const busy = pending === preference.event_code;
            return (
              <li key={preference.event_code} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-x-4 sm:gap-y-2">
                  <div className="min-w-0 sm:flex-1">
                    <div className="text-sm font-medium text-ink-body">
                      {copy?.label ?? preference.event_code}
                    </div>
                    {copy && <div className="text-xs text-ink-muted mt-0.5">{copy.detail}</div>}
                    <div className="text-xs text-ink-soft mt-1">{deliveryLine(preference)}</div>
                    {!preference.configured && (
                      <div className="text-xs text-ink-faint mt-0.5">ברירת המחדל — לא שינית כאן דבר</div>
                    )}
                  </div>
                  {/* ONE column below `sm`, not two — measured, not a preference. The row's content
                      box is 256px at 320px wide (viewport − 2×16 main − 2×16 card-pad), so a
                      two-column grid would hand each switch 124px while "התראה במערכת · פעיל" needs
                      166px, wrapping every switch to two lines. One column gives the full 256px and
                      nothing wraps. `.btn` is `inline-flex`, which a grid blockifies and stretches —
                      no `w-full` needed, and `min-h-11` (the 44px touch target) is untouched. From
                      `sm` up this is byte-for-byte the previous desktop row. */}
                  <div className="grid gap-2 sm:flex sm:flex-wrap">
                    {(['inapp', 'push'] as Channel[]).map((channel) => {
                      const on = channel === 'push' ? preference.push_enabled : preference.inapp_enabled;
                      return (
                        <button
                          key={channel}
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`${CHANNEL_LABEL[channel]} — ${copy?.label ?? preference.event_code}`}
                          disabled={busy}
                          className={on ? 'btn-secondary' : 'btn-ghost'}
                          onClick={() => void change(preference, channel, !on)}
                        >
                          {CHANNEL_LABEL[channel]} · {on ? 'פעיל' : 'כבוי'}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

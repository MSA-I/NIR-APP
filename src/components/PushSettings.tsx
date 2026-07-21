import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { useToast, Note } from './ui';
import { getPushStatus, subscribePush, unsubscribePush, isIOS, isStandalone, type PushStatus } from '../lib/push';

/* ---------- push notifications (per-device, not per-org) ---------- */

// Extracted from Settings.tsx (audit round: adversarial review): /settings is owner-only, but
// the price-increase push targets owner+office — office users need this toggle reachable, so
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

export function PushSection() {
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
        <h2 className="section-title flex items-center gap-2"><BellRing size={17} /> התראות דחיפה</h2>
        <p className="text-sm text-ink-muted mt-1">
          התראה מיידית למכשיר זה כשספק מעלה מחיר במחירון וכשתשלומים מתקרבים לפירעון.
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

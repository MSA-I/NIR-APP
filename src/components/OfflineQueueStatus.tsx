import { useEffect } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { fmtDateTime } from '../lib/format';
import { useOfflineQueue, offlineQueue } from '../lib/offlineQueue';
import { useAuth } from '../auth/AuthContext';
import { flushPendingPhotosNow } from './FileUpload';

/**
 * The offline status strip for the receiving path (`OFFLINE-SYNC-DESIGN.md` §6).
 *
 * A quiet status line, not a shouting banner — the North Star is a calm control room. It appears
 * only when it has something true to say: the network is gone, work is waiting, a send failed, or
 * this device cannot store a draft at all. When everything is synced it renders nothing, because a
 * permanent "מסונכרן" badge is decoration that trains people to stop reading it.
 *
 * Everything it shows is a measured fact:
 *  - **two counters, separate** (:84) — actions waiting and uploads waiting are different work with
 *    different failure modes, and one number for both would hide whichever is smaller;
 *  - **the real last-successful-sync time, or `—`** (:83) — never "עודכן זה עתה";
 *  - **a Hebrew reason per action** (:90) — not "הסנכרון נכשל";
 *  - **a manual retry** (:85), which stays even though the queue also resumes by itself.
 */
export default function OfflineQueueStatus() {
  const queue = useOfflineQueue();
  const { profile } = useAuth();

  // §4 (closed 09.08.2026): photos stashed offline are flushed from the same surface that
  // counts them — on mount (the user may have reconnected before returning here) and on
  // every 'online'. flushPendingPhotosNow is concurrency-guarded, so bursts are harmless.
  const orgId = profile?.org_id ?? null;
  useEffect(() => {
    if (!orgId) return;
    const attempt = () => { void flushPendingPhotosNow(orgId).catch(() => { /* next 'online' retries */ }); };
    attempt();
    window.addEventListener('online', attempt);
    return () => window.removeEventListener('online', attempt);
  }, [orgId]);
  const failures = queue.actions.filter((action) => action.reason && action.state !== 'pending');
  const nothingToSay = queue.online
    && queue.storageAvailable
    && !queue.sessionExpired
    && queue.pendingActions === 0
    && queue.pendingUploads === 0;
  if (nothingToSay) return null;

  return (
    <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-ink-mid"
      role="status" aria-live="polite" data-testid="offline-queue-status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5 font-medium text-ink">
          {!queue.online && <CloudOff size={14} />}
          {queue.online ? 'מחובר לרשת' : 'אין חיבור לרשת — העבודה נשמרת במכשיר'}
        </span>
        <span>
          פעולות ממתינות:{' '}
          <span className="num" data-testid="offline-pending-actions">{queue.pendingActions}</span>
        </span>
        <span>
          העלאות ממתינות:{' '}
          <span className="num" data-testid="offline-pending-uploads">{queue.pendingUploads}</span>
        </span>
        <span>
          סנכרון מוצלח אחרון:{' '}
          <span className="num" data-testid="offline-last-sync">
            {queue.lastSuccessfulSyncAt === null ? '—' : fmtDateTime(new Date(queue.lastSuccessfulSyncAt))}
          </span>
        </span>
        {queue.syncing && <span className="text-ink-soft">מסנכרן…</span>}
        <button type="button" className="btn-ghost ms-auto min-h-11 text-xs"
          disabled={queue.syncing || !queue.online}
          onClick={() => void offlineQueue.sync()}>
          <RefreshCw size={13} /> ניסיון סנכרון עכשיו
        </button>
      </div>

      {!queue.storageAvailable && (
        <p className="mt-1.5 text-alert-fg">
          הדפדפן הזה אינו מאפשר שמירה מקומית, ולכן טיוטה לא תישרד רענון או סגירת הכרטיסייה. אין לסמוך על עבודה לא-מקוונת במכשיר הזה.
        </p>
      )}
      {queue.sessionExpired && (
        <p className="mt-1.5 text-alert-fg">
          פג תוקף החיבור. הטיוטות נשמרו במכשיר ואינן נשלחות עם אישורים מיושנים — יש להתחבר מחדש ואז לסנכרן.
        </p>
      )}
      {failures.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {failures.map((action) => (
            <li key={action.id} className="text-alert-fg">
              {action.orderLabel}: {action.reason}
              {action.attempts > 0 && <> <span className="num">(ניסיונות: {action.attempts})</span></>}
              {action.conflictCode && <> — נדרשת הכרעה במסך הקבלה.</>}
            </li>
          ))}
        </ul>
      )}
      {!queue.online && (
        <p className="mt-1.5 text-ink-soft">
          מסכים אחרים דורשים רשת. טעינה מחדש של האפליקציה במצב לא-מקוון לא תעלה — הנתונים שנשמרו במכשיר ימתינו ויישלחו בפתיחה הבאה.
        </p>
      )}
    </div>
  );
}

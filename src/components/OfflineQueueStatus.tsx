import { useEffect, useRef, useState } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import { fmtDateTime } from '../lib/format';
import { useOfflineQueue, offlineQueue } from '../lib/offlineQueue';
import { syncPendingDocumentPhotos } from './FileUpload';
import { listPendingPhotos } from '../lib/offlineDb';
import { ICON } from './ui';

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
  const lastAutoAttempt = useRef('');
  const [photoProblems, setPhotoProblems] = useState<{
    id: number;
    fileName: string;
    reason: string;
    attempts: number;
    needsAttention: boolean;
  }[]>([]);

  async function refreshPhotoProblems() {
    try {
      const photos = await listPendingPhotos();
      setPhotoProblems(photos.flatMap((photo) => (
        photo.id != null && photo.lastError
          ? [{
            id: photo.id,
            fileName: photo.fileName,
            reason: photo.lastError,
            attempts: photo.attempts ?? 0,
            needsAttention: photo.state === 'needs_attention',
          }]
          : []
      )));
    } catch {
      // Keep the last known problem list; an empty array would falsely claim recovery.
    }
  }

  useEffect(() => {
    if (queue.pendingUploads === 0) {
      setPhotoProblems([]);
      return;
    }
    void refreshPhotoProblems();
  }, [queue.pendingUploads]);

  async function syncPhotos() {
    await syncPendingDocumentPhotos();
    await refreshPhotoProblems();
  }

  useEffect(() => {
    if (!queue.online || queue.sessionExpired) {
      lastAutoAttempt.current = '';
      return;
    }
    if (queue.pendingActions === 0 && queue.pendingUploads === 0) return;
    const key = [queue.pendingActions, queue.pendingUploads, queue.lastSuccessfulSyncAt].join(':');
    if (lastAutoAttempt.current === key) return;
    lastAutoAttempt.current = key;
    void offlineQueue.sync().then(() => syncPhotos());
  }, [queue.online, queue.pendingActions, queue.pendingUploads, queue.sessionExpired, queue.lastSuccessfulSyncAt]);

  async function syncAll() {
    await offlineQueue.sync();
    await syncPhotos();
  }
  const failures = queue.actions.filter((action) => action.reason && action.state !== 'pending');
  const needsAttentionUploads = photoProblems.filter((photo) => photo.needsAttention).length;
  const syncableUploads = Math.max(0, queue.pendingUploads - needsAttentionUploads);
  const hasSyncableWork = syncableUploads > 0 || queue.actions.some(
    (action) => action.state !== 'conflict' && action.state !== 'needs_attention',
  );
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
          {!queue.online && <CloudOff size={ICON.xs} />}
          {queue.online ? 'מחובר לרשת' : 'אין חיבור לרשת — העבודה נשמרת במכשיר'}
        </span>
        <span>
          פעולות ממתינות:{' '}
          <span className="num" data-testid="offline-pending-actions">{queue.pendingActions}</span>
        </span>
        <span>
          העלאות ממתינות לסנכרון:{' '}
          <span className="num" data-testid="offline-pending-uploads">{syncableUploads}</span>
        </span>
        {needsAttentionUploads > 0 && (
          <span className="text-alert-fg">
            העלאות דורשות טיפול:{' '}
            <span className="num" data-testid="offline-attention-uploads">{needsAttentionUploads}</span>
          </span>
        )}
        <span>
          סנכרון מוצלח אחרון:{' '}
          <span className="num" data-testid="offline-last-sync">
            {queue.lastSuccessfulSyncAt === null ? '—' : fmtDateTime(new Date(queue.lastSuccessfulSyncAt))}
          </span>
        </span>
        {queue.syncing && <span className="text-ink-soft">מסנכרן…</span>}
        <button type="button" className="btn-ghost ms-auto min-h-11 text-xs"
          disabled={queue.syncing || !queue.online || !hasSyncableWork}
          onClick={() => void syncAll()}>
          <RefreshCw size={ICON.xs} /> ניסיון סנכרון עכשיו
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
              {action.conflictCode && (
                <>
                  {' '}— נדרשת הכרעה.{' '}
                  <Link className="font-semibold underline underline-offset-2" to={`/receiving/${action.orderId}`}>
                    פתיחת מסך הקבלה
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {!queue.online && (
        <p className="mt-1.5 text-ink-soft">
          מסכים אחרים דורשים רשת. קונכיית האפליקציה תישאר זמינה, אך נתונים עסקיים שלא נשמרו במסלול הקבלה לא יוצגו מהמטמון.
        </p>
      )}
      {photoProblems.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {photoProblems.map((photo) => (
            <li key={photo.id} className="text-alert-fg">
              {photo.fileName}: {photo.reason}{photo.needsAttention && ' נדרשת התערבות; סנכרון כללי לא ינסה שוב.'}{photo.attempts > 0 && <> <span className="num">(ניסיונות: {photo.attempts})</span></>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import type { StatusMeta } from './status';
import type { DocumentProcessingJob, DocumentProcessingStatus, DocumentRow } from './types';

export type DocumentStatusState =
  | 'stuck'
  | 'failed'
  | 'processing'
  | 'review'
  | 'unassigned'
  | 'assigned'
  | 'completed'
  | 'historical'
  | 'unavailable';

export interface DocumentUiStatus extends StatusMeta {
  state: DocumentStatusState;
  description: string;
  loading: boolean;
  countsAsUnassigned: boolean;
  priority: number;
  elapsedSeconds: number | null;
}

type FilingDocument = Pick<DocumentRow, 'entity_type' | 'entity_id'>;
type ProcessingJob = Pick<
  DocumentProcessingJob,
  'status' | 'attempt_count' | 'lease_until' | 'created_at' | 'updated_at' | 'last_error_code'
> & { is_stuck?: boolean | null; stuck_reason?: string | null };

export interface DocumentStatusInput {
  status?: DocumentProcessingStatus | 'unprocessed' | 'processing' | null;
  job?: ProcessingJob | null;
  document?: FilingDocument | null;
  queueAgeSeconds?: number | null;
  autoAssigned?: boolean;
  autoAssignmentDescription?: string | null;
  evaluatedAt?: number;
  /** Optional canonical answer from a future server contract. When present, it wins. */
  isStuck?: boolean | null;
  stuckReason?: string | null;
}

export const DOCUMENT_STUCK_JOB_AGE_SECONDS = 2 * 60 * 60;
export const DOCUMENT_STUCK_IDLE_SECONDS = 30 * 60;
export const DOCUMENT_STUCK_ATTEMPT_COUNT = 8;

const ACTIVE_RAW_STATUSES: ReadonlySet<string> = new Set([
  'queued', 'leased', 'extracted', 'interpreting', 'processing',
]);

const FAILURE_TEXT: ReadonlyArray<[RegExp, string]> = [
  [/gateway_invalid_response/i, 'שירות עיבוד המסמכים החזיר תשובה לא תקינה. הקובץ נשמר, אך העיבוד לא התקדם.'],
  [/document_deleted/i, 'קובץ המקור הוסר לפני שהעיבוד הושלם.'],
  [/provider_output_truncated/i, 'קריאת המסמך נעצרה לפני שהתקבלה תוצאה מלאה.'],
  [/provider_|ocr_|extraction_/i, 'שירות קריאת המסמך לא הצליח להשלים את הפעולה. הקובץ המקורי נשמר.'],
];

const STUCK_REASON_TEXT: Record<string, string> = {
  claim_attempt_limit_reached: 'העיבוד נעצר לאחר מספר ניסיונות חוזרים. נדרש טיפול לפני ניסיון נוסף.',
  claim_attempt_limit_exceeded: 'העיבוד נעצר לאחר מספר ניסיונות חוזרים. נדרש טיפול לפני ניסיון נוסף.',
  active_over_two_hours: 'המסמך נמצא בתהליך יותר משעתיים ללא השלמה.',
  lease_expired: 'העובד שעיבד את המסמך הפסיק להגיב וההרשאה הזמנית שלו פגה.',
  no_progress: 'לא נרשמה התקדמות בעיבוד המסמך בזמן הצפוי.',
};

function ageSeconds(value: string | null | undefined, evaluatedAt: number): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((evaluatedAt - timestamp) / 1000));
}

function isUnassigned(document: FilingDocument | null | undefined): boolean {
  // `archive` also has a null entity_id, but it is a completed decision to have no business
  // target — not work waiting in the inbox. Only the inbox token means unassigned.
  return document?.entity_type === 'inbox';
}

function assignedLabel(document: FilingDocument | null | undefined, autoAssigned: boolean): string {
  if (autoAssigned) return 'שויך אוטומטית';
  if (document?.entity_type === 'invoice') return 'שויך לחשבונית';
  if (document?.entity_type === 'goods_receipt') return 'שויך לקבלת סחורה';
  return 'משויך';
}

function result(
  state: DocumentStatusState,
  label: string,
  tone: StatusMeta['tone'],
  description: string,
  loading = false,
  elapsedSeconds: number | null = null,
): DocumentUiStatus {
  const priorities: Record<DocumentStatusState, number> = {
    stuck: 0,
    failed: 0,
    processing: 1,
    review: 2,
    unassigned: 3,
    assigned: 4,
    completed: 4,
    historical: 5,
    unavailable: 6,
  };
  return {
    state,
    label,
    tone,
    description,
    loading,
    countsAsUnassigned: state === 'unassigned',
    priority: priorities[state],
    elapsedSeconds,
  };
}

export function isSupersededProcessingFailure(code: string | null | undefined): boolean {
  return code === 'superseded_for_reprocess';
}

export function documentProcessingFailureText(
  code: string | null | undefined,
  _message?: string | null,
): string {
  if (isSupersededProcessingFailure(code)) {
    return 'ניסיון עיבוד קודם הוחלף בניסיון חדש. זהו אירוע היסטורי, לא כשל פעיל.';
  }
  const raw = code ?? '';
  for (const [pattern, text] of FAILURE_TEXT) if (pattern.test(raw)) return text;
  return 'עיבוד המסמך לא הושלם. הקובץ המקורי נשמר ואפשר לנסות שוב.';
}

export function documentProcessingStuckText(reason: string | null | undefined): string {
  return (reason && STUCK_REASON_TEXT[reason])
    ?? 'המסמך לא התקדם לפי הגיל ומספר הניסיונות שנשמרו בשרת. נדרש טיפול.';
}

/**
 * A job is stuck only from persisted server facts. There is no client countdown that changes a
 * healthy row into an alert: the result is re-evaluated when fresh job data arrives. The long-age
 * guard catches a queue that never moved; the idle/lease guards catch a repeatedly reclaimed job.
 */
export function isDocumentProcessingStuck(input: DocumentStatusInput): boolean {
  const canonical = input.isStuck ?? input.job?.is_stuck;
  if (canonical !== undefined && canonical !== null) return canonical;
  const status = input.job?.status ?? input.status;
  if (!status || !ACTIVE_RAW_STATUSES.has(status)) return false;
  const evaluatedAt = input.evaluatedAt ?? Date.now();
  const jobAge = input.queueAgeSeconds ?? ageSeconds(input.job?.created_at, evaluatedAt);
  const idleAge = ageSeconds(input.job?.updated_at, evaluatedAt);
  const leaseAge = ageSeconds(input.job?.lease_until, evaluatedAt);
  const expiredLease = !!input.job?.lease_until
    && Date.parse(input.job.lease_until) <= evaluatedAt;
  const attempts = input.job?.attempt_count ?? 0;

  return attempts >= DOCUMENT_STUCK_ATTEMPT_COUNT
    || (jobAge !== null && jobAge >= DOCUMENT_STUCK_JOB_AGE_SECONDS)
    || (attempts >= 3 && expiredLease && leaseAge !== null && leaseAge >= 5 * 60)
    || (attempts >= 3 && idleAge !== null && idleAge >= DOCUMENT_STUCK_IDLE_SECONDS);
}

/**
 * The single precedence ladder for every document surface:
 * failure/stuck > active processing > human review > unassigned > assigned/completed.
 */
export function documentUiStatus(input: DocumentStatusInput): DocumentUiStatus {
  if (input.status === null && !input.job) {
    return result('unavailable', 'סטטוס נטען', 'idle', 'מצב המסמך נטען כעת');
  }
  const status = input.job?.status ?? input.status ?? 'unprocessed';
  const evaluatedAt = input.evaluatedAt ?? Date.now();
  const elapsed = input.queueAgeSeconds ?? ageSeconds(input.job?.created_at, evaluatedAt);

  if (status === 'failed' && isSupersededProcessingFailure(input.job?.last_error_code)) {
    return result('historical', 'הוחלף בניסיון חדש', 'idle', documentProcessingFailureText(input.job?.last_error_code));
  }
  if (status === 'failed') {
    return result('failed', 'העיבוד נכשל', 'alert', documentProcessingFailureText(input.job?.last_error_code));
  }
  if (isDocumentProcessingStuck(input)) {
    return result('stuck', 'עיבוד תקוע', 'alert', documentProcessingStuckText(
      input.stuckReason ?? input.job?.stuck_reason,
    ), false, elapsed);
  }
  if (ACTIVE_RAW_STATUSES.has(status)) {
    const queued = status === 'queued';
    return result(
      'processing',
      queued ? 'ממתין לעיבוד' : 'בעיבוד',
      queued ? 'await' : 'info',
      queued ? 'המסמך שמור וממתין לתחילת העיבוד' : 'המערכת מעבדת את המסמך',
      true,
      elapsed,
    );
  }
  if (status === 'review') {
    return result('review', 'נדרשת בדיקה', 'await', 'העיבוד הסתיים וממתין להחלטה אנושית');
  }
  if (isUnassigned(input.document)) {
    return result('unassigned', 'לא משויך', 'await', 'המסמך אינו בעיבוד פעיל ועדיין לא שויך ליעד עסקי');
  }
  if (input.document) {
    return result('assigned', assignedLabel(input.document, input.autoAssigned ?? false), 'done',
      input.autoAssignmentDescription ?? 'המסמך שויך ליעד עסקי');
  }
  if (status === 'completed') {
    return result('completed', 'הושלם', 'done', 'עיבוד המסמך הושלם');
  }
  return result('unavailable', 'סטטוס לא זמין', 'idle', 'מצב המסמך אינו זמין כרגע');
}

export function documentStatusElapsedLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return 'פחות מדקה';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} דק׳`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} שע׳`;
  return `${Math.floor(seconds / 86_400)} ימים`;
}

export function documentMatchesFilingFilter(
  status: DocumentUiStatus,
  filing: 'all' | 'unfiled' | 'linked',
): boolean {
  if (filing === 'all') return true;
  if (filing === 'unfiled') return status.countsAsUnassigned;
  return status.state === 'assigned' || status.state === 'completed';
}

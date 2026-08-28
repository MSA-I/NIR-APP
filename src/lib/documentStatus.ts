import type { TKey } from './i18n/t.ts';
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

/**
 * NOT `extends StatusMeta` any more. `StatusMeta` now carries a dictionary KEY, because the whole
 * status vocabulary moved into src/lib/i18n/dictionaries. This type carries a LABEL, because its
 * strings are still literal Hebrew composed at runtime — `result()` builds them from a document's
 * stage, its elapsed seconds and its entity, so there is no fixed key to name them with.
 *
 * That is a debt, not a design: the document-review surface is its own extraction pass, and this
 * type is where it will land. Keeping the two shapes separate is what let the status pass finish
 * without dragging a second vocabulary in half-done.
 */
export interface DocumentUiStatus {
  labelKey: TKey;
  tone: StatusMeta['tone'];
  state: DocumentStatusState;
  /**
   * One sentence the LABEL does not already say — or an empty string.
   *
   * It ships as `title` and as an `sr-only` sibling on every badge, so a sentence that only
   * rephrases the label costs a screen-reader user a second reading of the same fact and buys
   * nothing. "המסמך שמור וממתין לתחילת העיבוד" under a badge reading "ממתין לעיבוד" was exactly
   * that. States with nothing to add carry '' and the badge then renders neither attribute.
   */
  descriptionKey: TKey | null;
  /**
   * Values the description needs, when it has any. Only the machine-filing sentence does — it
   * names a confidence — and carrying them beside the key is what lets that sentence be one
   * sentence rather than a Hebrew fragment concatenated at the call site.
   */
  descriptionVars?: Record<string, string | number>;
  loading: boolean;
  countsAsUnassigned: boolean;
  priority: number;
  elapsedSeconds: number | null;
  /**
   * "עמוד 7 מתוך 27" while a worker is reading the pages, or null.
   *
   * Null in three different situations that all mean the same thing on screen: the job is not
   * reading, the worker build does not report page progress, or it has not reported yet. Printing
   * "עמוד 0 מתוך 0" for those would be a claim about the document that nobody made — the same reason
   * an absent metric renders — rather than 0 (CLAUDE.md).
   */
  /** The page counter as NUMBERS. The badge composes the sentence, so word order is not ours. */
  progress: { done: number; total: number } | null;
}

export type DocumentStatusFilter =
  | 'stuck'
  | 'failed'
  | 'processing'
  | 'review'
  | 'unassigned'
  | 'assigned';

export const DOCUMENT_STATUS_FILTERS: ReadonlyArray<{ value: DocumentStatusFilter; labelKey: TKey }> = [
  { value: 'stuck', labelKey: 'documentStatus.filterStuck' },
  { value: 'failed', labelKey: 'documentStatus.filterFailed' },
  { value: 'processing', labelKey: 'documentStatus.filterProcessing' },
  { value: 'review', labelKey: 'documentStatus.filterReview' },
  { value: 'unassigned', labelKey: 'documentStatus.filterUnassigned' },
  { value: 'assigned', labelKey: 'documentStatus.filterAssigned' },
];

const DOCUMENT_STATUS_FILTER_VALUES = new Set(DOCUMENT_STATUS_FILTERS.map(({ value }) => value));

type FilingDocument = Pick<DocumentRow, 'entity_type' | 'entity_id'>;
type ProcessingJob = Pick<
  DocumentProcessingJob,
  'status' | 'attempt_count' | 'lease_until' | 'created_at' | 'updated_at' | 'last_error_code'
> & {
  queue_age_seconds?: number | null;
  is_stuck?: boolean | null;
  stuck_reason?: string | null;
  progress_done?: number | null;
  progress_total?: number | null;
};

export interface DocumentStatusInput {
  status?: DocumentProcessingStatus | 'unprocessed' | 'processing' | null;
  job?: ProcessingJob | null;
  document?: FilingDocument | null;
  queueAgeSeconds?: number | null;
  autoAssigned?: boolean;
  autoAssignmentDescriptionKey?: TKey | null;
  autoAssignmentDescriptionVars?: Record<string, string | number>;
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

/**
 * What happened, and what the reader can do — never which internal service said it.
 *
 * The reader is a bookkeeper or a business owner (PRODUCT.md). "שירות עיבוד המסמכים החזיר תשובה
 * לא תקינה" named a component they cannot see and left them with no next step; the fact they can
 * act on is that the file survived and the read can be run again.
 */
const FAILURE_KEYS: ReadonlyArray<[RegExp, TKey]> = [
  [/gateway_invalid_response/i, 'documentStatus.failureGatewayInvalid'],
  [/document_deleted/i, 'documentStatus.failureDocumentDeleted'],
  [/provider_output_truncated/i, 'documentStatus.failureOutputTruncated'],
  [/provider_|ocr_|extraction_/i, 'documentStatus.failureProviderGeneric'],
];

/**
 * Each line ends on the same load-bearing fact: it will not resume on its own.
 *
 * That is the whole decision the reader has to make — keep waiting, or act. Naming the worker and
 * its expired lease described our architecture; it did not answer the question.
 */
const STUCK_REASON_KEYS: Record<string, TKey> = {
  claim_attempt_limit_reached: 'documentStatus.stuckAttemptLimit',
  claim_attempt_limit_exceeded: 'documentStatus.stuckAttemptLimit',
  active_over_two_hours: 'documentStatus.stuckOverTwoHours',
  lease_expired: 'documentStatus.stuckLeaseExpired',
  no_progress: 'documentStatus.stuckNoProgress',
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

function isArchived(document: FilingDocument | null | undefined): boolean {
  return document?.entity_type === 'archive';
}

function assignedLabelKey(document: FilingDocument | null | undefined, autoAssigned: boolean): TKey {
  if (autoAssigned) return 'documentStatus.assignedAutomatically';
  if (document?.entity_type === 'invoice') return 'documentStatus.assignedToInvoice';
  if (document?.entity_type === 'goods_receipt') return 'documentStatus.assignedToReceipt';
  return 'documentStatus.assignedGeneric';
}

function result(
  state: DocumentStatusState,
  labelKey: TKey,
  tone: StatusMeta['tone'],
  descriptionKey: TKey | null,
  loading = false,
  elapsedSeconds: number | null = null,
  progress: { done: number; total: number } | null = null,
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
    labelKey,
    tone,
    descriptionKey,
    loading,
    countsAsUnassigned: state === 'unassigned',
    priority: priorities[state],
    elapsedSeconds,
    progress,
  };
}

/**
 * The page counter a reading worker reports, as words — or null when there is nothing to claim.
 *
 * Only while a worker holds the job (`leased`). A queued job has not been opened, and an extracted
 * or interpreting one is past the pages, so carrying the last counter into those states would keep
 * showing movement after the movement stopped.
 */
function pageProgress(
  job: ProcessingJob | null | undefined,
  status: string,
): { done: number; total: number } | null {
  if (status !== 'leased') return null;
  const done = job?.progress_done;
  const total = job?.progress_total;
  if (typeof done !== 'number' || typeof total !== 'number') return null;
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done < 0) return null;
  // The NUMBERS, not the sentence. "page 3 of 8" is composed where it is drawn, so the module
  // stops owning a phrase whose word order is not the same in every language.
  return { done: Math.min(done, total), total };
}

export function isSupersededProcessingFailure(code: string | null | undefined): boolean {
  return code === 'superseded_for_reprocess' || code === 'superseded_for_stuck_recovery';
}

export function documentProcessingFailureKey(
  code: string | null | undefined,
  _message?: string | null,
): TKey {
  if (isSupersededProcessingFailure(code)) {
    return 'documentStatus.failureSuperseded';
  }
  const raw = code ?? '';
  for (const [pattern, key] of FAILURE_KEYS) if (pattern.test(raw)) return key;
  return 'documentStatus.failureFallback';
}

export function documentProcessingStuckKey(reason: string | null | undefined): TKey {
  // The fallback used to recite the heuristic (age, attempt count, "שנשמרו בשרת"). How we
  // concluded it is our business; that the document has stopped and will not restart is theirs.
  return (reason ? STUCK_REASON_KEYS[reason] : null) ?? 'documentStatus.stuckFallback';
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
  const jobAge = input.queueAgeSeconds ?? input.job?.queue_age_seconds
    ?? ageSeconds(input.job?.created_at, evaluatedAt);
  const idleAge = ageSeconds(input.job?.updated_at, evaluatedAt);
  const leaseAge = ageSeconds(input.job?.lease_until, evaluatedAt);
  const expiredLease = !!input.job?.lease_until
    && Date.parse(input.job.lease_until) <= evaluatedAt;
  const attempts = input.job?.attempt_count ?? 0;

  // Mirrors 0132's recovery grace when the server verdict is temporarily unavailable during a
  // rollout: a live or only-recently-expired worker lease gets five minutes before age/attempt
  // thresholds may call it stuck. The server value above still wins whenever 0130 is installed.
  if (status === 'leased' && input.job?.lease_until) {
    const leaseUntil = Date.parse(input.job.lease_until);
    if (Number.isFinite(leaseUntil) && leaseUntil > evaluatedAt - 5 * 60 * 1000) return false;
  }

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
    return result('unavailable', 'documentStatus.statusLoading', 'idle', null);
  }
  const status = input.job?.status ?? input.status ?? 'unprocessed';
  const evaluatedAt = input.evaluatedAt ?? Date.now();
  const elapsed = input.queueAgeSeconds ?? input.job?.queue_age_seconds
    ?? ageSeconds(input.job?.created_at, evaluatedAt);

  if (status === 'failed' && isSupersededProcessingFailure(input.job?.last_error_code)) {
    return result('historical', 'documentStatus.replacedByNewAttempt', 'idle', documentProcessingFailureKey(input.job?.last_error_code));
  }
  // Everything below picks a label first and a description second, and the description is allowed
  // to be empty. See DocumentUiStatus.description: a sentence that restates the badge is not
  // information, and it is read aloud on every row.
  if (status === 'failed') {
    return result('failed', 'documentStatus.processingFailed', 'alert', documentProcessingFailureKey(input.job?.last_error_code));
  }
  if (isDocumentProcessingStuck(input)) {
    return result('stuck', 'documentStatus.processingStuck', 'alert', documentProcessingStuckKey(
      input.stuckReason ?? input.job?.stuck_reason,
    ), false, elapsed);
  }
  if (ACTIVE_RAW_STATUSES.has(status)) {
    const queued = status === 'queued';
    return result(
      'processing',
      queued ? 'documentStatus.waitingToProcess' : 'documentStatus.processing',
      queued ? 'await' : 'info',
      // Both add the same missing fact: nobody is waiting on the reader. A queued document adds
      // the one thing a person who just photographed an invoice wants confirmed — it is saved.
      queued ? 'documentStatus.queuedDescription' : 'documentStatus.processingDescription',
      true,
      elapsed,
      pageProgress(input.job, status),
    );
  }
  if (status === 'review') {
    return result('review', 'documentStatus.needsReview', 'await', 'documentStatus.needsReviewDescription');
  }
  if (isArchived(input.document)) {
    // `entity_type` is the schema's word for it. Nobody outside this repository files a document
    // against a "יעד עסקי" — they attach it to an invoice or to a goods receipt.
    return result('historical', 'documentStatus.archived', 'idle', 'documentStatus.archivedDescription');
  }
  if (isUnassigned(input.document)) {
    return result('unassigned', 'documentStatus.unassigned', 'await', 'documentStatus.unassignedDescription');
  }
  if (input.document) {
    // The only sentence worth carrying here is the supervisory one a machine filing brings with
    // it. "המסמך שויך ליעד עסקי" under a badge reading "שויך לחשבונית" said nothing twice.
    const assigned = result('assigned', assignedLabelKey(input.document, input.autoAssigned ?? false), 'done',
      input.autoAssignmentDescriptionKey ?? null);
    return input.autoAssignmentDescriptionVars
      ? { ...assigned, descriptionVars: input.autoAssignmentDescriptionVars }
      : assigned;
  }
  if (status === 'completed') {
    return result('completed', 'documentStatus.completed', 'done', null);
  }
  return result('unavailable', 'documentStatus.statusUnavailable', 'idle', null);
}

/**
 * How long a document has been in this state, as a key and a number rather than a phrase. The
 * unit and the figure are ordered differently in different languages, so the sentence belongs
 * where it is drawn.
 */
export function documentStatusElapsed(
  seconds: number | null,
): { key: TKey; vars?: Record<string, number> } | null {
  if (seconds === null) return null;
  if (seconds < 60) return { key: 'documentStatus.elapsedUnderMinute' };
  if (seconds < 3600) return { key: 'documentStatus.elapsedMinutes', vars: { count: Math.floor(seconds / 60) } };
  if (seconds < 86_400) return { key: 'documentStatus.elapsedHours', vars: { count: Math.floor(seconds / 3600) } };
  return { key: 'documentStatus.elapsedDays', vars: { count: Math.floor(seconds / 86_400) } };
}

export function documentMatchesFilingFilter(
  status: DocumentUiStatus,
  filing: 'all' | 'unfiled' | 'linked',
): boolean {
  if (filing === 'all') return true;
  if (filing === 'unfiled') return status.countsAsUnassigned;
  return status.state === 'assigned' || status.state === 'completed';
}

/**
 * Old URLs used raw pipeline stages. They are ambiguous under canonical precedence: a queued job
 * may be stuck, a failed job may be superseded history, and an unprocessed document may already
 * be assigned. Therefore only current canonical filter tokens survive; old tokens fall back to
 * "all" instead of showing a control that claims a filter different from the rendered badges.
 */
export function documentStatusFilterFromParam(value: string | null): DocumentStatusFilter | null {
  if (!value) return null;
  if (DOCUMENT_STATUS_FILTER_VALUES.has(value as DocumentStatusFilter)) return value as DocumentStatusFilter;
  return null;
}

export function documentMatchesStatusFilter(
  status: DocumentUiStatus,
  filter: DocumentStatusFilter | 'all',
): boolean {
  if (filter === 'all') return true;
  if (filter === 'assigned') return status.state === 'assigned' || status.state === 'completed';
  return status.state === filter;
}

import type { StatusMeta } from '../lib/status';
import { documentUiStatus, type DocumentStatusInput, type DocumentUiStatus } from '../lib/documentStatus';

// `calibrationReviewRpcName` and `normalizeIncorrectCalibration` were deleted here (19.08.2026):
// migration 0135 revoked the calibration-review laboratory surface from `authenticated`, so the
// tenant had a review queue with no way to answer it — the only "caller" left was their own spec.

export interface OperationalAttemptState {
  status: string;
  price_list_outcome: string | null;
  reversal_known?: boolean;
  reverted?: boolean | null;
  attempt_count?: number;
  created_at?: string;
  updated_at?: string;
  lease_until?: string | null;
  queue_age_seconds?: number | null;
  last_error_code?: string | null;
  is_stuck?: boolean | null;
  stuck_reason?: string | null;
}

/** One user-facing vocabulary for the queue, attempt table and history drilldown. */
export function attemptUiStatus(attempt: OperationalAttemptState): DocumentUiStatus {
  const canonical = documentUiStatus({
    status: attempt.status as DocumentStatusInput['status'],
    job: {
      status: attempt.status as never,
      attempt_count: attempt.attempt_count ?? 0,
      created_at: attempt.created_at ?? '',
      updated_at: attempt.updated_at ?? '',
      lease_until: attempt.lease_until ?? null,
      last_error_code: attempt.last_error_code ?? null,
    },
    queueAgeSeconds: attempt.queue_age_seconds,
    isStuck: attempt.is_stuck,
    stuckReason: attempt.stuck_reason,
  });
  if (attempt.reversal_known && attempt.reverted) {
    return { ...canonical, state: 'historical', label: 'בוטל', tone: 'idle', description: 'הפעולה בוטלה ונשמרה בהיסטוריה.', loading: false, priority: 5 };
  }
  if (canonical.state === 'failed' || canonical.state === 'stuck'
    || canonical.state === 'processing' || canonical.state === 'historical') {
    return canonical;
  }
  if (attempt.price_list_outcome === 'partially_applied') {
    return { ...canonical, state: 'review', label: 'הוחל חלקית', tone: 'await', description: 'חלק מהשורות הוחלו; השאר ממתינות לבדיקה.', priority: 2 };
  }
  if (attempt.status === 'review' || attempt.price_list_outcome === 'queued_for_review') {
    // Same words as documentStatus.ts's review branch, on purpose: this screen and the inbox are
    // looking at one state, and a second phrasing here is how the vocabulary split in the first place.
    return { ...canonical, state: 'review', label: 'נדרשת בדיקה', tone: 'await', description: 'הקריאה הסתיימה. צריך לאשר את הנתונים.', priority: 2 };
  }
  if (attempt.price_list_outcome === 'auto_applied') {
    // The supervisory fact, not the pipeline's: prices moved without anyone approving them.
    return { ...canonical, state: 'completed', label: 'הוחל אוטומטית', tone: 'done', description: 'המחירים עודכנו אוטומטית, ללא אישור אדם.', priority: 4 };
  }
  if (attempt.status === 'completed') return canonical;
  return { ...canonical, state: 'unavailable', label: 'מצב לא ידוע', tone: 'idle', description: '', priority: 6 };
}

export function attemptStatusMeta(attempt: OperationalAttemptState): StatusMeta {
  const { label, tone } = attemptUiStatus(attempt);
  return { label, tone };
}

/** Chooses the one alert shown above the operations ledger from CURRENT attempts only. */
export function selectPrimaryOperationalIssue<T extends OperationalAttemptState & { updated_at: string }>(
  currentAttempts: readonly T[],
): T | null {
  return [...currentAttempts]
    .filter((attempt) => ['failed', 'stuck'].includes(attemptUiStatus(attempt).state))
    .sort((left, right) => {
      // A stuck attempt is recoverable active work; a failure is terminal. The recoverable item
      // owns the scarce primary-alert slot even when an unrelated failure was updated later.
      const leftRank = attemptUiStatus(left).state === 'stuck' ? 0 : 1;
      const rightRank = attemptUiStatus(right).state === 'stuck' ? 0 : 1;
      return leftRank - rightRank || Date.parse(right.updated_at) - Date.parse(left.updated_at);
    })[0] ?? null;
}

type RecoveryInvokeResponse = {
  data?: unknown;
  error?: unknown;
  response?: unknown;
};

function recoveryPayloadMessage(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  return trimmed && trimmed.length <= 1000 ? trimmed : null;
}

async function recoveryResponseMessage(value: unknown): Promise<string | null> {
  if (!value || typeof value !== 'object') return null;
  const response = value as { clone?: () => unknown; json?: () => Promise<unknown> };
  try {
    const readable = typeof response.clone === 'function' ? response.clone() : response;
    if (!readable || typeof readable !== 'object') return null;
    const json = (readable as { json?: () => Promise<unknown> }).json;
    if (typeof json !== 'function') return null;
    return recoveryPayloadMessage(await json.call(readable));
  } catch {
    return null;
  }
}

/**
 * functions-js leaves non-2xx JSON unparsed: `data` is null and the original Response is exposed
 * as `response` (and as `error.context`). Read the Edge function's stable, public Hebrew message
 * before falling back to the SDK's generic FunctionsHttpError text.
 */
export async function recoveryInvokeErrorMessage(result: RecoveryInvokeResponse): Promise<string | null> {
  const fromData = recoveryPayloadMessage(result.data);
  if (fromData) return fromData;
  const fromResponse = await recoveryResponseMessage(result.response);
  if (fromResponse) return fromResponse;
  const context = result.error && typeof result.error === 'object'
    ? (result.error as { context?: unknown }).context
    : null;
  return recoveryResponseMessage(context);
}

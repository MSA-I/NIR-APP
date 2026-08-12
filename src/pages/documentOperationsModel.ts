import type { StatusMeta } from '../lib/status';
import { documentUiStatus, type DocumentStatusInput, type DocumentUiStatus } from '../lib/documentStatus';

export type CalibrationAction = 'apply_existing_price' | 'create_product' | 'review' | 'rejected_by_policy';

export interface CalibrationPrediction {
  predicted_action: CalibrationAction;
  product_id: string | null;
  proposed_unit_price: number | null;
}

export const calibrationReviewRpcName = (isEmptyRun: boolean) => isEmptyRun
  ? 'record_price_list_empty_run_review'
  : 'record_price_list_calibration_review';

export function normalizeIncorrectCalibration(
  row: CalibrationPrediction,
  action: CalibrationAction,
  expectedProductId: string,
  expectedPrice: string,
  labels: string[],
): { productId: string | null; unitPrice: number | null; problem: string | null } {
  if (labels.length === 0) return { productId: null, unitPrice: null, problem: 'יש לבחור לפחות סוג טעות אחד.' };
  let productId: string | null = expectedProductId || null;
  let unitPrice: number | null = expectedPrice === '' ? null : Number(expectedPrice);
  if (action === 'review' || action === 'rejected_by_policy') {
    productId = null;
    unitPrice = null;
  } else {
    if (unitPrice === null || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      return { productId: null, unitPrice: null, problem: 'המחיר הנכון הוא שדה חובה וחייב להיות מספר חיובי.' };
    }
    if (action === 'create_product') productId = null;
  }
  if (action === 'apply_existing_price' && !productId) {
    return { productId, unitPrice, problem: 'יש לבחור מוצר כאשר ההחלטה האנושית היא עדכון מוצר קיים.' };
  }
  if (labels.includes('incorrect_action') && action === row.predicted_action) {
    return { productId, unitPrice, problem: 'סיווג "פעולה שגויה" מחייב לבחור פעולה שונה מהתחזית.' };
  }
  if (labels.includes('incorrect_product_match') && action === 'apply_existing_price'
    && productId === row.product_id) {
    return { productId, unitPrice, problem: 'סיווג "התאמת מוצר שגויה" מחייב לבחור מוצר אחר.' };
  }
  if (labels.includes('incorrect_new_product') && action === 'create_product') {
    return { productId, unitPrice, problem: 'סיווג "יצירת מוצר שגויה" מחייב לבחור פעולה שאינה יצירת מוצר.' };
  }
  if (labels.includes('incorrect_price') && unitPrice === row.proposed_unit_price) {
    return { productId, unitPrice, problem: 'סיווג "מחיר שגוי" מחייב להזין מחיר שונה.' };
  }
  return { productId, unitPrice, problem: null };
}

export interface OperationalAttemptState {
  status: string;
  price_list_outcome: string | null;
  reversal_known: boolean;
  reverted: boolean | null;
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
    return { ...canonical, state: 'historical', label: 'בוטל', tone: 'idle', description: 'הפעולה בוטלה ונשמרה בהיסטוריה', loading: false, priority: 5 };
  }
  if (canonical.state === 'failed' || canonical.state === 'stuck'
    || canonical.state === 'processing' || canonical.state === 'historical') {
    return canonical;
  }
  if (attempt.price_list_outcome === 'partially_applied') {
    return { ...canonical, state: 'review', label: 'הוחל חלקית', tone: 'await', description: 'חלק מהשורות הוחלו וחלק עדיין ממתינות לבדיקה', priority: 2 };
  }
  if (attempt.status === 'review' || attempt.price_list_outcome === 'queued_for_review') {
    return { ...canonical, state: 'review', label: 'נדרשת בדיקה', tone: 'await', description: 'העיבוד הסתיים וממתין להחלטה אנושית', priority: 2 };
  }
  if (attempt.price_list_outcome === 'auto_applied') {
    return { ...canonical, state: 'completed', label: 'הוחל אוטומטית', tone: 'done', description: 'העיבוד והפעולה האוטומטית הושלמו', priority: 4 };
  }
  if (attempt.status === 'completed') return canonical;
  return { ...canonical, state: 'unavailable', label: 'מצב לא ידוע', tone: 'idle', description: 'מצב הניסיון אינו זמין', priority: 6 };
}

export function attemptStatusMeta(attempt: OperationalAttemptState): StatusMeta {
  const { label, tone } = attemptUiStatus(attempt);
  return { label, tone };
}

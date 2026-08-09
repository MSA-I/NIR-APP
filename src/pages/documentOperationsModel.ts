import type { StatusMeta } from '../lib/status';

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
}

/** One user-facing vocabulary for the queue, attempt table and history drilldown. */
export function attemptStatusMeta(attempt: OperationalAttemptState): StatusMeta {
  if (attempt.reversal_known && attempt.reverted) return { label: 'בוטל', tone: 'idle' };
  if (attempt.status === 'failed') return { label: 'נכשל', tone: 'alert' };
  if (['queued', 'leased', 'extracted', 'interpreting'].includes(attempt.status)) {
    return attempt.status === 'queued' ? { label: 'ממתין', tone: 'await' } : { label: 'בעיבוד', tone: 'info' };
  }
  if (attempt.price_list_outcome === 'partially_applied') return { label: 'הוחל חלקית', tone: 'await' };
  if (attempt.status === 'review' || attempt.price_list_outcome === 'queued_for_review') return { label: 'נדרשת בדיקה', tone: 'await' };
  if (attempt.price_list_outcome === 'auto_applied') return { label: 'הוחל אוטומטית', tone: 'done' };
  if (attempt.status === 'completed') return { label: 'הושלם', tone: 'done' };
  return { label: 'מצב לא ידוע', tone: 'idle' };
}

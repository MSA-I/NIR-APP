import type { DocumentExportTemplate } from '../../lib/documentExport';
import type {
  DocumentAnnotation,
  DocumentFeedback,
  DocumentExportTemplateRow,
  DocumentExportTemplateVersion,
  DocumentLearningRule,
  DocumentProcessingSnapshot,
  DocumentReviewCorrection,
  DocumentTypeReviewDecision,
  InterpretationContract,
} from '../../lib/useDocumentProcessing';
import type { ExtractionContract, Role } from '../../lib/types';

export type { DocumentFeedback, DocumentReviewCorrection, DocumentTypeReviewDecision };

export type ReviewSnapshot = DocumentProcessingSnapshot;

export type ReviewTarget =
  | {
      kind: 'block';
      id: string;
      page: number;
      text: string;
      bbox: ExtractionContract['blocks'][number]['bbox'];
      label: string;
    }
  | {
      kind: 'mark';
      id: string;
      page: number;
      bbox: ExtractionContract['marks'][number]['bbox'];
      markKind: ExtractionContract['marks'][number]['kind'];
      fingerprint: string | null;
      label: string;
    }
  | {
      kind: 'table_cell';
      id: string;
      page: number;
      rowIndex: number;
      columnIndex: number;
      text: string;
      bbox: ExtractionContract['tables'][number]['rows'][number][number]['bbox'];
      label: string;
    };

export const DOCUMENT_TYPE_LABELS: Record<InterpretationContract['document_type'], string> = {
  invoice: 'חשבונית',
  delivery_note: 'תעודת משלוח',
  credit_note: 'חשבונית זיכוי',
  price_list: 'מחירון',
  quote: 'הצעת מחיר',
  payment_confirmation: 'אישור תשלום',
  other: 'מסמך אחר',
};

export const MARK_KIND_LABELS: Record<ExtractionContract['marks'][number]['kind'], string> = {
  circle: 'עיגול',
  check: 'סימון וי',
  cross: 'איקס',
  underline: 'קו תחתון',
  star: 'כוכב',
  custom: 'סימון מותאם',
  unknown: 'סימון לא מזוהה',
};

// `claude` is a legacy stored token, kept because it is baked into two CHECK constraints in
// migration 0046. Per the project constitution the display label changes here, not the enum.
export const ANNOTATION_SOURCE_LABELS: Record<DocumentAnnotation['source'], string> = {
  claude: 'הצעה אוטומטית',
  rule: 'כלל שנלמד',
  user: 'הערת משתמש',
};

export function confidenceLabel(value: number | null | undefined): string {
  return value == null ? 'רמת ביטחון לא ידועה' : `רמת ביטחון ${Math.round(value * 100)}%`;
}

export function bboxDescription(box: ExtractionContract['blocks'][number]['bbox'] | null): string {
  if (!box) return 'מיקום התא אינו זמין';
  const [xMin, yMin, xMax, yMax] = box.map((value) => Math.round(value * 100));
  return `מיקום בעמוד: ${xMin}%–${xMax}% לרוחב, ${yMin}%–${yMax}% לגובה`;
}

// Keys are chosen by the model, not fixed by the contract, so they are matched by name. Only
// unambiguous names are listed: a bare `סה"כ` is the quantity subtotal on these invoices, not the
// money total, and treating it as money would compare the wrong two columns.
const QUANTITY_KEYS = ['quantity', 'qty', 'כמות'];
const UNIT_PRICE_KEYS = ['unit_price', 'unitprice', 'price_per_unit', 'price', 'מחיר ליחידה', 'מחיר יחידה'];
const LINE_TOTAL_KEYS = ['line_total', 'linetotal', 'total_price', 'line_amount', 'total', 'amount', 'סה"כ מחיר'];

/** "1,392.00", "₪ 31.90" and 31.9 all become numbers; anything else becomes null. */
function numericValue(value: string | number | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  // Strip currency, thousands separators and the bidi marks that survive RTL transcription.
  const cleaned = value.replace(/[\s,₪]|[‎‏‪-‮]/g, '');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
}

export interface LineItemArithmetic {
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  expected: number;
  consistent: boolean;
}

/**
 * quantity x unit price = line total, when the interpretation offered all three as numbers.
 *
 * Measured on 84 real Hebrew invoice rows: this caught two of the three transcription errors that
 * moved money, with no false positives. It did NOT catch the third, where the unit price and the
 * line total drifted together and still multiplied out. A pass means "nothing obviously wrong",
 * never "verified" — the human approval step remains the thing that protects the price.
 */
export function lineItemArithmetic(
  values: InterpretationContract['line_items'][number]['values'],
): LineItemArithmetic | null {
  const pick = (candidates: readonly string[]): number | null => {
    for (const [key, value] of Object.entries(values)) {
      if (!candidates.includes(key.trim().toLowerCase())) continue;
      const parsed = numericValue(value);
      if (parsed !== null) return parsed;
    }
    return null;
  };
  const quantity = pick(QUANTITY_KEYS);
  const unitPrice = pick(UNIT_PRICE_KEYS);
  const lineTotal = pick(LINE_TOTAL_KEYS);
  if (quantity === null || unitPrice === null || lineTotal === null) return null;
  const expected = Math.round(quantity * unitPrice * 100) / 100;
  return {
    quantity,
    unitPrice,
    lineTotal,
    expected,
    consistent: Math.abs(expected - lineTotal) <= 0.02,
  };
}

export function correctionKey(
  kind: 'block' | 'table_cell',
  id: string,
  rowIndex: number | null = null,
  columnIndex: number | null = null,
): string {
  return `${kind}:${id}:${rowIndex ?? '-'}:${columnIndex ?? '-'}`;
}

/**
 * Who performed a review action, as a name. Falls back to — when the profile is not readable
 * (a supplier account cannot see tenant staff) or no longer exists. Never renders the raw uuid:
 * an identifier tells a kitchen manager or bookkeeper nothing, and — is the truthful "unknown".
 */
export function actorName(snapshot: ReviewSnapshot, actorId: string): string {
  return snapshot.actorNames.get(actorId) ?? '—';
}

export function latestCorrections(rows: ReviewSnapshot['reviewCorrections']) {
  const latest = new Map<string, ReviewSnapshot['reviewCorrections'][number]>();
  for (const row of rows) {
    const key = correctionKey(row.target_kind, row.target_id, row.row_index, row.column_index);
    const previous = latest.get(key);
    if (!previous || row.revision > previous.revision) latest.set(key, row);
  }
  return latest;
}

export function latestTypeReviewDecision(
  rows: ReviewSnapshot['typeReviewDecisions'],
): DocumentTypeReviewDecision | null {
  return rows.reduce<DocumentTypeReviewDecision | null>(
    (latest, row) => !latest || row.revision > latest.revision ? row : latest,
    null,
  );
}

export function latestFeedbackByAnnotation(rows: ReviewSnapshot['feedback']) {
  const latest = new Map<string, DocumentFeedback>();
  for (const row of rows) {
    const previous = latest.get(row.annotation_id);
    if (!previous
        || row.created_at > previous.created_at
        || (row.created_at === previous.created_at && row.id > previous.id)) {
      latest.set(row.annotation_id, row);
    }
  }
  return latest;
}

export function resolvedText(
  original: string,
  latest: ReturnType<typeof latestCorrections>,
  kind: 'block' | 'table_cell',
  id: string,
  rowIndex: number | null = null,
  columnIndex: number | null = null,
): { text: string; revision: number; corrected: boolean } {
  const correction = latest.get(correctionKey(kind, id, rowIndex, columnIndex));
  return correction
    ? { text: correction.corrected_text, revision: correction.revision, corrected: true }
    : { text: original, revision: 0, corrected: false };
}

export function pageNumbers(payload: ExtractionContract): number[] {
  return Array.from({ length: payload.document.page_count }, (_, index) => index + 1);
}

export function activeTemplateContract(
  row: DocumentExportTemplateRow,
  versions: DocumentExportTemplateVersion[],
): DocumentExportTemplate | null {
  return versions.find((version) => version.id === row.active_version_id)?.contract ?? null;
}

export function resolveExportTemplateWinner(snapshot: ReviewSnapshot, actorId: string) {
  const interpretation = snapshot.interpretation;
  if (!interpretation) return null;
  const documentType = interpretation.payload.document_type;
  const supplierId = interpretation.suggested_supplier_id;

  const candidates = snapshot.exportTemplates.flatMap((row) => {
    if (row.org_id !== interpretation.org_id
        || !row.active
        || (row.owner_user_id !== null && row.owner_user_id !== actorId)) return [];
    const version = snapshot.exportTemplateVersions.find((item) =>
      item.id === row.active_version_id
      && item.template_id === row.id
      && item.org_id === row.org_id
      && item.approved_by !== null
      && item.approved_at !== null);
    if (!version) return [];

    let priority: number | null = null;
    if (supplierId !== null && row.owner_user_id === actorId
        && row.supplier_id === supplierId && row.document_type === null) priority = 1;
    else if (supplierId !== null && row.owner_user_id === null
        && row.supplier_id === supplierId && row.document_type === null) priority = 2;
    else if (row.owner_user_id === actorId && row.supplier_id === null
        && row.document_type === documentType) priority = 3;
    else if (row.owner_user_id === null && row.supplier_id === null
        && row.document_type === documentType) priority = 4;
    else if (row.owner_user_id === null && row.supplier_id === null
        && row.document_type === null) priority = 5;

    return priority === null ? [] : [{ row, version, contract: version.contract, priority }];
  });

  return candidates.sort((left, right) => left.priority - right.priority)[0] ?? null;
}

export function canManageOrganizationRules(role: Role): boolean {
  return role === 'owner' || role === 'office';
}

export function ruleWhy(rule: DocumentLearningRule | null | undefined): string {
  if (!rule) return 'הכלל התאים לסימון לפי הקדימות שנשמרה במערכת.';
  const owner = rule.user_id ? 'כלל אישי' : 'כלל ארגוני';
  const context = rule.supplier_id
    ? 'לספק ולסוג המסמך'
    : rule.document_type
      ? 'לסוג המסמך'
      : 'גלובלי';
  const fingerprint = rule.mark_fingerprint ? 'וטביעת הסימון התאימה' : 'ללא הגבלת טביעת סימון';
  return `${owner} ${context}, גרסה ${rule.version}; ${fingerprint}.`;
}

/**
 * The review screen's model: what the server said, and what a person is about to authorise.
 *
 * Every type here mirrors the shape `public.get_document_review_assessment` (0109) returns and the
 * shape `public.apply_reviewed_document` (0110) accepts. Nothing in this file decides anything —
 * the server recomputes the assessment over whatever proposal is submitted and refuses what it
 * still blocks — so a bug here can only mislead a person, never let a bad document through.
 *
 * "Only mislead" is not a small thing. This is the screen where someone presses a button that
 * creates a payable, so the two jobs it has are to say what is wrong in words a bookkeeper uses,
 * and to say plainly what pressing the button will and will not do.
 */

export type FindingSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface AssessmentFinding {
  code: string;
  severity: FindingSeverity;
  message?: string | null;
  line_index?: number | null;
  [key: string]: unknown;
}

export interface AssessmentLine {
  line_index: number;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  product_id: string | null;
  product_source: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  discount_amount: number | null;
  vat_rate: number | null;
  line_total: number | null;
  normalized_quantity: number | null;
  normalized_unit_price: number | null;
  baseline_price: number | null;
  baseline_source: string | null;
  baseline_effective_date: string | null;
  overcharge_amount: number | null;
  findings: AssessmentFinding[];
}

export interface AssessmentOrderItem {
  purchase_order_item_id: string;
  product_id: string;
  product_name: string;
  ordered_quantity: number;
  received_quantity: number;
  recorded_received_qty: number | null;
  unit: string | null;
  on_this_document: boolean;
}

export interface DocumentAssessment {
  document_type: string | null;
  document_number: string | null;
  document_date: string | null;
  supplier_id: string | null;
  order_id: string | null;
  sources: { document: boolean; ordered: boolean; received: boolean; baseline: boolean };
  totals: {
    lines_net: number | null;
    header_net: number | null;
    header_vat: number | null;
    header_total: number | null;
    overcharge_total: number | null;
  };
  severity: FindingSeverity;
  approval_blocked: boolean;
  lines: AssessmentLine[];
  order_items: AssessmentOrderItem[];
  findings: AssessmentFinding[];
}

export interface ResolutionCandidate {
  matched_by: string;
  authoritative: boolean;
  evidence?: string | null;
  [key: string]: unknown;
}

export interface Resolution {
  resolved: boolean;
  matched_by: string | null;
  reason: string | null;
  candidates: ResolutionCandidate[];
  supplier_id?: string | null;
  order_id?: string | null;
}

export interface DocumentReviewRead {
  document_id: string;
  file_name: string | null;
  document_kind: string | null;
  document_type: string | null;
  document_date: string | null;
  /** Two states, never one word. See `storageAndApprovalSentences`. */
  file_stored: boolean;
  data_approved: boolean;
  interpretation_id: string | null;
  supplier_resolution: Resolution | null;
  order_resolution: Resolution | null;
  assessment: DocumentAssessment | null;
  state: 'awaiting_interpretation' | 'supplier_unresolved' | 'blocked' | 'ready_for_approval';
}

/**
 * A finding code in the words the person reading it uses.
 *
 * The server already sends a Hebrew `message` per finding, and that message wins — it carries the
 * specific numbers. This map is the fallback for a code this build has not met, and the short
 * label for a summary line. A code with no entry falls back to the code itself rather than to
 * "שגיאה לא ידועה", because a bookkeeper on the phone to support can read a code aloud.
 */
export const FINDING_LABELS: Record<string, string> = {
  duplicate_document: 'מסמך כפול',
  supplier_mismatch: 'ההזמנה שייכת לספק אחר',
  currency_not_ils: 'מטבע שאינו שקל',
  product_unidentified: 'מוצר לא מזוהה',
  product_repeated_on_document: 'מוצר חוזר ביותר משורה אחת',
  product_charged_not_ordered: 'מוצר שחויב ולא הוזמן',
  ordered_not_on_document: 'הוזמן ואינו במסמך הזה',
  quantity_unreadable: 'כמות שלא ניתן לקרוא',
  quantity_above_ordered: 'כמות מעל מה שהוזמן',
  quantity_differs_from_ordered: 'כמות שונה מההזמנה',
  quantity_above_received: 'כמות מעל מה שהתקבל',
  receipt_recorded_exception: 'נרשמו חסר, פגם או החזרה',
  unit_or_packaging_mismatch: 'אי-התאמת יחידה או אריזה',
  legacy_order_unit_snapshot_missing: 'להזמנה ההיסטורית אין יחידת מידה שמורה',
  price_above_baseline: 'מחיר מעל המחיר המוסכם',
  price_below_baseline: 'מחיר מתחת למחיר המוסכם',
  price_baseline_unknown: 'אין מחיר מוסכם להשוואה',
  vat_rate_mismatch: 'שיעור מע"מ שונה',
  line_arithmetic_discrepancy: 'חישוב שורה שאינו מסתדר',
  header_total_differs_from_lines: 'סה"כ בכותרת שונה מסכום השורות',
  header_arithmetic_discrepancy: 'סה"כ לפני מע"מ ומע"מ אינם מסתכמים לסה"כ',
  credit_required: 'נדרש זיכוי',
};

export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0, error: 1, warning: 2, info: 3,
};

export function findingLabel(finding: AssessmentFinding): string {
  return finding.message || FINDING_LABELS[finding.code] || finding.code;
}

/** Findings that stop approval, hardest first. These are the work list, not a report. */
export function blockingFindings(assessment: DocumentAssessment | null): AssessmentFinding[] {
  if (!assessment) return [];
  return assessment.findings
    .filter((finding) => finding.severity === 'critical' || finding.severity === 'error')
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function advisoryFindings(assessment: DocumentAssessment | null): AssessmentFinding[] {
  if (!assessment) return [];
  return assessment.findings.filter(
    (finding) => finding.severity === 'warning' || finding.severity === 'info');
}

export interface ApprovalEffect {
  /** `false` means "this will NOT happen" — the sentences that build trust in the button. */
  happens: boolean;
  text: string;
}

/**
 * What pressing the button will do, and what it will not.
 *
 * Every line here is a statement about `public.apply_reviewed_document` (0110) and is written from
 * that command's actual branches rather than from an intention. The negative sentences are not
 * padding: "this will not move your stock" is the single most useful thing to read before
 * approving a delivery note, and it is exactly the guarantee the command's anchors enforce.
 */
export function approvalEffects(
  documentType: string | null,
  orderResolved: boolean,
): ApprovalEffect[] {
  switch (documentType) {
    case 'invoice':
      return [
        { happens: true, text: 'תיווצר חשבונית ספק במצב "התקבלה" — לא מאושרת לתשלום' },
        { happens: true, text: 'שורות המסמך יישמרו כראיה לבדיקת ההתאמה' },
        orderResolved
          ? { happens: true, text: 'החשבונית תקושר להזמנה שנבחרה' }
          : { happens: false, text: 'לא תקושר הזמנה — המסמך יישמר בלי הזמנה, וזה מצב לגיטימי' },
        { happens: false, text: 'לא ישתנו כמויות שהתקבלו ולא סטטוס ההזמנה — חיוב אינו קבלה' },
        { happens: false, text: 'לא יבוצע תשלום ולא תאושר החשבונית לתשלום' },
      ];
    case 'delivery_note':
      return [
        { happens: true, text: 'תיווצר טיוטת קבלת סחורה מקושרת להזמנה שנבחרה' },
        { happens: true, text: 'השורות שהמיפוי שלהן ברור ייכנסו לטיוטה' },
        { happens: false, text: 'לא ישתנו כמויות שהתקבלו, מלאי או סטטוס ההזמנה' },
        { happens: false, text: 'לא תיווצר חשבונית ולא חיוב' },
        { happens: false, text: 'רק אישור נפרד שהסחורה התקבלה בפועל ישלים את הקבלה' },
      ];
    case 'tax_receipt':
      return [
        { happens: true, text: 'הקבלה תקושר לחשבונית קיימת או לתשלום שכבר נרשם' },
        { happens: false, text: 'לא תיווצר חשבונית, לא תשלום ולא חיוב מכל סוג' },
        { happens: false, text: 'אם לא ניתן לקשר — לא ייווצר קישור, והמסמך יישאר לבדיקה ידנית' },
      ];
    default:
      return [{ happens: false, text: 'לסוג המסמך הזה אין עדיין מסלול אישור' }];
  }
}

/**
 * The two sentences the screen must never merge.
 *
 * A person who photographed an invoice beside a delivery truck has achieved exactly one thing: the
 * file cannot be lost. Nothing about their business has changed. One word — "נשמר" — covering both
 * is how someone walks away believing an invoice was recorded when it is sitting in a queue.
 */
export function storageAndApprovalSentences(read: DocumentReviewRead): [string, string] {
  return [
    read.file_stored
      ? 'הקובץ נשמר באחסון הפרטי ולא ילך לאיבוד'
      : 'הקובץ עדיין לא נשמר',
    read.data_approved
      ? 'הנתונים אושרו ונרשמו במערכת'
      : 'הנתונים עדיין לא אושרו — שום דבר כספי לא נרשם',
  ];
}

export interface ReviewedLineEdit {
  product_id?: string | null;
  quantity?: string | null;
  unit?: string | null;
  unit_price?: string | null;
  line_total?: string | null;
}

export interface ReviewedProposal {
  document_type: string;
  supplier_id: string;
  order_id: string | null;
  document_number: string | null;
  document_date: string | null;
  totals: { net?: string; vat?: string; total?: string };
  lines: Record<string, string | null>[];
}

const numeric = (value: number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * The proposal, built from what the server read plus what the person changed.
 *
 * Values go over the wire as STRINGS, deliberately. The server reads every number through
 * `private.interpretation_number` — the one numeric reader the whole pipeline shares — so a number
 * that survives a round trip through JavaScript's float is never what gets recorded. The client's
 * job is transcription, not arithmetic.
 */
export function reviewedProposal(
  read: DocumentReviewRead,
  supplierId: string,
  orderId: string | null,
  edits: Record<number, ReviewedLineEdit>,
): ReviewedProposal {
  const assessment = read.assessment;
  return {
    document_type: read.document_type || '',
    supplier_id: supplierId,
    order_id: orderId,
    document_number: assessment?.document_number ?? null,
    document_date: assessment?.document_date ?? read.document_date ?? null,
    totals: {
      ...(assessment?.totals.header_net != null
        ? { net: String(assessment.totals.header_net) } : {}),
      ...(assessment?.totals.header_vat != null
        ? { vat: String(assessment.totals.header_vat) } : {}),
      ...(assessment?.totals.header_total != null
        ? { total: String(assessment.totals.header_total) } : {}),
    },
    lines: (assessment?.lines ?? []).map((line) => {
      const edit = edits[line.line_index] ?? {};
      return {
        product_id: edit.product_id ?? line.product_id,
        sku: line.sku,
        barcode: line.barcode,
        description: line.description,
        quantity: edit.quantity ?? numeric(line.quantity),
        unit: edit.unit ?? line.unit,
        unit_price: edit.unit_price ?? numeric(line.unit_price),
        discount_amount: numeric(line.discount_amount),
        vat_rate: numeric(line.vat_rate),
        line_total: edit.line_total ?? numeric(line.line_total),
      };
    }),
  };
}

/**
 * May the button be pressed at all?
 *
 * This is a courtesy, not a control: 0110 recomputes the assessment over the submitted proposal and
 * refuses on its own. Disabling the button here only saves a person from a round trip and an error
 * message — which is why it deliberately errs toward ENABLED whenever the client cannot be sure,
 * rather than blocking a person out of a decision the server would have allowed.
 */
export function canSubmit(read: DocumentReviewRead, supplierId: string | null): boolean {
  if (!read.interpretation_id || !supplierId) return false;
  if (!read.document_type) return false;
  if (read.document_type === 'delivery_note' && !read.assessment?.order_id) return false;
  return true;
}

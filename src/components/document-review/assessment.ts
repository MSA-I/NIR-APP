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

/**
 * THE CURRENCY EVERY FIGURE ON THE INTAKE SCREENS IS IN.
 *
 * Not an assumption and not a display default: intake REFUSES a document in any other currency
 * today — `0108` blocks it and `currency_not_ils` is a blocking finding — so a document that
 * reached a review screen is a shekel document, and saying so is a statement about the data
 * rather than a guess about it.
 *
 * Phase 4 of the multi-currency plan is where a document may arrive in another currency: `0108`
 * narrows to `currency_unrecognised` and `apply_reviewed_document` writes what the interpretation
 * derived. This constant is the single reference those screens read, so that phase replaces one
 * definition instead of hunting call sites.
 */
export const INTAKE_CURRENCY = 'ILS';

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

export interface CreditResolution {
  resolved: boolean;
  reason: 'supplier_ambiguous' | 'supplier_unresolved' | 'invoice_reference_unresolved'
    | 'credit_amount_unresolved' | 'not_found' | 'ambiguous' | null;
  supplier_id: string | null;
  invoice_id: string | null;
  reference_invoice_number: string | null;
  amount: number | null;
  candidate_count?: number;
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
  credit_resolution?: CreditResolution | null;
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

/**
 * What decided the supplier or the order, in Hebrew.
 *
 * The server sends a machine token — `tax_id`, `by_date_proximity` — because the token is what
 * anchors, suites and other callers reason about. Rendering it straight onto a Hebrew screen
 * produced lines like "זוהתה · by_number", which tells a bookkeeper nothing and looks like a bug.
 *
 * The labels say what the EVIDENCE was, not what the tier is called, because "the order number is
 * printed on the document" is a claim a person can check against the paper in their hand while
 * "by_number" is not. Two of them end in a caution: the date window and the single open order are
 * both inferences about which delivery this is, and 0120 and 0090 respectively record that they are
 * safe only because a person confirms them.
 */
export const RESOLUTION_LABELS: Record<string, string> = {
  // Supplier (0106), strongest evidence first.
  tax_id: 'ח.פ / עוסק מורשה תואם',
  document_supplier: 'הספק מזוהה במסמך עצמו',
  supplier_sku: 'מק"ט ספק מודפס',
  barcode: 'ברקוד מודפס',
  exact_name: 'שם ספק תואם במדויק',
  model_suggestion: 'הצעת המערכת — לאישור אדם',
  // Order (0107 + 0120), strongest evidence first.
  by_number: 'מספר ההזמנה מודפס על המסמך',
  by_items: 'ההזמנה מכילה את כל המוצרים שבמסמך',
  by_date_proximity: 'תאריך המסמך קרוב לאספקה הצפויה — כדאי לוודא',
  single_open_order: 'ההזמנה הפתוחה היחידה של הספק — כדאי לוודא',
  open_order: 'הזמנה פתוחה — לבחירת אדם',
};

/**
 * A tier token as a sentence. Handles the comma-joined form 0106 produces when a supplier's SKU and
 * barcode both point at it, and falls back to the token itself for anything this build has not met —
 * an unfamiliar token read aloud to support beats "לא ידוע".
 */
export function resolutionLabel(matchedBy: string | null | undefined): string | null {
  if (!matchedBy) return null;
  return matchedBy
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => RESOLUTION_LABELS[token] || token)
    .join(' · ') || null;
}

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

/** One finding, plus every line that raised the same complaint. */
export interface FindingGroup {
  finding: AssessmentFinding;
  /** 1-based line numbers, in the order the server reported them. Empty for a document-level finding. */
  lines: number[];
}

/**
 * The same complaint about 18 lines is one thing to fix, not 18 things to read.
 *
 * A production document raised "לא ניתן לזהות איזה מוצר זה" on 18 of its 23 lines, and the panel
 * printed the sentence 18 times — a screen the reviewer scrolls instead of reads, and one that
 * hides the two OTHER problems among the repeats. Grouping keeps every line number; it only stops
 * repeating the sentence that is identical for all of them. Order is first-appearance, so the
 * severity sort of `blockingFindings` survives.
 */
export function groupFindings(findings: AssessmentFinding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const key = `${finding.code}|${findingLabel(finding)}`;
    const existing = groups.get(key);
    const group = existing ?? { finding, lines: [] };
    if (!existing) groups.set(key, group);
    if (finding.line_index != null) group.lines.push(finding.line_index + 1);
  }
  return [...groups.values()];
}

/** `[1,2,3,5,7,8]` reads as `1–3, 5, 7–8` — the same fact, one line instead of six. */
export function formatLineRanges(lines: number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    parts.push(end > start ? `${sorted[start]}–${sorted[end]}` : String(sorted[start]));
    start = end + 1;
  }
  return parts.join(', ');
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
    case 'credit_note':
      return [
        { happens: true, text: 'יירשם זיכוי ספק במצב "התקבל" ויקושר לחשבונית המקור' },
        { happens: true, text: 'מסמך הזיכוי יישמר כראיה עם הפירוש שאושר' },
        { happens: false, text: 'הזיכוי לא יקוזז מיתרה בעצם האישור' },
        { happens: false, text: 'לא יבוצע תשלום ולא ישתנה סכום חשבונית המקור' },
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
  if (read.document_type === 'credit_note' && !read.credit_resolution?.resolved) return false;
  return true;
}

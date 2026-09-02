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

import type { TKey } from '../../lib/i18n/t.ts';

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
  /** ISO-4217 code resolved by the server from the interpretation evidence. */
  currency: string | null;
  document_number: string | null;
  document_date: string | null;
  supplier_id: string | null;
  order_id: string | null;
  sources: { document: boolean; ordered: boolean; received: boolean; baseline: boolean };
  /**
   * The ladder the server judged this document by.
   *
   * Every figure here is the SERVER'S arithmetic, rounded by the currency's own minor units — the
   * same rounding that decided whether to block. A screen that recomputed `header_net + header_vat`
   * would be a second source of truth for money that rounds by its own rules.
   *
   * `unexplained_gap` is `null`, never `0`, when a rung was not extracted: "these agree" and "one
   * of them is missing" must not reach a reader as the same number. `missing_rungs` names which.
   *
   * The two tolerances were returned by `0227` and were missing from this type until `0260` — the
   * server was already answering a question nothing here could ask.
   */
  totals: {
    lines_net: number | null;
    lines_discount: number | null;
    header_net: number | null;
    header_vat: number | null;
    header_total: number | null;
    /** What the header IMPLIES: net + VAT, as the server computed it. */
    computed_total: number | null;
    /** What it CLAIMS minus what it implies. Keeps its sign; null where a rung is missing. */
    unexplained_gap: number | null;
    lines_vs_header_gap: number | null;
    overcharge_total: number | null;
    line_tolerance: number | null;
    document_tolerance: number | null;
    currency: string | null;
    /** Named absences, so a row can say "not extracted" rather than showing a bare dash. */
    missing_rungs: readonly ('lines_net' | 'header_net' | 'header_vat' | 'header_total')[];
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
export const FINDING_LABEL_KEYS: Record<string, TKey> = {
  duplicate_document: 'assessment.findingDuplicateDocument',
  supplier_mismatch: 'assessment.findingSupplierMismatch',
  currency_unrecognised: 'assessment.findingCurrencyUnrecognised',
  currency_assumed_from_supplier: 'assessment.findingCurrencyAssumedFromSupplier',
  document_order_currency_mismatch: 'assessment.findingDocumentOrderCurrencyMismatch',
  price_baseline_currency_mismatch: 'assessment.findingPriceBaselineCurrencyMismatch',
  product_unidentified: 'assessment.findingProductUnidentified',
  product_repeated_on_document: 'assessment.findingProductRepeatedOnDocument',
  product_charged_not_ordered: 'assessment.findingProductChargedNotOrdered',
  ordered_not_on_document: 'assessment.findingOrderedNotOnDocument',
  quantity_unreadable: 'assessment.findingQuantityUnreadable',
  quantity_above_ordered: 'assessment.findingQuantityAboveOrdered',
  quantity_differs_from_ordered: 'assessment.findingQuantityDiffersFromOrdered',
  quantity_above_received: 'assessment.findingQuantityAboveReceived',
  quantity_above_remaining_ordered: 'assessment.findingQuantityAboveRemainingOrdered',
  prior_invoiced_unit_unresolved: 'assessment.findingPriorInvoicedUnitUnresolved',
  receipt_recorded_exception: 'assessment.findingReceiptRecordedException',
  unit_or_packaging_mismatch: 'assessment.findingUnitOrPackagingMismatch',
  legacy_order_unit_snapshot_missing: 'assessment.findingLegacyOrderUnitSnapshotMissing',
  price_above_baseline: 'assessment.findingPriceAboveBaseline',
  price_below_baseline: 'assessment.findingPriceBelowBaseline',
  price_baseline_unknown: 'assessment.findingPriceBaselineUnknown',
  vat_rate_mismatch: 'assessment.findingVatRateMismatch',
  line_arithmetic_discrepancy: 'assessment.findingLineArithmeticDiscrepancy',
  header_total_differs_from_lines: 'assessment.findingHeaderTotalDiffersFromLines',
  header_arithmetic_discrepancy: 'assessment.findingHeaderArithmeticDiscrepancy',
  credit_required: 'assessment.findingCreditRequired',
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
export const RESOLUTION_LABEL_KEYS: Record<string, TKey> = {
  // Supplier (0106), strongest evidence first.
  tax_id: 'assessment.resolutionTaxId',
  document_supplier: 'assessment.resolutionDocumentSupplier',
  supplier_sku: 'assessment.resolutionSupplierSku',
  barcode: 'assessment.resolutionBarcode',
  exact_name: 'assessment.resolutionExactName',
  model_suggestion: 'assessment.resolutionModelSuggestion',
  // Order (0107 + 0120), strongest evidence first.
  by_number: 'assessment.resolutionByNumber',
  by_items: 'assessment.resolutionByItems',
  by_date_proximity: 'assessment.resolutionByDateProximity',
  single_open_order: 'assessment.resolutionSingleOpenOrder',
  open_order: 'assessment.resolutionOpenOrder',
};

/**
 * A tier token as a sentence. Handles the comma-joined form 0106 produces when a supplier's SKU and
 * barcode both point at it, and falls back to the token itself for anything this build has not met —
 * an unfamiliar token read aloud to support beats "לא ידוע".
 */
export function resolutionText(
  matchedBy: string | null | undefined,
  t: (key: TKey) => string,
): string | null {
  if (!matchedBy) return null;
  return matchedBy
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const key = RESOLUTION_LABEL_KEYS[token];
      return key ? t(key) : token;
    })
    .join(' · ') || null;
}

export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0, error: 1, warning: 2, info: 3,
};

/**
 * `finding.message` comes first and is NEVER translated: it is the server's own sentence about
 * this document, written by `0108` with the document's own numbers in it, and it is the same
 * class as OCR text — it arrived, it is not interface. Only the fallback label belongs to this
 * file, and only that is a key. A code with no entry still falls back to the CODE, because a
 * bookkeeper on the phone to support can read a code aloud.
 */
export function findingText(finding: AssessmentFinding, t: (key: TKey) => string): string {
  if (finding.message) return finding.message;
  const key = FINDING_LABEL_KEYS[finding.code];
  return key ? t(key) : finding.code;
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
    // The grouping key is IDENTITY, not display. It used to be the rendered label, which meant
    // two findings grouped or split depending on what language the reader was in — and the label
    // is derived from exactly these two fields anyway.
    const key = `${finding.code}|${finding.message ?? ''}`;
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
  /**
   * A key, not a sentence, and renamed from `text` so the screen that draws these could not keep
   * compiling while printing `assessment.effectInvoiceCreated` under an approval button. Each one
   * is a statement about `public.apply_reviewed_document` (0110); what changes here is the
   * language it is read in, never which branch it describes.
   */
  textKey: TKey;
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
        { happens: true, textKey: 'assessment.effectInvoiceCreated' },
        { happens: true, textKey: 'assessment.effectInvoiceLinesKept' },
        orderResolved
          ? { happens: true, textKey: 'assessment.effectInvoiceLinkedToOrder' }
          : { happens: false, textKey: 'assessment.effectInvoiceNoOrder' },
        { happens: false, textKey: 'assessment.effectInvoiceNoReceiptChange' },
        { happens: false, textKey: 'assessment.effectInvoiceNoPayment' },
      ];
    case 'delivery_note':
      return [
        { happens: true, textKey: 'assessment.effectDeliveryDraftCreated' },
        { happens: true, textKey: 'assessment.effectDeliveryClearLines' },
        { happens: false, textKey: 'assessment.effectDeliveryNoStockChange' },
        { happens: false, textKey: 'assessment.effectDeliveryNoInvoice' },
        { happens: false, textKey: 'assessment.effectDeliveryNeedsConfirmation' },
      ];
    case 'tax_receipt':
      return [
        { happens: true, textKey: 'assessment.effectReceiptLinked' },
        { happens: false, textKey: 'assessment.effectReceiptNoInvoice' },
        { happens: false, textKey: 'assessment.effectReceiptNoLink' },
      ];
    case 'credit_note':
      return [
        { happens: true, textKey: 'assessment.effectCreditRecorded' },
        { happens: true, textKey: 'assessment.effectCreditEvidenceKept' },
        { happens: false, textKey: 'assessment.effectCreditNoOffset' },
        { happens: false, textKey: 'assessment.effectCreditNoPayment' },
      ];
    default:
      return [{ happens: false, textKey: 'assessment.effectNoApprovalRoute' }];
  }
}

/**
 * The two sentences the screen must never merge.
 *
 * A person who photographed an invoice beside a delivery truck has achieved exactly one thing: the
 * file cannot be lost. Nothing about their business has changed. One word — "נשמר" — covering both
 * is how someone walks away believing an invoice was recorded when it is sitting in a queue.
 */
export function storageAndApprovalKeys(read: DocumentReviewRead): [TKey, TKey] {
  return [
    read.file_stored
      ? 'assessment.fileStored'
      : 'assessment.fileNotStored',
    read.data_approved
      ? 'assessment.dataApproved'
      : 'assessment.dataNotApproved',
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
  currency: string | null;
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
    currency: assessment?.currency ?? null,
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

/** One `supplier_products` row `import_supplier_prices` accepts. */
export interface PriceSeedRow {
  supplier_id: string;
  product_id: string;
  price: number;
  available: true;
}

/**
 * The prices an approval may write into the supplier's price list — and only those.
 *
 * SEEDING, NEVER OVERWRITING, and that distinction is the whole safety of the feature (owner,
 * 28.08.2026: "המחירים והמוצרים יתעדכנו בהעלאת חשבונית של הספק, כי לא תמיד יש מחירון של ספק").
 * `baseline_price` is what every price finding on the review screen compares the document against.
 * Letting an invoice rewrite an EXISTING baseline would make each invoice agree with itself and
 * quietly retire "מחיר מעל המחיר המוסכם" as a check — a control removed by a convenience. A line
 * with no baseline has no such check to lose: the server already reports it as
 * `price_baseline_unknown`, so filling it in only adds a comparison the business did not have.
 *
 * The normalized price wins where there is one, because that is the number the baseline is
 * compared against — writing the printed price instead would seed a baseline in a different unit
 * from the one the comparison uses, and every later invoice would look like a variance.
 *
 * One row per product. A product CREATED from a line already carries this price
 * (`QuickCreateProduct` writes it), so a repeat here is the same number twice rather than a
 * conflict; the map keeps the command's input clean either way.
 */
export function priceSeedRows(
  read: DocumentReviewRead | null,
  edits: Record<number, ReviewedLineEdit>,
  supplierId: string | null,
): PriceSeedRow[] {
  if (!supplierId) return [];
  const byProduct = new Map<string, PriceSeedRow>();
  for (const line of read?.assessment?.lines ?? []) {
    const productId = edits[line.line_index]?.product_id ?? line.product_id;
    const price = line.normalized_unit_price ?? line.unit_price;
    if (!productId || line.baseline_price != null || price == null || price <= 0) continue;
    if (!byProduct.has(productId)) {
      byProduct.set(productId, { supplier_id: supplierId, product_id: productId, price, available: true });
    }
  }
  return [...byProduct.values()];
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

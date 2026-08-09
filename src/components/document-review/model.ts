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

// The model names these keys itself, so this can never be exhaustive. Every entry here was
// observed coming back from a real Hebrew invoice; anything unlisted falls through to the raw key
// rather than being guessed at, because a wrong Hebrew label is worse than an English one.
const FIELD_KEY_LABELS: Record<string, string> = {
  invoice_number: 'מספר חשבונית',
  invoice_date: 'תאריך חשבונית',
  document_number: 'מספר מסמך',
  document_date: 'תאריך המסמך',
  print_date: 'תאריך הדפסה',
  due_date: 'תאריך לתשלום',
  supplier_name: 'שם הספק',
  supplier_vat_id: 'ח.פ / עוסק מורשה',
  supplier_phone: 'טלפון הספק',
  customer_name: 'שם הלקוח',
  customer_company_id: 'ח.פ הלקוח',
  currency: 'מטבע',
  subtotal: 'סכום לפני מע״מ',
  total: 'סכום כולל',
  total_amount: 'סכום כולל',
  vat_amount: 'מע״מ',
  vat_rate: 'שיעור מע״מ',
  discount: 'הנחה',
  allocation_number: 'מספר הקצאה',
  delivery_note_number: 'מספר תעודת משלוח',
  order_number: 'מספר הזמנה',
  payment_terms: 'תנאי תשלום',
  document_title: 'כותרת המסמך',
  document_copy_status: 'מקור או העתק',
};

// Kept separate from FIELD_KEY_LABELS rather than merged: `total` and `amount` mean the document
// total at document level and the line total inside a row. One shared map would have to pick one
// of the two and would be wrong wherever it guessed.
const LINE_ITEM_KEY_LABELS: Record<string, string> = {
  sku: 'מק״ט',
  product_code: 'מק״ט',
  item_code: 'מק״ט',
  catalog_number: 'מק״ט',
  barcode: 'ברקוד',
  product_name: 'שם מוצר',
  description: 'תיאור',
  name: 'תיאור',
  quantity: 'כמות',
  qty: 'כמות',
  unit: 'יחידה',
  unit_price: 'מחיר ליחידה',
  price: 'מחיר ליחידה',
  price_per_unit: 'מחיר ליחידה',
  line_total: 'סה״כ לשורה',
  total: 'סה״כ לשורה',
  total_price: 'סה״כ לשורה',
  line_amount: 'סה״כ לשורה',
  amount: 'סה״כ לשורה',
  discount: 'הנחה',
  discount_amount: 'סכום הנחה',
  vat_rate: 'שיעור מע״מ',
  notes: 'הערות',
};

/** Hebrew name for a proposed field, falling back to the key the model chose. */
export function fieldKeyLabel(key: string): string {
  return FIELD_KEY_LABELS[key.trim().toLowerCase()] ?? key;
}

/** Hebrew name for a key inside a proposed line item, falling back to the model's own key. */
export function lineItemKeyLabel(key: string): string {
  return LINE_ITEM_KEY_LABELS[key.trim().toLowerCase()] ?? key;
}

/**
 * The two cut points between "read clearly", "read partly" and "not certain".
 *
 * THESE ARE A PRODUCT JUDGEMENT, NOT A MEASUREMENT, and must not be described as calibrated.
 * There is no labelled corpus in this repository: nothing here was fitted against verified values,
 * so 0.9 and 0.7 are round numbers picked for how the three grades behave as language — the top
 * grade rare enough that it still means something, the bottom grade loud enough to be acted on.
 * The provider's own number is self-reported and is not a probability of being right.
 *
 * Whoever first measures provider confidence against human-verified values should move these and
 * replace this paragraph with what they measured. Until then, treating them as evidence would be
 * the same mistake as printing the percentage: a number that looks earned and is not.
 */
const CONFIDENCE_CLEAR = 0.9;
const CONFIDENCE_PARTIAL = 0.7;

/**
 * How clearly the document was read, as words rather than a percentage.
 *
 * The percentage was removed from the everyday screens on the owner's instruction — the reviewers
 * are a bookkeeper and a kitchen manager, and "רמת ביטחון 87%" asks them to do arithmetic on a
 * number nobody calibrated instead of answering the only question they have: do I look at this one
 * harder? It is **not deleted**: `confidencePercent` prints it verbatim inside the "פרטים טכניים"
 * disclosure of the review workspace, one click away, for whoever is diagnosing an extraction.
 *
 * The wording is about *reading*, never about *correctness*: `זוהה בבירור` claims the characters
 * came off the page cleanly, not that the value is the right one. Only the human approval step
 * says that, and a provider's self-reported confidence never can.
 */
export function confidenceLabel(value: number | null | undefined): string {
  if (!usableConfidence(value)) return 'רמת הזיהוי אינה ידועה';
  if (value >= CONFIDENCE_CLEAR) return 'זוהה בבירור';
  if (value >= CONFIDENCE_PARTIAL) return 'זוהה חלקית';
  return 'לא ודאי';
}

/**
 * Whether a stored confidence can be graded at all.
 *
 * Three ways it cannot. Absent is absent. Non-finite is absence too, not a low score: NaN falling
 * through the comparisons would silently read as "לא ודאי", a claim about the document that
 * nothing measured. And above 1 is outside the contract's range — a broken payload, whose one
 * unacceptable outcome is producing the *strongest* claim on the screen, so it reads as unknown.
 *
 * Deliberately not bounded below: a negative is equally broken, but it falls into "לא ודאי", which
 * errs toward more scrutiny rather than less. A corrupt number that under-claims needs no guard.
 * `confidencePercent` prints all of these verbatim — the disclosure exists to show the corruption,
 * not to launder it.
 */
function usableConfidence(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value <= 1;
}

/**
 * The raw number, for the technical disclosure only — never for an everyday screen.
 *
 * Absent prints — and never 0% (CLAUDE.md: an absent metric shows —, because zero is itself a
 * statement about the reading). A measured zero does print as 0%: something did measure it.
 *
 * Two decimals, trailing zeros stripped, rather than whole percent. Whole percent rounded 0.899 to
 * "90%" on the one surface built for diagnosis, beside a screen grading it "זוהה חלקית" against a
 * documented 0.9 threshold — a contradiction produced entirely by the display. `toFixed` also
 * absorbs the binary-float noise that makes 0.87*100 come out as 87.00000000000001, the same
 * reason `DocumentSourceViewer`'s `pct` exists. Any fixed precision still rounds, so the
 * disclosure says so in words rather than claiming the number is untouched.
 *
 * Values outside the contract's 0–1 print as they are. The disclosure exists to show a broken
 * payload, not to launder it — only `confidenceLabel` refuses to grade one.
 */
export function confidencePercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Number((value * 100).toFixed(2))}%`;
}

/**
 * What to do when the supplier match is anything short of clear — or null when it is clear.
 *
 * The supplier is graded on the same scale as every other value but does not carry the same
 * consequence, so it does not get the same silence. A misread date is corrected on the screen that
 * uses it; a misread supplier is carried by `suggested_supplier_id` straight into the invoice
 * draft's payee field, and from there into a payment request. That is the shape of the canonical
 * invoice-fraud error, so a grade below "clearly" states the obligation instead of leaving the
 * reviewer to infer it. Unknown is not permission to skip the check — it is the reason to run it.
 */
export function supplierMatchCaution(value: number | null | undefined): string | null {
  // Same usability test as the grade, so a broken payload cannot buy silence here either.
  if (usableConfidence(value) && value >= CONFIDENCE_CLEAR) return null;
  return usableConfidence(value)
    ? 'הספק לא זוהה בבירור. יש לאמת את שם הספק מול המסמך לפני שמאשרים ממנו חשבונית או תשלום.'
    : 'לא ידוע באיזו ודאות זוהה הספק. יש לאמת את שם הספק מול המסמך לפני שמאשרים ממנו חשבונית או תשלום.';
}

/**
 * Where on the page a block sits, as prose — the accessible locator that reaches screen readers
 * through the aria-labels of both the overlay shortcuts and the keyboard list, for images and
 * (since wave 6, via react-pdf) for PDF pages alike.
 *
 * An axis that spans the whole page is dropped rather than printed. Both paths that actually run
 * in production are full-width by construction: `parsers.py` gives digital PDF text FULL_BBOX
 * [0,0,1,1], and the OpenAI OCR adapter synthesises one full-width band per line. Printing
 * "0%–100% לרוחב" on every row is noise that hides the one number that varies, and it reaches
 * screen readers through the aria-labels too.
 */
export function bboxDescription(box: ExtractionContract['blocks'][number]['bbox'] | null): string {
  if (!box) return 'מיקום התא אינו זמין';
  const [xMin, yMin, xMax, yMax] = box.map((value) => Math.round(value * 100));
  const axes = [
    xMin === 0 && xMax === 100 ? null : `${xMin}%–${xMax}% לרוחב`,
    yMin === 0 && yMax === 100 ? null : `${yMin}%–${yMax}% לגובה`,
  ].filter((axis): axis is string => axis !== null);
  return axes.length ? `מיקום בעמוד: ${axes.join(', ')}` : 'פרוס על פני כל העמוד';
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

const INVOICE_NUMBER_KEYS = ['invoice_number', 'document_number', 'מספר חשבונית', 'מספר מסמך'];
const INVOICE_DATE_KEYS = ['invoice_date', 'document_date', 'date', 'תאריך חשבונית', 'תאריך המסמך', 'תאריך'];
const BEFORE_VAT_KEYS = ['subtotal', 'amount_before_vat', 'net_amount', 'סכום לפני מעמ', 'סה"כ לפני מע"מ'];
const VAT_KEYS = ['vat_amount', 'vat', 'tax_amount', 'מעמ', 'מע"מ'];
const TOTAL_KEYS = ['total', 'total_amount', 'grand_total', 'amount_due', 'סכום כולל', 'סה"כ לתשלום'];

/**
 * dd/mm/yyyy (and dd.mm.yyyy / dd-mm-yyyy) or an already-ISO date, to yyyy-mm-dd for <input
 * type="date">. Day-first is the Israeli convention these documents are printed in.
 *
 * Anything else returns '' and the field is left for the person to fill. A date that is merely
 * *probably* right is worse than an empty one here: it lands on a financial record, and an empty
 * required field is visible while a plausible wrong date is not.
 */
export function normalizeInvoiceDate(raw: string | number | boolean | null): string {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return text;
  const dayFirst = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text);
  if (!dayFirst) return '';
  const [, day, month, year] = dayFirst;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return '';
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export interface InvoiceDraft {
  invoice_number: string;
  invoice_date: string;
  before_vat: string;
  vat: string;
  total: string;
}

/**
 * Prefill values for the ordinary invoice form, read out of an interpretation.
 *
 * This is a draft and nothing more: the form still runs its duplicate checks, still demands a
 * reason, and still calls create_invoice. A field the model did not offer -- or offered in a shape
 * that will not parse -- comes back empty rather than guessed.
 */
export function invoiceDraftFromInterpretation(payload: InterpretationContract): InvoiceDraft {
  const pick = (candidates: readonly string[]): string | number | boolean | null => {
    for (const field of payload.fields) {
      if (candidates.includes(field.key.trim().toLowerCase())) return field.value;
    }
    return null;
  };
  const money = (candidates: readonly string[]): string => {
    const parsed = numericValue(pick(candidates) as string | number | null);
    return parsed === null ? '' : String(parsed);
  };
  const number = pick(INVOICE_NUMBER_KEYS);
  return {
    invoice_number: typeof number === 'string' || typeof number === 'number' ? String(number).trim() : '',
    invoice_date: normalizeInvoiceDate(pick(INVOICE_DATE_KEYS)),
    before_vat: money(BEFORE_VAT_KEYS),
    vat: money(VAT_KEYS),
    total: money(TOTAL_KEYS),
  };
}

const SKU_KEYS = ['sku', 'product_code', 'item_code', 'catalog_number', 'מק״ט', 'מקט', 'מק"ט'];
const BARCODE_KEYS = ['barcode', 'ברקוד'];
const DESCRIPTION_KEYS = ['description', 'name', 'product', 'תיאור', 'שם המוצר', 'פריט'];
const QUANTITY_LINE_KEYS = ['quantity', 'qty', 'כמות', 'כמות שסופקה'];
// A credit note carries two numbers: its own, and the invoice it credits. Only the second is
// useful for finding the invoice, so the explicit reference keys are tried first and the generic
// invoice_number is the fallback -- on a credit note that key usually is the reference.
const CREDITED_INVOICE_KEYS = [
  'reference_invoice_number', 'original_invoice_number', 'credited_invoice_number',
  'related_invoice_number', 'חשבונית מקור', 'מספר חשבונית מקורית',
  'invoice_number', 'מספר חשבונית',
];

function lineValue(
  values: InterpretationContract['line_items'][number]['values'],
  candidates: readonly string[],
): string | null {
  for (const [key, value] of Object.entries(values)) {
    if (!candidates.includes(key.trim().toLowerCase())) continue;
    if (value === null || typeof value === 'boolean') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export interface DeliveryNoteLine {
  sourceRow: number | null;
  sku: string | null;
  barcode: string | null;
  description: string | null;
  quantity: number | null;
}

/**
 * The supplied lines of a delivery note, as read. Nothing is matched or resolved here -- that
 * needs the order, which only the person receiving the goods knows.
 */
export function deliveryNoteLines(payload: InterpretationContract): DeliveryNoteLine[] {
  return payload.line_items.map((item) => ({
    sourceRow: item.source_row,
    sku: lineValue(item.values, SKU_KEYS),
    barcode: lineValue(item.values, BARCODE_KEYS),
    description: lineValue(item.values, DESCRIPTION_KEYS),
    quantity: numericValue(lineValue(item.values, QUANTITY_LINE_KEYS)),
  }));
}

/**
 * Match a delivery-note line to a product already in the catalogue.
 *
 * Ordered by how strongly each key identifies a product: the supplier's own catalogue number is
 * what is actually printed on their delivery note, then our sku, then barcode. Name is last and
 * must be exact after normalising whitespace -- a fuzzy name match on a goods receipt would credit
 * the wrong product's quantity, and a line left unmatched is visible while a wrong match is not.
 */
export function matchDeliveryLineProduct(
  line: DeliveryNoteLine,
  catalogue: {
    productId: string;
    supplierSku: string | null;
    sku: string | null;
    barcode: string | null;
    name: string;
  }[],
): string | null {
  const norm = (value: string | null) => value?.trim().toLowerCase().replace(/\s+/g, ' ') || null;
  const sku = norm(line.sku);
  const barcode = norm(line.barcode);
  const description = norm(line.description);

  const by = (predicate: (entry: typeof catalogue[number]) => boolean): string | null => {
    const hits = catalogue.filter(predicate);
    // Ambiguity is not a match: two products answering to the same code means the catalogue cannot
    // say which one arrived, and picking either would be a guess about goods and money.
    return hits.length === 1 ? hits[0].productId : null;
  };

  return (sku && by((entry) => norm(entry.supplierSku) === sku))
    ?? (sku && by((entry) => norm(entry.sku) === sku))
    ?? (barcode && by((entry) => norm(entry.barcode) === barcode))
    ?? (description && by((entry) => norm(entry.name) === description))
    ?? null;
}

export interface CreditDraft {
  amount: string;
  creditedInvoiceNumber: string;
  notes: string;
}

/**
 * Prefill for the existing credit-request modal. The reason is deliberately absent: `credit_reason`
 * is an enum about why the business is owed money (missing, damaged, returned, wrong price...) and
 * a credit note states an amount, not a cause. Guessing it would put an invented business fact on
 * a financial record, so it stays the reviewer's choice on the same dropdown as always.
 */
export function creditDraftFromInterpretation(payload: InterpretationContract): CreditDraft {
  const field = (candidates: readonly string[]): string | number | boolean | null => {
    for (const key of candidates) {
      const hit = payload.fields.find((item) => item.key.trim().toLowerCase() === key);
      if (hit && hit.value !== null && hit.value !== '') return hit.value;
    }
    return null;
  };
  const amount = numericValue(field(TOTAL_KEYS) as string | number | null);
  const credited = field(CREDITED_INVOICE_KEYS);
  const lines = payload.line_items
    .map((item) => {
      const description = lineValue(item.values, DESCRIPTION_KEYS);
      const quantity = lineValue(item.values, QUANTITY_LINE_KEYS);
      return description && quantity ? `${description} × ${quantity}` : description;
    })
    .filter((entry): entry is string => !!entry);
  return {
    // A credit note prints its total as a positive number; the sign lives in the document type.
    amount: amount === null ? '' : String(Math.abs(amount)),
    creditedInvoiceNumber: typeof credited === 'string' || typeof credited === 'number'
      ? String(credited).trim()
      : '',
    notes: lines.length ? `לפי המסמך: ${lines.join(', ')}` : '',
  };
}

const PAYMENT_REFERENCE_KEYS = [
  'reference', 'reference_number', 'transaction_reference', 'confirmation_number',
  'transfer_reference', 'אסמכתא', 'מספר אסמכתא', 'מספר העברה',
];
const PAYMENT_DATE_KEYS = [
  'payment_date', 'paid_date', 'value_date', 'transfer_date', 'date',
  'תאריך תשלום', 'תאריך ההעברה', 'תאריך ערך', 'תאריך',
];

export interface PaymentConfirmationFacts {
  amount: number | null;
  paidDate: string;
  reference: string;
}

/**
 * What a bank confirmation actually states: an amount, a date and a reference.
 *
 * Notably NOT which invoices it settles. In this system that question is already answered before
 * the money moves -- `execute_payment_request` takes its allocations from the approved payment
 * request, not from any document -- so a confirmation is evidence that an execution happened, and
 * never the instruction to perform one.
 */
export function paymentConfirmationFacts(payload: InterpretationContract): PaymentConfirmationFacts {
  const field = (candidates: readonly string[]): string | number | boolean | null => {
    for (const key of candidates) {
      const hit = payload.fields.find((item) => item.key.trim().toLowerCase() === key);
      if (hit && hit.value !== null && hit.value !== '') return hit.value;
    }
    return null;
  };
  const amount = numericValue(field(TOTAL_KEYS) as string | number | null);
  const reference = field(PAYMENT_REFERENCE_KEYS);
  return {
    amount: amount === null ? null : Math.abs(amount),
    paidDate: normalizeInvoiceDate(field(PAYMENT_DATE_KEYS) as string | number | boolean | null),
    reference: typeof reference === 'string' || typeof reference === 'number'
      ? String(reference).trim()
      : '',
  };
}

/** Money is equal when it is equal to the agora; a shekel of drift is a different payment. */
export function sameAmount(left: number | null, right: number | null): boolean {
  return left !== null && right !== null && Math.abs(left - right) <= 0.01;
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
/**
 * Why the automation stopped, in the language of the business rather than of the ladder.
 *
 * Every key is an arm of `apply_document_interpretation` (0077); the code reaches the client on
 * `document_filings.reason_code` (0079). Before that column existed the answer lived only in a
 * plpgsql local and an Edge Function console line, and finding out why one document was waiting
 * cost a query against production — which is the whole reason this map is here.
 *
 * Each sentence says what happened AND what the person can do, because "not_an_invoice" alone
 * reads like a fault when it is the system working correctly.
 */
export const FILING_REASON_LABELS: Record<string, string> = {
  autonomy_disabled:
    'האוטומציה כבויה, ולכן כל מסמך ממתין להכרעת אדם. אפשר להדליק אותה בהגדרות.',
  organization_inactive:
    'הארגון אינו פעיל, ולכן המערכת אינה כותבת רשומות. יש לפנות לתמיכה.',
  document_type_other:
    'לא זוהה סוג מסמך מוכר, ולכן המסמך הועבר לארכיון. אפשר לחלץ אותו משם עם סיבה.',
  confidence_unknown:
    'המערכת לא החזירה רמת זיהוי, ולכן לא פעלה לבד. יש לבדוק את ההצעה מול המסמך.',
  below_confidence_threshold:
    'רמת הזיהוי נמוכה מהסף שהוגדר לארגון, ולכן ההכרעה נשארה אצלך.',
  // The one the owner actually hit, and the one most likely to look like a bug.
  not_an_invoice:
    'לסוג המסמך הזה אין עדיין פקודת כתיבה אוטומטית בטוחה ליעד העסקי, ולכן הוא ממתין להשלמה — גם בזיהוי מלא.',
  not_a_price_list:
    'המסמך אינו מחירון, ולכן לא בוצע עדכון מחירים אוטומטי.',
  supplier_unidentified:
    'הספק לא הותאם לספק קיים במערכת, ואין למה לשייך את הסכום. אפשר לבחור ספק או ליצור אחד חדש.',
  invoice_identity_missing:
    'חסרים מספר חשבונית או תאריך, ולכן לא ניתן ליצור רשומה כספית.',
  invoice_number_unrepresentable:
    'מספר החשבונית מכיל תווים שהמערכת אינה יכולה להשוות מולם, ולכן היא לא יצרה רשומה.',
  invoice_number_unreasonable:
    'מספר החשבונית ארוך מדי מכדי להיות מספר אמיתי — ככל הנראה שגיאת קריאה.',
  total_missing:
    'לא נקרא סכום מהמסמך, וחשבונית בלי סכום אינה חשבונית.',
  amounts_unreconciled:
    'הסכום לפני מע״מ, המע״מ והסה״כ אינם מסתכמים זה לזה. יש להשוות מול המסמך.',
  payment_allocation_conflict:
    'קיימת התנגשות בהקצאת תשלום, ולכן הפעולה נעצרה לבדיקה.',
  duplicate_invoice_number:
    'כבר קיימת חשבונית עם אותו מספר לאותו ספק. המערכת עצרה כדי שלא תיווצר כפילות.',
  line_product_unmatched:
    'לא נמצא מק״ט או ברקוד שמאפשר לזהות או ליצור את המוצר בבטחה, ולכן השורה ממתינה.',
  line_product_ambiguous:
    'המק״ט או הברקוד מתאימים ליותר ממוצר אחד. המערכת לא ניחשה והשורה ממתינה.',
  line_price_unreadable:
    'לא נקרא מחיר יחידה חיובי ותקין, ולכן השורה ממתינה לבדיקה.',
  already_decided:
    'למסמך הזה כבר יש הכרעה, ולכן האוטומציה לא פעלה שוב.',
};

/**
 * The reason the newest machine filing gives, or null when there is nothing to say.
 *
 * Null covers two DIFFERENT facts and deliberately says neither: a filing with no code that
 * carries an invoice was applied — nothing stopped it — and a filing with no code that predates
 * 0079 has a reason nobody recorded. Guessing between them on screen would be a claim about the
 * past that the data does not support.
 */
export function filingReason(snapshot: ReviewSnapshot): string | null {
  // `?? []` is not defensive noise — it was earned. The first version read `snapshot.filings`
  // directly and took the whole review screen down with "Cannot read properties of undefined"
  // wherever a snapshot predated the field. An explanatory sentence going missing is a small
  // loss; a bookkeeper meeting a blank page instead of an invoice under review is not.
  const machineFilings = (snapshot.filings ?? [])
    .filter((filing) => filing.decided_by === 'system' && !filing.reverted_at)
    .sort((a, b) => b.decided_at.localeCompare(a.decided_at));
  const code = machineFilings[0]?.reason_code;
  if (!code) return null;
  return FILING_REASON_LABELS[code]
    // An arm added to the ladder without a sentence here must not print a bare enum at a
    // bookkeeper. It says the honest minimum instead.
    ?? 'המערכת עצרה ולא יצרה רשומה. ההכרעה אצלך.';
}

export type DocumentRoutingSummary = {
  completed: boolean;
  headline: string;
  destination: string;
  lineSummary: string;
  path: string | null;
  actionLabel: string | null;
};

/** Describes only writes the authoritative document row proves happened. */
export function documentRoutingSummary(snapshot: ReviewSnapshot): DocumentRoutingSummary {
  const doc = snapshot.document;
  const payload = snapshot.interpretation?.payload;
  const lineCount = payload?.line_items.length ?? 0;
  const lineSummary = lineCount === 0
    ? 'לא זוהו במסמך שורות פריט.'
    : `${lineCount === 1 ? 'שורת פריט אחת' : `${lineCount} שורות פריט`} נשמר${lineCount === 1 ? 'ה' : 'ו'} בפירוש המסמך${doc?.entity_type === 'goods_receipt' ? ' ובקבלת הסחורה' : ''}.`;

  if (!doc || !payload) {
    return { completed: false, headline: 'עדיין אין תוצאת שיוך', destination: 'ממתין לפירוש המסמך', lineSummary, path: null, actionLabel: null };
  }

  if (doc.entity_type === 'invoice' && doc.entity_id) {
    return { completed: true, headline: 'נוצרה חשבונית והיא שויכה למסמך', destination: 'חשבוניות', lineSummary, path: `/invoices/${doc.entity_id}`, actionLabel: 'פתיחת החשבונית' };
  }
  if (doc.entity_type === 'goods_receipt' && doc.entity_id) {
    return { completed: true, headline: 'המסמך שויך לקבלת סחורה', destination: 'קבלות סחורה', lineSummary, path: `/receipts/${doc.entity_id}`, actionLabel: 'פתיחת קבלת הסחורה' };
  }
  if (doc.entity_type === 'payment' && doc.entity_id) {
    return { completed: true, headline: 'המסמך שויך לתשלום קיים', destination: 'תשלומים', lineSummary, path: '/payments', actionLabel: 'פתיחת התשלומים' };
  }
  if (doc.entity_type === 'supplier' && doc.entity_id) {
    return { completed: true, headline: 'המסמך שויך לכרטיס הספק', destination: 'ספקים', lineSummary, path: `/suppliers/${doc.entity_id}`, actionLabel: 'פתיחת הספק' };
  }
  if (doc.entity_type === 'archive') {
    return { completed: true, headline: 'המסמך סווג והועבר לארכיון', destination: 'ארכיון המסמכים', lineSummary, path: '/documents/archive', actionLabel: 'פתיחת הארכיון' };
  }

  const destination = ({
    invoice: 'חשבוניות',
    delivery_note: 'קבלות סחורה',
    credit_note: 'זיכויים',
    price_list: 'מוצרים ומחירים',
    quote: 'מסמכי ספק',
    payment_confirmation: 'תשלומים',
    other: 'ארכיון המסמכים',
  } as const)[payload.document_type];
  return {
    completed: false,
    headline: 'המסמך נקרא, אך עדיין לא נכתבה רשומה ביעד',
    destination,
    lineSummary,
    path: null,
    actionLabel: null,
  };
}

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

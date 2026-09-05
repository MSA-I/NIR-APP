import type { TKey } from '../../lib/i18n/t';
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

export const DOCUMENT_TYPE_KEYS: Record<InterpretationContract['document_type'], TKey> = {
  invoice: 'documents.docTypeInvoice',
  delivery_note: 'documents.docTypeDeliveryNote',
  credit_note: 'documents.docTypeCreditNote',
  price_list: 'documents.docTypePriceList',
  quote: 'documents.docTypeQuote',
  payment_confirmation: 'documents.docTypePaymentConfirmation',
  tax_receipt: 'documents.docTypeTaxReceipt',
  other: 'documents.docTypeOther',
};

export const MARK_KIND_KEYS: Record<ExtractionContract['marks'][number]['kind'], TKey> = {
  circle: 'documents.markCircle',
  check: 'documents.markCheck',
  cross: 'documents.markCross',
  underline: 'documents.markUnderline',
  star: 'documents.markStar',
  custom: 'documents.markCustom',
  unknown: 'documents.markUnknown',
};

// `claude` is a legacy stored token, kept because it is baked into two CHECK constraints in
// migration 0046. Per the project constitution the display label changes here, not the enum.
export const ANNOTATION_SOURCE_KEYS: Record<DocumentAnnotation['source'], TKey> = {
  claude: 'documents.annotationSourceAuto',
  rule: 'documents.annotationSourceRule',
  user: 'documents.annotationSourceUser',
};

// The model names these keys itself, so this can never be exhaustive. Every entry here was
// observed coming back from a real Hebrew invoice; anything unlisted falls through to the raw key
// rather than being guessed at, because a wrong Hebrew label is worse than an English one.
const FIELD_KEY_KEYS: Record<string, TKey> = {
  invoice_number: 'documents.fieldInvoiceNumber',
  invoice_date: 'documents.fieldInvoiceDate',
  document_number: 'documents.fieldDocumentNumber',
  document_date: 'documents.fieldDocumentDate',
  print_date: 'documents.fieldPrintDate',
  due_date: 'documents.fieldDueDate',
  supplier_name: 'documents.fieldSupplierName',
  supplier_vat_id: 'documents.fieldSupplierVatId',
  supplier_phone: 'documents.fieldSupplierPhone',
  customer_name: 'documents.fieldCustomerName',
  customer_company_id: 'documents.fieldCustomerCompanyId',
  currency: 'documents.fieldCurrency',
  subtotal: 'documents.fieldSubtotal',
  total: 'documents.fieldTotal',
  total_amount: 'documents.fieldTotal',
  vat_amount: 'documents.fieldVatAmount',
  vat_rate: 'documents.fieldVatRate',
  discount: 'documents.fieldDiscount',
  allocation_number: 'documents.fieldAllocationNumber',
  delivery_note_number: 'documents.fieldDeliveryNoteNumber',
  order_number: 'documents.fieldOrderNumber',
  payment_terms: 'documents.fieldPaymentTerms',
  document_title: 'documents.fieldDocumentTitle',
  document_copy_status: 'documents.fieldDocumentCopyStatus',
};

// Kept separate from FIELD_KEY_LABELS rather than merged: `total` and `amount` mean the document
// total at document level and the line total inside a row. One shared map would have to pick one
// of the two and would be wrong wherever it guessed.
const LINE_ITEM_KEY_KEYS: Record<string, TKey> = {
  sku: 'documents.lineSku',
  product_code: 'documents.lineSku',
  item_code: 'documents.lineSku',
  catalog_number: 'documents.lineSku',
  barcode: 'documents.lineBarcode',
  product_name: 'documents.lineProductName',
  description: 'documents.lineDescription',
  name: 'documents.lineDescription',
  quantity: 'documents.lineQuantity',
  qty: 'documents.lineQuantity',
  unit: 'documents.lineUnit',
  unit_price: 'documents.lineUnitPrice',
  price: 'documents.lineUnitPrice',
  price_per_unit: 'documents.lineUnitPrice',
  line_total: 'documents.lineTotal',
  total: 'documents.lineTotal',
  total_price: 'documents.lineTotal',
  line_amount: 'documents.lineTotal',
  amount: 'documents.lineTotal',
  discount: 'documents.lineDiscount',
  discount_amount: 'documents.lineDiscountAmount',
  discount_rate: 'documents.lineDiscountRate',
  vat_rate: 'documents.lineVatRate',
  line_vat_amount: 'documents.lineVatAmount',
  package_size: 'documents.linePackageSize',
  notes: 'documents.lineNotes',
};

/** Hebrew name for a proposed field, falling back to the key the model chose. */
export function fieldKeyLabel(key: string, t: (key: TKey) => string): string {
  const hit = FIELD_KEY_KEYS[key.trim().toLowerCase()];
  return hit ? t(hit) : key;
}

/** Hebrew name for a key inside a proposed line item, falling back to the model's own key. */
export function lineItemKeyLabel(key: string, t: (key: TKey) => string): string {
  const hit = LINE_ITEM_KEY_KEYS[key.trim().toLowerCase()];
  return hit ? t(hit) : key;
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
 * are operational product users, and "רמת ביטחון 87%" asks them to do arithmetic on a
 * number nobody calibrated instead of answering the only question they have: do I look at this one
 * harder? The number is not lost — `document_extractions` and `document_interpretations` still
 * store it and the operator console reads it. It simply has no tenant surface any more: the
 * technical block came off the review workspace entirely (owner report 28.08.2026).
 *
 * The wording is about *reading*, never about *correctness*: `זוהה בבירור` claims the characters
 * came off the page cleanly, not that the value is the right one. Only the human approval step
 * says that, and a provider's self-reported confidence never can.
 */
export function confidenceLabel(value: number | null | undefined, t: (key: TKey) => string): string {
  if (!usableConfidence(value)) return t('documents.confidenceUnknown');
  if (value >= CONFIDENCE_CLEAR) return t('documents.confidenceClear');
  if (value >= CONFIDENCE_PARTIAL) return t('documents.confidencePartial');
  return t('documents.confidenceUncertain');
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
 * A corrupt number reaches no screen at all now; it reaches this grader, which refuses to grade it.
 */
function usableConfidence(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value <= 1;
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
export function supplierMatchCaution(value: number | null | undefined, t: (key: TKey) => string): string | null {
  // Same usability test as the grade, so a broken payload cannot buy silence here either.
  if (usableConfidence(value) && value >= CONFIDENCE_CLEAR) return null;
  return usableConfidence(value)
    ? t('documents.supplierCautionUnclear')
    : t('documents.supplierCautionUnknown');
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
export function bboxDescription(
  box: ExtractionContract['blocks'][number]['bbox'] | null,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
): string {
  if (!box) return t('documents.bboxUnavailable');
  const [xMin, yMin, xMax, yMax] = box.map((value) => Math.round(value * 100));
  const axes = [
    xMin === 0 && xMax === 100 ? null : t('documents.bboxAcross', { min: xMin, max: xMax }),
    yMin === 0 && yMax === 100 ? null : t('documents.bboxDown', { min: yMin, max: yMax }),
  ].filter((axis): axis is string => axis !== null);
  return axes.length ? t('documents.bboxAt', { axes: axes.join(', ') }) : t('documents.bboxWholePage');
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
 * dd/mm/yyyy and dd/mm/yy (and the same with `.` or `-`), or an already-ISO date, to yyyy-mm-dd
 * for <input type="date">. Day-first is the Israeli convention these documents are printed in.
 *
 * Anything else returns '' and the field is left for the person to fill. A date that is merely
 * *probably* right is worse than an empty one here: it lands on a financial record, and an empty
 * required field is visible while a plausible wrong date is not.
 *
 * WHY THE TWO-DIGIT YEAR IS READ, added for DOC-05. The four-digit rule refused `31/07/26` — a
 * date the reader had extracted from a supplier's invoice and marked `זוהה בבירור`, printed on
 * the page in exactly that form. The consequence was not the empty field the paragraph above
 * argues for: `InvoiceNew` falls back to `todayISO()`, so a July invoice arrived on the form
 * dated September, silently, which is precisely the invisible-wrong-date this function exists to
 * avoid. Refusing the shorter form did not produce the safe outcome; it produced the unsafe one.
 *
 * `20yy`, and this is a reading convention rather than a business answer — the same kind of
 * commitment as day-first above, and the only reading that is not absurd on an invoice a business
 * has just received. Nothing is inferred beyond the century: the day and month still have to be
 * a real day and month, the result is still shown in a date field the person can see and correct,
 * and a year written any other way still returns ''.
 */
export function normalizeInvoiceDate(raw: string | number | boolean | null): string {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return text;
  const dayFirst = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/.exec(text);
  if (!dayFirst) return '';
  const [, day, month, year] = dayFirst;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return '';
  const fullYear = year.length === 2 ? `20${year}` : year;
  return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export interface InvoiceDraft {
  invoice_number: string;
  invoice_date: string;
  before_vat: string;
  vat: string;
  total: string;
  currency: string;
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
  const rawCurrency = pick(['currency', 'מטבע']);
  const currencyText = typeof rawCurrency === 'string' ? rawCurrency.trim().toUpperCase() : '';
  const currency = ({ '₪': 'ILS', NIS: 'ILS', '$': 'USD', '€': 'EUR', '£': 'GBP' } as Record<string, string>)[currencyText]
    ?? (/^[A-Z]{3}$/.test(currencyText) ? currencyText : '');
  return {
    invoice_number: typeof number === 'string' || typeof number === 'number' ? String(number).trim() : '',
    invoice_date: normalizeInvoiceDate(pick(INVOICE_DATE_KEYS)),
    before_vat: money(BEFORE_VAT_KEYS),
    vat: money(VAT_KEYS),
    total: money(TOTAL_KEYS),
    currency,
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
export function creditDraftFromInterpretation(payload: InterpretationContract, t: (key: TKey, vars?: Record<string, string | number>) => string): CreditDraft {
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
    notes: lines.length ? t('documents.creditNotesFromDocument', { lines: lines.join(', ') }) : '',
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
 * an identifier tells an operational user nothing, and — is the truthful "unknown".
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
export const FILING_REASON_KEYS: Record<string, TKey> = {
  autonomy_disabled: 'documents.filing_autonomy_disabled',
  organization_inactive: 'documents.filing_organization_inactive',
  document_type_other: 'documents.filing_document_type_other',
  confidence_unknown: 'documents.filing_confidence_unknown',
  below_confidence_threshold: 'documents.filing_below_confidence_threshold',
  not_an_invoice: 'documents.filing_not_an_invoice',
  not_a_price_list: 'documents.filing_not_a_price_list',
  not_a_delivery_note: 'documents.filing_not_a_delivery_note',
  order_unresolved: 'documents.filing_order_unresolved',
  receipt_draft_conflict: 'documents.filing_receipt_draft_conflict',
  no_line_matched: 'documents.filing_no_line_matched',
  line_not_on_order: 'documents.filing_line_not_on_order',
  line_already_received: 'documents.filing_line_already_received',
  line_quantity_unreadable: 'documents.filing_line_quantity_unreadable',
  line_quantity_exceeds_order: 'documents.filing_line_quantity_exceeds_order',
  line_product_repeated: 'documents.filing_line_product_repeated',
  supplier_unidentified: 'documents.filing_supplier_unidentified',
  currency_unrecognised: 'documents.filing_currency_unrecognised',
  /* 0324 split this arm in three. One code covered two obstacles, so the only sentence it could
     write named BOTH — and on the sweep's invoice it named the invoice number as missing while
     the same screen displayed `SI266001312` at confidence 0.95. The conjoined code survives for
     the case it was always true for: neither was extracted. */
  invoice_identity_missing: 'documents.filing_invoice_identity_missing',
  invoice_number_missing: 'documents.filing_invoice_number_missing',
  invoice_date_missing: 'documents.filing_invoice_date_missing',
  invoice_number_unrepresentable: 'documents.filing_invoice_number_unrepresentable',
  invoice_number_unreasonable: 'documents.filing_invoice_number_unreasonable',
  total_missing: 'documents.filing_total_missing',
  amounts_unreconciled: 'documents.filing_amounts_unreconciled',
  payment_allocation_conflict: 'documents.filing_payment_allocation_conflict',
  duplicate_invoice_number: 'documents.filing_duplicate_invoice_number',
  line_product_unmatched: 'documents.filing_line_product_unmatched',
  line_product_ambiguous: 'documents.filing_line_product_ambiguous',
  line_price_unreadable: 'documents.filing_line_price_unreadable',
  /* One code used to cover five failures, so a review screen told a person the price could not
     be read when the real answer was that the line is priced in another currency. */
  line_price_not_positive: 'documents.filing_line_price_not_positive',
  line_price_below_minor_unit: 'documents.filing_line_price_below_minor_unit',
  line_price_above_cap: 'documents.filing_line_price_above_cap',
  line_price_currency_mismatch: 'documents.filing_line_price_currency_mismatch',
  already_decided: 'documents.filing_already_decided',
};

/**
 * The reason the newest machine filing gives, or null when there is nothing to say.
 *
 * Null covers two DIFFERENT facts and deliberately says neither: a filing with no code that
 * carries an invoice was applied — nothing stopped it — and a filing with no code that predates
 * 0079 has a reason nobody recorded. Guessing between them on screen would be a claim about the
 * past that the data does not support.
 */
export function filingReason(snapshot: ReviewSnapshot, t: (key: TKey) => string): string | null {
  // `?? []` is not defensive noise — it was earned. The first version read `snapshot.filings`
  // directly and took the whole review screen down with "Cannot read properties of undefined"
  // wherever a snapshot predated the field. An explanatory sentence going missing is a small
  // loss; a bookkeeper meeting a blank page instead of an invoice under review is not.
  const machineFilings = (snapshot.filings ?? [])
    .filter((filing) => filing.decided_by === 'system' && !filing.reverted_at)
    .sort((a, b) => b.decided_at.localeCompare(a.decided_at));
  const code = machineFilings[0]?.reason_code;
  if (!code) return null;
  const key = FILING_REASON_KEYS[code];
  // An arm added to the ladder without a sentence here must not print a bare enum at a
  // bookkeeper. It says the honest minimum instead.
  return key ? t(key) : t('documents.filingStoppedGeneric');
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
export function documentRoutingSummary(snapshot: ReviewSnapshot, t: (key: TKey, vars?: Record<string, string | number>) => string): DocumentRoutingSummary {
  const doc = snapshot.document;
  const payload = snapshot.interpretation?.payload;
  const lineCount = payload?.line_items.length ?? 0;
  const receipt = doc?.entity_type === 'goods_receipt' ? t('documents.routingAndReceipt') : '';
  const lineSummary = lineCount === 0
    ? t('documents.routingNoLines')
    : t(lineCount === 1 ? 'documents.routingOneLine' : 'documents.routingManyLines', { count: lineCount, receipt });

  if (!doc || !payload) {
    return { completed: false, headline: t('documents.routingPendingHeadline'), destination: t('documents.routingPendingDestination'), lineSummary, path: null, actionLabel: null };
  }

  if (doc.entity_type === 'invoice' && doc.entity_id) {
    return { completed: true, headline: t('documents.routingInvoiceHeadline'), destination: t('documents.routingInvoices'), lineSummary, path: `/invoices/${doc.entity_id}`, actionLabel: t('documents.routingOpenInvoice') };
  }
  if (doc.entity_type === 'goods_receipt' && doc.entity_id) {
    return { completed: true, headline: t('documents.routingReceiptHeadline'), destination: t('documents.routingReceipts'), lineSummary, path: `/receipts/${doc.entity_id}`, actionLabel: t('documents.routingOpenReceipt') };
  }
  if (doc.entity_type === 'payment' && doc.entity_id) {
    return { completed: true, headline: t('documents.routingPaymentHeadline'), destination: t('documents.routingPayments'), lineSummary, path: '/payments', actionLabel: t('documents.routingOpenPayments') };
  }
  if (doc.entity_type === 'supplier' && doc.entity_id) {
    return { completed: true, headline: t('documents.routingSupplierHeadline'), destination: t('documents.routingSuppliers'), lineSummary, path: `/suppliers/${doc.entity_id}`, actionLabel: t('documents.routingOpenSupplier') };
  }
  if (doc.entity_type === 'archive') {
    return { completed: true, headline: t('documents.routingArchiveHeadline'), destination: t('documents.routingArchive'), lineSummary, path: '/documents/archive', actionLabel: t('documents.routingOpenArchive') };
  }

  const destination = t(({
    invoice: 'documents.routingInvoices',
    delivery_note: 'documents.routingReceipts',
    credit_note: 'documents.routingCredits',
    price_list: 'documents.routingPriceList',
    quote: 'documents.routingSupplierDocs',
    payment_confirmation: 'documents.routingPayments',
    // A receipt is evidence about something already recorded, so it has no ledger of its own to
    // be filed into — it is filed beside the invoice or payment it proves (OPEN-DECISIONS #141).
    tax_receipt: 'documents.routingExistingInvoiceOrPayment',
    other: 'documents.routingArchive',
  } as const satisfies Record<InterpretationContract['document_type'], TKey>)[payload.document_type]);
  return {
    completed: false,
    headline: t('documents.routingReadNotWritten'),
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

export function ruleWhy(rule: DocumentLearningRule | null | undefined, t: (key: TKey, vars?: Record<string, string | number>) => string): string {
  if (!rule) return t('documents.ruleWhyFallback');
  const owner = rule.user_id ? t('documents.ruleOwnerPersonal') : t('documents.ruleOwnerOrg');
  const context = rule.supplier_id
    ? t('documents.ruleScopeSupplierAndType')
    : rule.document_type
      ? t('documents.ruleScopeType')
      : t('documents.ruleScopeGlobal');
  const fingerprint = rule.mark_fingerprint ? t('documents.ruleFingerprintMatched') : t('documents.ruleFingerprintAny');
  return t('documents.ruleWhy', { owner, context, version: rule.version, fingerprint });
}

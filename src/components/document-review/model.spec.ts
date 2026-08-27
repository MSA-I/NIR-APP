import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  DocumentFeedback,
  DocumentReviewCorrection,
  DocumentTypeReviewDecision,
  ReviewSnapshot,
} from './model';
import { bboxDescription, confidenceLabel, confidencePercent, creditDraftFromInterpretation, deliveryNoteLines, documentRoutingSummary, invoiceDraftFromInterpretation, latestCorrections, matchDeliveryLineProduct, paymentConfirmationFacts, sameAmount, latestFeedbackByAnnotation, latestTypeReviewDecision, lineItemArithmetic, normalizeInvoiceDate, resolveExportTemplateWinner, resolvedText, ruleWhy, supplierMatchCaution } from './model';
import { he } from '../../lib/i18n/dictionaries/he';
import type { Dictionary } from '../../lib/i18n/dictionaries/he';
import { translate } from '../../lib/i18n/t';
import type { TKey } from '../../lib/i18n/t';

/**
 * These functions take the translator now, because the module is pure and cannot hold a hook.
 * The tests inject the HEBREW one: every assertion below still names the literal sentence, so a
 * wrong dictionary entry fails here. Comparing `t(key)` to `t(key)` would pass either way.
 */
const t = ((key, vars) => translate(he as unknown as Dictionary, key, vars)) as
  (key: TKey, vars?: Record<string, string | number>) => string;

const correction = (revision: number, text: string): DocumentReviewCorrection => ({
  id: `correction-${revision}`,
  org_id: 'org',
  interpretation_id: 'interpretation',
  extraction_id: 'extraction',
  document_id: 'document',
  target_kind: 'block',
  target_id: 'block-1',
  row_index: null,
  column_index: null,
  revision,
  input_checksum: 'etag:1111111111111111',
  contract_version: '1',
  original_text: 'מקור',
  before_text: revision === 1 ? 'מקור' : 'תיקון ראשון',
  corrected_text: text,
  actor_id: 'actor',
  reason: 'בדיקה',
  created_at: '2026-07-29T00:00:00Z',
});

test('routing summary names only a destination proven by the document row', () => {
  const base = {
    interpretation: { payload: { document_type: 'invoice', line_items: [{ values: {} }] } },
    document: { entity_type: 'inbox', entity_id: null },
  } as unknown as ReviewSnapshot;
  assert.deepEqual(documentRoutingSummary(base, t), {
    completed: false,
    headline: 'המסמך נקרא, אך עדיין לא נכתבה רשומה ביעד',
    destination: 'חשבוניות',
    lineSummary: 'שורת פריט אחת נשמרה בפירוש המסמך.',
    path: null,
    actionLabel: null,
  });
  assert.equal(documentRoutingSummary({
    ...base,
    document: { entity_type: 'invoice', entity_id: 'invoice-1' },
  } as unknown as ReviewSnapshot, t).path, '/invoices/invoice-1');
});

test('review overlays keep immutable evidence and select the newest fenced revision', () => {
  const latest = latestCorrections([correction(2, 'תיקון שני'), correction(1, 'תיקון ראשון')]);
  assert.deepEqual(resolvedText('מקור', latest, 'block', 'block-1'), {
    text: 'תיקון שני',
    revision: 2,
    corrected: true,
  });
  assert.deepEqual(resolvedText('מקור אחר', latest, 'block', 'block-2'), {
    text: 'מקור אחר',
    revision: 0,
    corrected: false,
  });
});

test('location and rule explanations stay textual', () => {
  assert.match(bboxDescription([0.1, 0.2, 0.8, 0.9], t), /10%–80%/);
  // A full-width band is what both production paths emit: FULL_BBOX for digital PDF text, and one
  // band per line from the OpenAI OCR adapter. The constant axis is dropped so the varying one
  // is not buried under "0%–100% לרוחב" on every single row.
  assert.equal(bboxDescription([0, 0.26, 1, 0.3], t), 'מיקום בעמוד: 26%–30% לגובה');
  assert.equal(bboxDescription([0, 0, 1, 1], t), 'פרוס על פני כל העמוד');
  assert.match(ruleWhy({
    id: 'rule', org_id: 'org', family_id: 'family', version: 3, user_id: 'user', document_type: 'invoice',
    supplier_id: null, mark_kind: 'check', mark_fingerprint: 'fingerprint', tag_key: 'approved',
    label: 'מאושר', active: true, created_by: 'user', created_at: '2026-07-29T00:00:00Z',
    disabled_at: null, disabled_by: null, disable_reason: null,
  }, t), /כלל אישי.*גרסה 3.*טביעת/);
});

test('confidence reaches the reviewer as words, never as a percentage', () => {
  // The owner's complaint, as an executable rule: no digit and no percent sign may reach the
  // everyday label. If someone reintroduces "רמת ביטחון 87%" this line is what fails.
  for (const value of [1, 0.97, 0.9, 0.89, 0.7, 0.69, 0.42, 0]) {
    assert.equal(/[0-9%]/.test(confidenceLabel(value, t)), false, `numeric leak at ${value}`);
  }
  // The thresholds themselves — pinned so that moving them is a deliberate edit with a test diff,
  // not a silent drift. They are a product judgement (see model.ts); nothing here is calibrated.
  assert.equal(confidenceLabel(0.97, t), 'זוהה בבירור');
  assert.equal(confidenceLabel(0.9, t), 'זוהה בבירור');     // boundary is inclusive
  assert.equal(confidenceLabel(0.89, t), 'זוהה חלקית');
  assert.equal(confidenceLabel(0.7, t), 'זוהה חלקית');      // boundary is inclusive
  assert.equal(confidenceLabel(0.69, t), 'לא ודאי');
  // A measured zero is a real statement about the reading and keeps the lowest grade.
  assert.equal(confidenceLabel(0, t), 'לא ודאי');
});

test('an absent confidence says it is unknown and never poses as the lowest grade', () => {
  // CLAUDE.md: a metric with no data shows —, never 0. The verbal equivalent is that "unknown"
  // must not read as "we checked and it was bad", which is a claim about the document.
  for (const missing of [null, undefined, Number.NaN]) {
    assert.equal(confidenceLabel(missing, t), 'רמת הזיהוי אינה ידועה');
    assert.notEqual(confidenceLabel(missing, t), confidenceLabel(0, t));
    assert.equal(confidencePercent(missing), '—');
  }
  // The number is moved, not deleted: the technical disclosure still prints it.
  assert.equal(confidencePercent(0.87), '87%');
  assert.equal(confidencePercent(1), '100%');
  // A measured zero prints as 0%, because something did measure it. Only absence prints —.
  assert.equal(confidencePercent(0), '0%');
});

test('the disclosure does not round a value across the threshold it is being judged by', () => {
  // Whole percent turned 0.899 into "90%" on the one surface built for diagnosis, next to a screen
  // saying "זוהה חלקית" against a documented 0.9 cut point — a contradiction created purely by the
  // display. Two decimals, and the trailing zeros stripped so ordinary values stay readable.
  assert.equal(confidenceLabel(0.899, t), 'זוהה חלקית');
  assert.equal(confidencePercent(0.899), '89.9%');
  assert.equal(confidencePercent(0.865), '86.5%');
  assert.equal(confidencePercent(0.8749), '87.49%');
  // Binary-float noise does not leak: 0.87*100 is 87.00000000000001.
  assert.equal(confidencePercent(0.87), '87%');
  assert.equal(confidencePercent(0.62), '62%');
});

test('a confidence outside the contract range cannot buy the strongest claim', () => {
  // Unreachable through every write path today, which is exactly why it would be believed if it
  // ever appeared. Above 1 is a broken payload: it must not read as "זוהה בבירור", and it must not
  // silence the supplier check either.
  assert.equal(confidenceLabel(1.5, t), 'רמת הזיהוי אינה ידועה');
  assert.equal(confidenceLabel(101, t), 'רמת הזיהוי אינה ידועה');
  assert.notEqual(supplierMatchCaution(1.5, t), null);
  // Below 0 is equally broken but falls into the loudest grade, which errs toward more scrutiny.
  // A corrupt number that under-claims needs no guard, so this stays as it is.
  assert.equal(confidenceLabel(-1, t), 'לא ודאי');
  // The disclosure still shows the corruption rather than laundering it into a plausible number.
  assert.equal(confidencePercent(1.5), '150%');
  assert.equal(confidencePercent(-1), '-100%');
});

test('a supplier match that is not clear carries an instruction, a field of the same grade does not', () => {
  // A wrong date is corrected on the next screen; a wrong supplier prefills the payee of an
  // invoice (the draft carries suggested_supplier_id straight into the form), so the same grade
  // has to oblige more here than it does on an ordinary field.
  assert.equal(supplierMatchCaution(0.97, t), null);
  assert.equal(supplierMatchCaution(0.9, t), null);
  assert.match(supplierMatchCaution(0.89, t) ?? '', /לאמת את שם הספק/);
  assert.match(supplierMatchCaution(0.42, t) ?? '', /לאמת את שם הספק/);
  // Unknown is not permission to skip the check; it is the reason to run it.
  assert.match(supplierMatchCaution(null, t) ?? '', /לאמת את שם הספק/);
  assert.match(supplierMatchCaution(undefined, t) ?? '', /לאמת את שם הספק/);
  // The asymmetry itself: identical number, identical grade, different obligation.
  assert.equal(confidenceLabel(0.8, t), 'זוהה חלקית');
  assert.notEqual(supplierMatchCaution(0.8, t), null);
});

test('invoice draft reads what the model offered and guesses nothing else', () => {
  const payload = {
    document_type: 'invoice', document_type_confidence: 0.9,
    supplier: { suggested_id: null, suggested_name: 'ספק', confidence: 0.9, evidence_block_ids: [] },
    fields: [
      { key: 'invoice_number', value: ' INV-2026-1042 ', confidence: 0.97, evidence_block_ids: [] },
      { key: 'invoice_date', value: '03/04/2026', confidence: 0.9, evidence_block_ids: [] },
      { key: 'subtotal', value: '₪ 1,392.00', confidence: 0.9, evidence_block_ids: [] },
      { key: 'total', value: 745.6, confidence: 0.93, evidence_block_ids: [] },
    ],
    line_items: [], suggested_annotations: [],
  } as unknown as Parameters<typeof invoiceDraftFromInterpretation>[0];
  assert.deepEqual(invoiceDraftFromInterpretation(payload), {
    invoice_number: 'INV-2026-1042',
    invoice_date: '2026-04-03',   // day-first, the convention these documents are printed in
    before_vat: '1392',
    vat: '',                      // not offered -> left for the person, never inferred from the others
    total: '745.6',
  });
});

test('invoice draft leaves an unparseable date empty rather than plausible', () => {
  // A date that is merely probably right lands on a financial record and is invisible once wrong.
  assert.equal(normalizeInvoiceDate('2026-04-03'), '2026-04-03');
  assert.equal(normalizeInvoiceDate('3.4.2026'), '2026-04-03');
  assert.equal(normalizeInvoiceDate('April 3, 2026'), '');
  assert.equal(normalizeInvoiceDate('03/13/2026'), '');   // month 13: not day-first, so not read
  assert.equal(normalizeInvoiceDate(null), '');
});

test('delivery note lines are read from either vocabulary the model uses', () => {
  const payload = {
    document_type: 'delivery_note',
    line_items: [
      { source_row: 1, values: { sku: 'DRK-001', description: 'קולה 1.5 ל׳', quantity: '12' }, evidence_block_ids: [] },
      { source_row: 2, values: { 'מק״ט': 'DRK-002', 'תיאור': 'מים', 'כמות': 6 }, evidence_block_ids: [] },
      { source_row: 3, values: { description: 'פריט ללא כמות' }, evidence_block_ids: [] },
    ],
    fields: [],
  } as unknown as Parameters<typeof deliveryNoteLines>[0];
  assert.deepEqual(deliveryNoteLines(payload), [
    { sourceRow: 1, sku: 'DRK-001', barcode: null, description: 'קולה 1.5 ל׳', quantity: 12 },
    { sourceRow: 2, sku: 'DRK-002', barcode: null, description: 'מים', quantity: 6 },
    { sourceRow: 3, sku: null, barcode: null, description: 'פריט ללא כמות', quantity: null },
  ]);
});

test('delivery line matching prefers the supplier own code and refuses to guess', () => {
  const catalogue = [
    { productId: 'p1', supplierSku: 'S-100', sku: 'OUR-1', barcode: null, name: 'קולה 1.5 ליטר' },
    { productId: 'p2', supplierSku: 'OUR-1', sku: 'OUR-2', barcode: null, name: 'מים מינרליים' },
  ];
  const line = (over: Partial<Parameters<typeof matchDeliveryLineProduct>[0]>) =>
    ({ sourceRow: 1, sku: null, barcode: null, description: null, quantity: 1, ...over });

  // The supplier's own catalogue number is what is printed on their delivery note, so it wins even
  // when the same string is one of our skus on a different product.
  assert.equal(matchDeliveryLineProduct(line({ sku: 'OUR-1' }), catalogue), 'p2');
  assert.equal(matchDeliveryLineProduct(line({ sku: 'S-100' }), catalogue), 'p1');
  // Name matching is exact after normalising whitespace and case, never fuzzy.
  assert.equal(matchDeliveryLineProduct(line({ description: '  מים   מינרליים ' }), catalogue), 'p2');
  assert.equal(matchDeliveryLineProduct(line({ description: 'מים' }), catalogue), null);
  // Two products answering to the same code is not a match: the catalogue cannot say which arrived.
  assert.equal(matchDeliveryLineProduct(line({ sku: 'DUP' }), [
    { productId: 'p1', supplierSku: 'DUP', sku: null, barcode: null, name: 'א' },
    { productId: 'p2', supplierSku: 'DUP', sku: null, barcode: null, name: 'ב' },
  ]), null);
  assert.equal(matchDeliveryLineProduct(line({}), catalogue), null);
});

test('credit draft carries the amount and the credited invoice, never the reason', () => {
  const payload = {
    document_type: 'credit_note',
    fields: [
      { key: 'document_number', value: 'CN-77', confidence: 0.9, evidence_block_ids: [] },
      { key: 'reference_invoice_number', value: ' INV-2026-1042 ', confidence: 0.9, evidence_block_ids: [] },
      { key: 'total', value: '-120.50', confidence: 0.9, evidence_block_ids: [] },
    ],
    line_items: [
      { source_row: 1, values: { description: 'קולה 1.5 ל׳', quantity: '2' }, evidence_block_ids: [] },
    ],
  } as unknown as Parameters<typeof creditDraftFromInterpretation>[0];
  const draft = creditDraftFromInterpretation(payload, t);
  // The credit note prints a negative total; the sign is carried by the document type, not the row.
  assert.equal(draft.amount, '120.5');
  // The explicit reference beats the credit note's own number.
  assert.equal(draft.creditedInvoiceNumber, 'INV-2026-1042');
  assert.equal(draft.notes, 'לפי המסמך: קולה 1.5 ל׳ × 2');
  // credit_reason is a business fact about why money is owed; the document states an amount only.
  assert.equal('reason' in draft, false);
});

test('payment confirmation reads the amount, date and reference and nothing about invoices', () => {
  const payload = {
    document_type: 'payment_confirmation',
    fields: [
      { key: 'reference', value: ' 4471902 ', confidence: 0.9, evidence_block_ids: [] },
      { key: 'payment_date', value: '28/07/2026', confidence: 0.9, evidence_block_ids: [] },
      { key: 'total', value: '-1,240.00', confidence: 0.9, evidence_block_ids: [] },
    ],
    line_items: [],
  } as unknown as Parameters<typeof paymentConfirmationFacts>[0];
  assert.deepEqual(paymentConfirmationFacts(payload), {
    amount: 1240,             // a debit prints negative; the direction is the document's type
    paidDate: '2026-07-28',
    reference: '4471902',
  });
  // A bank confirmation names no invoice, and this must never start pretending otherwise:
  // allocations come from the approved payment request, before the money moves.
  assert.equal('invoiceIds' in paymentConfirmationFacts(payload), false);
});

test('payment amounts match to the agora, not approximately', () => {
  assert.equal(sameAmount(1240, 1240.004), true);
  assert.equal(sameAmount(1240, 1240.5), false);
  assert.equal(sameAmount(null, 1240), false);
  assert.equal(sameAmount(1240, null), false);
});

test('document type review uses the highest append-only revision', () => {
  const decision = (revision: number, value: 'approved' | 'rejected'): DocumentTypeReviewDecision => ({
    id: `decision-${revision}`,
    org_id: 'org',
    interpretation_id: 'interpretation',
    extraction_id: 'extraction',
    document_id: 'document',
    revision,
    decision: value,
    suggested_document_type: 'invoice',
    approved_document_type: value === 'approved' ? 'invoice' : null,
    input_checksum: 'etag:1111111111111111',
    contract_version: '1',
    actor_id: 'actor',
    reason: 'בדיקה',
    created_at: '2026-07-29T00:00:00Z',
  });

  assert.equal(latestTypeReviewDecision([decision(2, 'rejected'), decision(1, 'approved')])?.revision, 2);
  assert.equal(latestTypeReviewDecision([]), null);
});

test('annotation feedback uses the latest decision and prevents an older decision resurfacing', () => {
  const feedback = (id: string, createdAt: string): DocumentFeedback => ({
    id,
    org_id: 'org',
    interpretation_id: 'interpretation',
    annotation_id: 'annotation',
    feedback_type: id === 'feedback-2' ? 'accepted' : 'rejected',
    before_value: {},
    after_value: {},
    actor_id: 'actor',
    reason: 'בדיקה',
    correction_annotation_id: null,
    created_at: createdAt,
  });

  const latest = latestFeedbackByAnnotation([
    feedback('feedback-1', '2026-07-29T10:00:00Z'),
    feedback('feedback-2', '2026-07-29T11:00:00Z'),
  ]);
  assert.equal(latest.get('annotation')?.id, 'feedback-2');
});

test('export preview resolves one approved active template by the database precedence', () => {
  type TemplateRow = ReviewSnapshot['exportTemplates'][number];
  type TemplateVersion = ReviewSnapshot['exportTemplateVersions'][number];
  const template = (
    id: string,
    ownerUserId: string | null,
    documentType: TemplateRow['document_type'],
    supplierId: string | null,
  ): TemplateRow => ({
    id,
    org_id: 'org',
    owner_user_id: ownerUserId,
    document_type: documentType,
    supplier_id: supplierId,
    active_version_id: `${id}-version`,
    active: true,
    created_by: 'actor',
    created_at: '2026-07-29T00:00:00Z',
    disabled_at: null,
    disabled_by: null,
    disable_reason: null,
  });
  const version = (row: TemplateRow, approved: boolean): TemplateVersion => ({
    id: row.active_version_id!,
    org_id: row.org_id,
    template_id: row.id,
    version: 1,
    schema_version: '1',
    format: 'table',
    contract: {
      schema_version: '1',
      name: row.id,
      format: 'table',
      scope: {
        document_type: row.document_type,
        supplier_id: row.supplier_id,
        user_id: row.owner_user_id,
      },
      columns: [{ key: 'kind', label: 'סוג', source_path: 'document_type', type: 'text', required: true }],
    },
    created_by: 'actor',
    created_at: '2026-07-29T00:00:00Z',
    approved_by: approved ? 'approver' : null,
    approved_at: approved ? '2026-07-29T00:01:00Z' : null,
  });
  const personalSupplier = template('personal-supplier', 'actor', null, 'supplier');
  const organizationSupplier = template('organization-supplier', null, null, 'supplier');
  const personalType = template('personal-type', 'actor', 'invoice', null);
  const global = template('global', null, null, null);
  const snapshot = {
    interpretation: {
      org_id: 'org',
      suggested_supplier_id: 'supplier',
      payload: { document_type: 'invoice' },
    },
    exportTemplates: [global, personalType, organizationSupplier, personalSupplier],
    exportTemplateVersions: [
      version(global, true),
      version(personalType, true),
      version(organizationSupplier, true),
      version(personalSupplier, false),
    ],
  } as ReviewSnapshot;

  assert.equal(resolveExportTemplateWinner(snapshot, 'actor')?.row.id, 'organization-supplier');
  snapshot.interpretation!.suggested_supplier_id = null;
  assert.equal(resolveExportTemplateWinner(snapshot, 'actor')?.row.id, 'personal-type');
});

// The rows below are verbatim from the 2026-08-02 Hebrew benchmark, including the one row where
// the provider misread a price.
test('line arithmetic accepts real invoice rows, including thousands separators and currency', () => {
  assert.equal(
    lineItemArithmetic({ quantity: '4.00', unit_price: '19.50', line_total: '78.00' })?.consistent,
    true,
  );
  assert.equal(
    lineItemArithmetic({ quantity: '16.00', unit_price: '87.00', line_total: '1,392.00' })?.consistent,
    true,
  );
  assert.equal(
    lineItemArithmetic({ quantity: '11.34', unit_price: '₪ 41.00', line_total: '464.94' })?.consistent,
    true,
  );
  assert.equal(
    lineItemArithmetic({ 'כמות': 4, 'מחיר ליחידה': 19.5, 'סה"כ מחיר': 78 })?.consistent,
    true,
  );
});

test('line arithmetic flags the decimal shift that would corrupt a stored price', () => {
  // The provider read 3.50 as 35.00 on a real delivery note; the line total stayed correct.
  const result = lineItemArithmetic({ quantity: '40.00', unit_price: '35.00', line_total: '140.00' });
  assert.equal(result?.consistent, false);
  assert.equal(result?.expected, 1400);
  assert.equal(result?.lineTotal, 140);
});

test('line arithmetic stays silent when a row has no quantity/price/total triple', () => {
  assert.equal(lineItemArithmetic({ sku: 'SKU-1', price: '31.90' }), null);
  assert.equal(lineItemArithmetic({ quantity: 'ארבע', unit_price: '19.50', line_total: '78.00' }), null);
  assert.equal(lineItemArithmetic({}), null);
});

test('line arithmetic cannot catch a price and total that drifted together', () => {
  // Documented limit, not an oversight: on the same benchmark the provider turned 18.00/1.50 into
  // 187.20/15.60, which multiplies out perfectly. Only a human comparing against the page finds it.
  assert.equal(
    lineItemArithmetic({ quantity: '12.00', unit_price: '15.60', line_total: '187.20' })?.consistent,
    true,
  );
});

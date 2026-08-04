import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DocumentFeedback,
  DocumentReviewCorrection,
  DocumentTypeReviewDecision,
  ReviewSnapshot,
} from './model';
// @ts-expect-error Node's type-stripping test runner requires the explicit TypeScript extension.
import { bboxDescription, invoiceDraftFromInterpretation, latestCorrections, latestFeedbackByAnnotation, latestTypeReviewDecision, lineItemArithmetic, normalizeInvoiceDate, resolveExportTemplateWinner, resolvedText, ruleWhy } from './model.ts';

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
  assert.match(bboxDescription([0.1, 0.2, 0.8, 0.9]), /10%–80%/);
  // A full-width band is what both production paths emit: FULL_BBOX for digital PDF text, and one
  // band per line from the OpenAI OCR adapter. The constant axis is dropped so the varying one
  // is not buried under "0%–100% לרוחב" on every single row.
  assert.equal(bboxDescription([0, 0.26, 1, 0.3]), 'מיקום בעמוד: 26%–30% לגובה');
  assert.equal(bboxDescription([0, 0, 1, 1]), 'פרוס על פני כל העמוד');
  assert.match(ruleWhy({
    id: 'rule', org_id: 'org', family_id: 'family', version: 3, user_id: 'user', document_type: 'invoice',
    supplier_id: null, mark_kind: 'check', mark_fingerprint: 'fingerprint', tag_key: 'approved',
    label: 'מאושר', active: true, created_by: 'user', created_at: '2026-07-29T00:00:00Z',
    disabled_at: null, disabled_by: null, disable_reason: null,
  }), /כלל אישי.*גרסה 3.*טביעת/);
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

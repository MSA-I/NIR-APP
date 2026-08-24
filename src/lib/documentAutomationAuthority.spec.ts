import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(path), 'utf8');
const noRawDml = (value: string) => {
  expect(value).not.toMatch(/from\(["']document_(?:extractions|interpretations)["']\)\s*\.(?:insert|update|delete)/);
};

describe('authoritative document automation call graph', () => {
  it('OCR worker reaches raw evidence only through document-processing Edge', () => {
    const gateway = source('worker/ocr/src/gateway.py');
    expect(gateway).toContain('/functions/v1/document-processing');
    expect(gateway).not.toContain('/rest/v1/');
    const edge = source('supabase/functions/document-processing/index.ts');
    for (const rpc of [
      'service_record_document_ocr_evidence',
      'complete_document_processing_job',
      'service_recover_document_extraction_from_egress',
    ]) expect(edge).toContain(rpc);
    noRawDml(edge);
  });

  it('interpret Edge reads evidence but persists/calls automation through named RPCs only', () => {
    const edge = source('supabase/functions/interpret-document/index.ts');
    for (const rpc of [
      'begin_document_interpretation',
      'service_recover_document_interpretation_from_egress',
      'apply_document_interpretation',
      'apply_delivery_note_interpretation',
      'apply_eligible_price_list_interpretation',
      'run_price_list_shadow',
    ]) expect(edge).toContain(rpc);
    noRawDml(edge);
    expect(edge).not.toMatch(/from\(["']purchase_order(?:s|_items)["']\)\s*\.(?:insert|update|delete)/);
  });

  it('DB migration carries an explicit signature registry, callee anchors and every activation setter', () => {
    const migration = source('supabase/migrations/0182_qualified_product_creation_guards.sql');
    for (const signature of [
      'complete_document_processing_job(uuid,uuid,text,uuid,uuid,text)',
      'save_document_interpretation(uuid,uuid,uuid,timestamptz,text,text,text,text,jsonb,jsonb,integer)',
      'apply_document_interpretation(uuid,uuid,uuid)',
      'apply_delivery_note_interpretation(uuid,uuid,uuid)',
      'apply_reviewed_document(uuid,uuid,jsonb,uuid,text)',
      'apply_eligible_price_list_interpretation(uuid,uuid,uuid)',
      'apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)',
      'platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)',
      'platform_set_autonomy_policy(uuid,text,boolean,numeric,text)',
      'get_price_list_drift_metrics(integer)',
    ]) expect(migration).toContain(signature);
    expect(migration).toContain('call_graph_anchor_missing');
    expect(migration).toContain('unregistered_raw_evidence_writer');
    expect(migration).toContain('unregistered_activation_writer');
    expect(migration).not.toContain("p.proname like '%document%'");
  });
});

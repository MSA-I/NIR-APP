import { useEffect, useMemo } from 'react';
import type { DocumentExportTemplate } from './documentExport';
import { supabase } from './supabase';
import { fetchAll, fetchInChunks } from './supabasePaging';
import type {
  DocumentExtraction,
  DocumentProcessingJob,
  DocumentProcessingStatus,
  DocumentRow,
} from './types';
import { useQuery } from './useQuery';

export const DOCUMENT_PROCESSING_CHANGED_EVENT = 'sf:document-processing-changed';

export type DocumentProcessingStage =
  | 'unprocessed'
  | 'queued'
  | 'processing'
  | 'extracted'
  | 'review'
  | 'completed'
  | 'failed';

export type DocumentStageTone = 'idle' | 'await' | 'info' | 'done' | 'alert';

/**
 * The ENGINEERING stage table. The seven stages stay, because the database contract, the SQL
 * suites and the browser scenarios all measure them, and a reviewer standing in front of a stuck
 * job needs to know *which* step stopped. User-facing precedence lives only in `documentStatus.ts`.
 *
 * **Where a stage and a canonical state name the same thing, they now carry the same string.**
 * `review` used to read "דורש בדיקה" here and "נדרשת בדיקה" there, and `failed` "נכשל" against
 * "העיבוד נכשל" — one state, two Hebrew names, decided by which module a screen happened to
 * import. Two of these strings differ deliberately and only there: `unprocessed` and `extracted`
 * are finer engineering distinctions that canonical precedence folds into "לא משויך" and "בעיבוד",
 * so no canonical label exists to match. `deadEndFixes.spec.tsx` pins both halves of that rule.
 *
 * These `label`/`tone` fields have no product consumer today — every screen renders
 * `documentUiStatus`. The key set is what is load-bearing.
 */
export const DOCUMENT_PROCESSING_STAGE_META: Record<
  DocumentProcessingStage,
  { label: string; tone: DocumentStageTone }
> = {
  unprocessed: { label: 'טרם נשלח לעיבוד', tone: 'idle' },
  queued: { label: 'ממתין לעיבוד', tone: 'await' },
  processing: { label: 'בעיבוד', tone: 'info' },
  // Its own stage because nothing is running here: the text is out and the interpretation is
  // waiting to be requested. Showing "בעיבוד" told people to wait for something that had already
  // stopped, which is the one thing a status badge must never do.
  extracted: { label: 'ממתין לפירוש', tone: 'info' },
  review: { label: 'נדרשת בדיקה', tone: 'await' },
  completed: { label: 'הושלם', tone: 'done' },
  failed: { label: 'העיבוד נכשל', tone: 'alert' },
};

export type DocumentInterpretationType =
  | 'invoice'
  | 'delivery_note'
  | 'credit_note'
  | 'price_list'
  | 'quote'
  | 'payment_confirmation'
  | 'tax_receipt'
  | 'other';

export type InterpretationContract = {
  schema_version: '1';
  document_type: DocumentInterpretationType;
  document_type_confidence: number | null;
  packet_segments?: Array<{
    ordinal: number;
    start_page: number;
    end_page: number;
    document_type: DocumentInterpretationType;
    confidence: number | null;
  }>;
  supplier: {
    suggested_id: string | null;
    suggested_name: string | null;
    confidence: number | null;
    evidence_block_ids: string[];
  };
  fields: Array<{
    key: string;
    value: string | number | boolean | null;
    confidence: number | null;
    evidence_block_ids: string[];
  }>;
  line_items: Array<{
    source_row: number | null;
    values: Record<string, string | number | null>;
    evidence_block_ids: string[];
  }>;
  suggested_annotations: Array<{
    tag_key: string;
    label: string;
    target_block_ids: string[];
    evidence_mark_ids: string[];
    confidence: number | null;
  }>;
};

export interface DocumentInterpretation {
  id: string;
  org_id: string;
  job_id: string;
  extraction_id: string;
  document_id: string;
  interpreted_for_user_id: string;
  provider: string;
  model: string;
  prompt_version: string;
  schema_version: '1';
  payload: InterpretationContract;
  suggested_supplier_id: string | null;
  usage: Record<string, unknown>;
  duration_ms: number | null;
  created_at: string;
}

export interface DocumentAnnotation {
  id: string;
  org_id: string;
  interpretation_id: string;
  extraction_id: string;
  document_id: string;
  target_kind: 'block' | 'mark';
  target_id: string;
  tag_key: string;
  label: string;
  // 'claude' is the stored legacy token for a provider-generated suggestion; it is never shown
  // to a user. See ANNOTATION_SOURCE_LABELS in components/document-review/model.ts.
  source: 'user' | 'rule' | 'claude';
  applied_for_user_id: string | null;
  rule_id: string | null;
  rule_version: number | null;
  confidence: number | null;
  evidence_mark_ids: string[];
  active: boolean;
  created_by: string | null;
  created_at: string;
  corrected_at: string | null;
  corrected_by: string | null;
  correction_annotation_id: string | null;
}

export interface DocumentRuleApplication {
  id: string;
  org_id: string;
  interpretation_id: string;
  extraction_id: string;
  document_id: string;
  rule_id: string;
  rule_version: number;
  applied_for_user_id: string;
  target_kind: 'mark';
  target_id: string;
  confidence: number | null;
  annotation_id: string;
  created_at: string;
}

export interface DocumentLearningRule {
  id: string;
  org_id: string;
  family_id: string;
  version: number;
  user_id: string | null;
  document_type: InterpretationContract['document_type'] | null;
  supplier_id: string | null;
  mark_kind: 'circle' | 'check' | 'cross' | 'underline' | 'star' | 'custom' | 'unknown';
  mark_fingerprint: string | null;
  tag_key: string;
  label: string;
  active: boolean;
  created_by: string;
  created_at: string;
  disabled_at: string | null;
  disabled_by: string | null;
  disable_reason: string | null;
}

export interface DocumentReviewCorrection {
  id: string;
  org_id: string;
  interpretation_id: string;
  extraction_id: string;
  document_id: string;
  target_kind: 'block' | 'table_cell';
  target_id: string;
  row_index: number | null;
  column_index: number | null;
  revision: number;
  input_checksum: string;
  contract_version: '1';
  original_text: string;
  before_text: string;
  corrected_text: string;
  actor_id: string;
  reason: string;
  created_at: string;
}

export interface DocumentTypeReviewDecision {
  id: string;
  org_id: string;
  interpretation_id: string;
  extraction_id: string;
  document_id: string;
  revision: number;
  decision: 'approved' | 'rejected';
  suggested_document_type: InterpretationContract['document_type'];
  approved_document_type: InterpretationContract['document_type'] | null;
  input_checksum: string;
  contract_version: '1';
  actor_id: string;
  reason: string;
  created_at: string;
}

/**
 * One row per filing decision (0075), including the ones the machine made and declined to act on.
 *
 * `reason_code` (0079) is which arm of apply_document_interpretation's ladder decided it. It is
 * NULL on an `auto_applied` row — nothing stopped it — and NULL on any row written before the
 * column existed. Those two are not the same fact, and the screen must not merge them: a filing
 * that has an invoice attached was applied; one that does not and has no code predates the column.
 */
export interface DocumentFiling {
  id: string;
  org_id: string;
  document_id: string;
  category: InterpretationContract['document_type'];
  supplier_id: string | null;
  interpretation_id: string | null;
  confidence: number | null;
  decided_by: 'system' | 'human';
  decided_at: string;
  reverted_at: string | null;
  reverted_reason: string | null;
  reason_code: string | null;
}

export interface PriceListInterpretationDecision {
  id: string;
  org_id: string;
  document_id: string;
  job_id: string;
  interpretation_id: string;
  actor_id: string;
  supplier_id: string | null;
  submission_id: string | null;
  outcome: 'queued_for_review' | 'partially_applied' | 'auto_applied';
  reason_code: string | null;
  decision_confidence: number | null;
  accepted_count: number;
  waiting_count: number;
  created_product_count: number;
  created_at: string;
  reverted_at: string | null;
  reverted_by: string | null;
  reverted_reason: string | null;
}

export interface PriceListInterpretationLine {
  id: string;
  org_id: string;
  decision_id: string;
  document_id: string;
  interpretation_id: string;
  line_index: number;
  source_row: number | null;
  outcome: 'applied' | 'waiting';
  reason_code: string | null;
  product_id: string | null;
  supplier_product_id: string | null;
  sku: string | null;
  barcode: string | null;
  unit_price: number | null;
  product_created: boolean;
  created_at: string;
}

/**
 * What the automation WOULD have done with each line, recorded by `run_price_list_shadow` (0096)
 * before any price could move.
 *
 * Read here for one reason: the manual confirmation screen was making a person re-do work the server
 * had already done. The shadow row holds the matched product, how it was matched and the price that
 * was read, for every line — and the screen was opening an empty product select beside it.
 *
 * A shadow row is a PREDICTION and never an approval. `submit-price-list` still takes the human's
 * approved rows, still writes the audit reason, and still refuses a product the catalogue does not
 * have. Prefilling from it is the same act as prefilling an invoice form from an interpretation.
 *
 * RLS (0096) grants select to the `owner` role only, so another role reads zero rows. That costs the
 * convenience, never correctness: an unfilled line stays unapproved and visible.
 */
export interface PriceListPredictedLine {
  id: string;
  org_id: string;
  shadow_run_id: string;
  document_id: string;
  interpretation_id: string;
  line_index: number;
  source_row: number | null;
  predicted_action: 'apply_existing_price' | 'create_product' | 'review' | 'rejected_by_policy';
  reason_code: string | null;
  matched_by: string | null;
  product_id: string | null;
  supplier_product_id: string | null;
  sku: string | null;
  barcode: string | null;
  product_name: string | null;
  unit: string | null;
  proposed_unit_price: number | null;
  current_unit_price: number | null;
  price_change_percent: number | null;
  product_would_be_created: boolean;
  created_at: string;
}

export interface DocumentFeedback {
  id: string;
  org_id: string;
  interpretation_id: string;
  annotation_id: string;
  feedback_type: 'accepted' | 'rejected' | 'corrected';
  before_value: Record<string, unknown>;
  after_value: Record<string, unknown>;
  actor_id: string;
  reason: string;
  correction_annotation_id: string | null;
  created_at: string;
}

export interface DocumentExportTemplateRow {
  id: string;
  org_id: string;
  owner_user_id: string | null;
  document_type: InterpretationContract['document_type'] | null;
  supplier_id: string | null;
  active_version_id: string | null;
  active: boolean;
  created_by: string;
  created_at: string;
  disabled_at: string | null;
  disabled_by: string | null;
  disable_reason: string | null;
}

export interface DocumentExportTemplateVersion {
  id: string;
  org_id: string;
  template_id: string;
  version: number;
  schema_version: '1';
  format: DocumentExportTemplate['format'];
  contract: DocumentExportTemplate;
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

export interface DocumentExportRow {
  id: string;
  org_id: string;
  document_id: string;
  extraction_id: string;
  interpretation_id: string;
  template_id: string;
  template_version_id: string;
  format: DocumentExportTemplate['format'];
  content_checksum: string;
  storage_path: string | null;
  result_metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

export interface DocumentPacket {
  id: string;
  org_id: string;
  unit_id: string | null;
  parent_document_id: string;
  source_job_id: string;
  source_interpretation_id: string;
  page_count: number;
  source_partial: boolean;
  confidence_threshold: number;
  automatic_eligible: boolean;
  status: 'needs_review' | 'approved' | 'materialized' | 'failed';
  manifest_hash: string;
  manifest_version: number;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  approval_reason: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentPacketSegment {
  id: string;
  org_id: string;
  unit_id: string | null;
  packet_id: string;
  ordinal: number;
  start_page: number;
  end_page: number;
  document_type: DocumentInterpretationType;
  confidence: number | null;
  child_document_id: string | null;
  storage_path: string | null;
  created_at: string;
  materialized_at: string | null;
}

export interface DocumentProcessingSnapshot {
  documentId: string;
  stage: DocumentProcessingStage;
  document: DocumentRow | null;
  job: DocumentProcessingJob | null;
  jobs: DocumentProcessingJob[];
  extraction: DocumentExtraction | null;
  extractions: DocumentExtraction[];
  interpretation: DocumentInterpretation | null;
  interpretations: DocumentInterpretation[];
  annotations: DocumentAnnotation[];
  ruleApplications: DocumentRuleApplication[];
  learningRules: DocumentLearningRule[];
  reviewCorrections: DocumentReviewCorrection[];
  typeReviewDecisions: DocumentTypeReviewDecision[];
  filings: DocumentFiling[];
  priceListDecision: PriceListInterpretationDecision | null;
  priceListLines: PriceListInterpretationLine[];
  priceListPredictions: PriceListPredictedLine[];
  feedback: DocumentFeedback[];
  exportTemplates: DocumentExportTemplateRow[];
  exportTemplateVersions: DocumentExportTemplateVersion[];
  exports: DocumentExportRow[];
  packet: DocumentPacket | null;
  packetSegments: DocumentPacketSegment[];
  /**
   * actor uuid → full name, for the review layers that record who acted (corrections, type
   * decisions, annotation feedback). A missing key is the honest "not visible to you": RLS hides
   * tenant staff from a supplier account, and the UI renders — rather than falling back to the raw
   * uuid, which means nothing to the non-technical users in PRODUCT.md.
   */
  actorNames: Map<string, string>;
}

const ALL_COLUMNS = '*';

export function documentProcessingStage(status?: DocumentProcessingStatus): DocumentProcessingStage {
  if (!status) return 'unprocessed';
  if (status === 'awaiting_scan') return 'queued';
  if (status === 'queued') return 'queued';
  if (status === 'extracted') return 'extracted';
  if (status === 'leased' || status === 'interpreting') return 'processing';
  return status;
}

function createSnapshot(documentId: string): DocumentProcessingSnapshot {
  return {
    documentId,
    stage: 'unprocessed',
    document: null,
    job: null,
    jobs: [],
    extraction: null,
    extractions: [],
    interpretation: null,
    interpretations: [],
    annotations: [],
    ruleApplications: [],
    learningRules: [],
    reviewCorrections: [],
    typeReviewDecisions: [],
    filings: [],
    priceListDecision: null,
    priceListLines: [],
    priceListPredictions: [],
    feedback: [],
    exportTemplates: [],
    exportTemplateVersions: [],
    exports: [],
    packet: null,
    packetSegments: [],
    actorNames: new Map(),
  };
}

/**
 * `orderColumn` exists because assuming `created_at` broke the review screen in production.
 *
 * Every table this helper had been pointed at happened to have a `created_at`, so the column name
 * was baked in. `document_filings` does not have one — its timestamp is `decided_at`, because a
 * filing records WHEN SOMEONE DECIDED, not when a row appeared. PostgREST answers an order-by on a
 * column that does not exist with 400, `fetchAll` throws, and the throw takes the whole snapshot
 * load down: the screen rendered nothing but "הפעולה נכשלה".
 *
 * The lesson is the parameter. A default that is right for six tables and silently wrong for the
 * seventh is not a default, it is a trap — and this one could only fire against real PostgREST,
 * which is why the unit suite stayed green.
 */
async function fetchByColumnIds<T>(
  table: string,
  column: string,
  ids: readonly string[],
  orderColumn = 'created_at',
): Promise<T[]> {
  if (!ids.length) return [];
  return fetchInChunks(ids, (chunk) => fetchAll<T>((from, to) => supabase
    .from(table)
    .select(ALL_COLUMNS)
    .in(column, chunk)
    .order(orderColumn, { ascending: false })
    .order('id', { ascending: false })
    .range(from, to)));
}

async function fetchJobs(documentIds: readonly string[] | null): Promise<DocumentProcessingJob[]> {
  if (documentIds?.length === 0) return [];
  const fetchStatuses = (ids: readonly string[] | null) => fetchAll<DocumentProcessingJob>((from, to) => supabase
    .rpc('get_document_processing_statuses', { p_document_ids: ids })
    .range(from, to));
  try {
    return documentIds
      ? await fetchInChunks(documentIds, (chunk) => fetchStatuses(chunk))
      : await fetchStatuses(null);
  } catch (error) {
    // During a forward-only rollout the frontend can briefly reach a database that has the smart
    // document tables but not 0130's health RPC yet. Preserve the real pipeline state in that
    // window; rendering every existing job as "unprocessed" would be a false and dangerous claim.
    if (!documentProcessingStatusRpcMissing(error)) throw error;
    const fetchLegacy = (ids: readonly string[] | null) => fetchAll<DocumentProcessingJob>((from, to) => {
      let query = supabase.from('document_processing_jobs').select(ALL_COLUMNS);
      if (ids) query = query.in('document_id', ids);
      return query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to);
    });
    return documentIds
      ? fetchInChunks(documentIds, (chunk) => fetchLegacy(chunk))
      : fetchLegacy(null);
  }
}

async function fetchRowsByIds<T>(table: string, ids: readonly string[]): Promise<T[]> {
  return fetchByColumnIds<T>(table, 'id', ids);
}

/**
 * Same lookup AuditLog.tsx:38-40 already uses to turn actor uuids into names, narrowed to the two
 * columns needed so the other identity columns on `profiles` stay unread. Deliberately does not
 * throw: these names annotate data the caller already has, so a blocked or partial read must
 * degrade to — rather than fail the whole review screen.
 */
async function fetchActorNames(actorIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(actorIds)];
  if (!unique.length) return new Map();
  const rows = await fetchInChunks(unique, async (chunk) => {
    const { data } = await supabase.from('profiles').select('id, full_name').in('id', chunk);
    return (data ?? []) as { id: string; full_name: string }[];
  });
  return new Map(rows.map((row) => [row.id, row.full_name]));
}

/**
 * True when the smart-document schema is not installed on this database.
 *
 * Migrations 0045-0050 ship separately from this bundle, so the app can legitimately run against
 * a database without them. That is not an error worth showing anybody: the documents screen
 * worked before the epic existed and must keep working, simply without processing state.
 * Matched on the message because fetchAll surfaces only that, not the PostgREST code.
 */
function smartDocumentsNotInstalled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /could not find the table .*document_(processing|extractions|interpretations)/i.test(message)
    || /relation "?(public\.)?document_processing_jobs"? does not exist/i.test(message);
}

function documentProcessingStatusRpcMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /PGRST202/i.test(message)
    || /could not find the function .*get_document_processing_statuses/i.test(message)
    || /function .*get_document_processing_statuses.*does not exist/i.test(message);
}

async function loadProcessing(
  documentIds: readonly string[] | null,
  details: boolean,
): Promise<Record<string, DocumentProcessingSnapshot>> {
  let jobs: DocumentProcessingJob[];
  try {
    jobs = await fetchJobs(documentIds);
  } catch (error) {
    if (!smartDocumentsNotInstalled(error)) throw error;
    // Every document reports as unprocessed, which is exactly what it is here.
    return Object.fromEntries((documentIds ?? []).map((id) => [id, createSnapshot(id)]));
  }
  const ids = documentIds ?? [...new Set(jobs.map((job) => job.document_id))];
  const snapshots = Object.fromEntries(ids.map((id) => [id, createSnapshot(id)]));

  for (const job of jobs) {
    const snapshot = snapshots[job.document_id] ??= createSnapshot(job.document_id);
    snapshot.jobs.push(job);
    if (!snapshot.job) {
      snapshot.job = job;
      snapshot.stage = documentProcessingStage(job.status);
    }
  }

  if (!details || ids.length === 0) return snapshots;

  // Reprocessing preserves old attempts. Resolve the current job first so review layers
  // can never combine evidence or decisions from different attempts of one document.
  const currentJobIds = Object.values(snapshots).flatMap((snapshot) => snapshot.job ? [snapshot.job.id] : []);
  const [documents, extractions, interpretations] = await Promise.all([
    fetchInChunks(ids, (chunk) => fetchAll<DocumentRow>((from, to) => supabase
      .from('documents').select(ALL_COLUMNS).in('id', chunk).is('deleted_at', null)
      .order('created_at', { ascending: false }).order('id').range(from, to))),
    fetchByColumnIds<DocumentExtraction>('document_extractions', 'job_id', currentJobIds),
    fetchByColumnIds<DocumentInterpretation>('document_interpretations', 'job_id', currentJobIds),
  ]);

  for (const document of documents) snapshots[document.id].document = document;
  for (const extraction of extractions) {
    const snapshot = snapshots[extraction.document_id];
    if (snapshot?.job?.id !== extraction.job_id) continue;
    snapshot.extractions.push(extraction);
    snapshot.extraction ??= extraction;
  }
  for (const interpretation of interpretations) {
    const snapshot = snapshots[interpretation.document_id];
    if (snapshot?.job?.id !== interpretation.job_id) continue;
    snapshot.interpretations.push(interpretation);
    snapshot.interpretation ??= interpretation;
  }

  const currentInterpretationIds = Object.values(snapshots)
    .flatMap((snapshot) => snapshot.interpretation ? [snapshot.interpretation.id] : []);
  const [annotations, ruleApplications, reviewCorrections, typeReviewDecisions, filings,
    priceListDecisions, priceListLines, priceListPredictions,
    feedback, exports, exportTemplates, packets] = await Promise.all([
    fetchByColumnIds<DocumentAnnotation>('document_annotations', 'interpretation_id', currentInterpretationIds),
    fetchByColumnIds<DocumentRuleApplication>('document_rule_applications', 'interpretation_id', currentInterpretationIds),
    fetchByColumnIds<DocumentReviewCorrection>('document_review_corrections', 'interpretation_id', currentInterpretationIds),
    fetchByColumnIds<DocumentTypeReviewDecision>('document_type_review_decisions', 'interpretation_id', currentInterpretationIds),
    // decided_at, not created_at — the table has no created_at, and ordering by one 400s.
    fetchByColumnIds<DocumentFiling>('document_filings', 'interpretation_id', currentInterpretationIds, 'decided_at'),
    fetchByColumnIds<PriceListInterpretationDecision>(
      'price_list_interpretation_decisions', 'interpretation_id', currentInterpretationIds,
    ),
    fetchByColumnIds<PriceListInterpretationLine>(
      'price_list_interpretation_lines', 'interpretation_id', currentInterpretationIds,
    ),
    // Convenience data, so it fails soft. A role without 0096's select policy, or a database that
    // predates the table, must cost the reviewer a prefill — never the review screen itself.
    fetchByColumnIds<PriceListPredictedLine>(
      'price_list_shadow_lines', 'interpretation_id', currentInterpretationIds,
    ).catch(() => []),
    fetchByColumnIds<DocumentFeedback>('document_feedback', 'interpretation_id', currentInterpretationIds),
    fetchByColumnIds<DocumentExportRow>('document_exports', 'interpretation_id', currentInterpretationIds),
    fetchAll<DocumentExportTemplateRow>((from, to) => supabase
      .from('document_export_templates').select(ALL_COLUMNS).eq('active', true)
      .order('created_at', { ascending: false }).order('id').range(from, to)),
    fetchByColumnIds<DocumentPacket>('document_packets', 'source_interpretation_id', currentInterpretationIds, 'updated_at'),
  ]);

  const [learningRules, exportTemplateVersions, actorNames, packetSegments] = await Promise.all([
    fetchRowsByIds<DocumentLearningRule>(
      'document_learning_rules',
      [...new Set(ruleApplications.map((application) => application.rule_id))],
    ),
    fetchRowsByIds<DocumentExportTemplateVersion>(
      'document_export_template_versions',
      exportTemplates.flatMap((template) => template.active_version_id ? [template.active_version_id] : []),
    ),
    fetchActorNames([
      ...reviewCorrections.map((correction) => correction.actor_id),
      ...typeReviewDecisions.map((decision) => decision.actor_id),
      ...feedback.map((item) => item.actor_id),
    ]),
    fetchByColumnIds<DocumentPacketSegment>('document_packet_segments', 'packet_id', packets.map((packet) => packet.id)),
  ]);

  for (const annotation of annotations) {
    const snapshot = snapshots[annotation.document_id];
    if (snapshot?.interpretation?.id === annotation.interpretation_id) snapshot.annotations.push(annotation);
  }
  for (const application of ruleApplications) {
    const snapshot = snapshots[application.document_id];
    if (snapshot?.interpretation?.id === application.interpretation_id) snapshot.ruleApplications.push(application);
  }
  for (const correction of reviewCorrections) {
    const snapshot = snapshots[correction.document_id];
    if (snapshot?.interpretation?.id === correction.interpretation_id) snapshot.reviewCorrections.push(correction);
  }
  for (const decision of typeReviewDecisions) {
    const snapshot = snapshots[decision.document_id];
    if (snapshot?.interpretation?.id === decision.interpretation_id) snapshot.typeReviewDecisions.push(decision);
  }
  for (const filing of filings) {
    const snapshot = snapshots[filing.document_id];
    if (snapshot?.interpretation?.id === filing.interpretation_id) snapshot.filings.push(filing);
  }
  for (const decision of priceListDecisions) {
    const snapshot = snapshots[decision.document_id];
    if (snapshot?.interpretation?.id === decision.interpretation_id) {
      snapshot.priceListDecision ??= decision;
    }
  }
  for (const line of priceListLines) {
    const snapshot = snapshots[line.document_id];
    if (snapshot?.interpretation?.id === line.interpretation_id) {
      snapshot.priceListLines.push(line);
    }
  }
  for (const line of priceListPredictions) {
    const snapshot = snapshots[line.document_id];
    if (snapshot?.interpretation?.id === line.interpretation_id) {
      snapshot.priceListPredictions.push(line);
    }
  }
  const annotationById = new Map(annotations.map((annotation) => [annotation.id, annotation]));
  for (const item of feedback) {
    const annotation = annotationById.get(item.annotation_id);
    if (!annotation) continue;
    const snapshot = snapshots[annotation.document_id];
    if (snapshot?.interpretation?.id === item.interpretation_id) snapshot.feedback.push(item);
  }
  for (const item of exports) {
    const snapshot = snapshots[item.document_id];
    if (snapshot?.interpretation?.id === item.interpretation_id) snapshot.exports.push(item);
  }
  for (const packet of packets) {
    const snapshot = snapshots[packet.parent_document_id];
    if (snapshot?.interpretation?.id === packet.source_interpretation_id) snapshot.packet ??= packet;
  }
  for (const segment of packetSegments) {
    const packet = packets.find((candidate) => candidate.id === segment.packet_id);
    if (!packet) continue;
    const snapshot = snapshots[packet.parent_document_id];
    if (snapshot?.packet?.id === packet.id) snapshot.packetSegments.push(segment);
  }

  for (const snapshot of Object.values(snapshots)) {
    const ruleIds = new Set(snapshot.ruleApplications.map((application) => application.rule_id));
    snapshot.learningRules = learningRules.filter((rule) => ruleIds.has(rule.id));
    snapshot.actorNames = actorNames;
    snapshot.exportTemplates = snapshot.interpretation ? exportTemplates : [];
    const templateIds = new Set(snapshot.exportTemplates.map((template) => template.id));
    snapshot.exportTemplateVersions = exportTemplateVersions.filter((version) => templateIds.has(version.template_id));
    snapshot.packetSegments.sort((left, right) => left.ordinal - right.ordinal);
  }

  return snapshots;
}

export function useDocumentProcessing(
  documentIds?: readonly string[],
  { details = false }: { details?: boolean } = {},
) {
  const idsKey = documentIds ? [...new Set(documentIds)].sort().join(',') : '*';
  const normalizedIds = useMemo(
    () => idsKey === '*' ? null : idsKey ? idsKey.split(',') : [],
    [idsKey],
  );
  const query = useQuery(
    () => loadProcessing(normalizedIds, details),
    [idsKey, details],
  );
  const enabled = normalizedIds === null || normalizedIds.length > 0;

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => { void query.refetch(); };
    const interval = window.setInterval(refresh, 10_000);
    window.addEventListener('focus', refresh);
    window.addEventListener(DOCUMENT_PROCESSING_CHANGED_EVENT, refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(DOCUMENT_PROCESSING_CHANGED_EVENT, refresh);
    };
  }, [enabled, query.refetch]);

  return { ...query, snapshots: query.data ?? {} };
}

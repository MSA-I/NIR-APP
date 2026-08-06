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
 * The ENGINEERING labels. They stay, because the seven stages stay: the database contract, the
 * SQL suites and the browser scenarios all measure them, and a reviewer standing in front of a
 * stuck job needs to know *which* step stopped. What changed is who reads them — see
 * DOCUMENT_USER_STATE_META below for what a kitchen manager sees on the documents folder.
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
  review: { label: 'דורש בדיקה', tone: 'await' },
  completed: { label: 'הושלם', tone: 'done' },
  failed: { label: 'נכשל', tone: 'alert' },
};

/**
 * What a person sees. The users are a kitchen manager, an office clerk and a business owner: they
 * do not know what "חילוץ" is, what "פירוש" is, or why a document would be "ממתין לפירוש". Seven
 * pipeline stages on a status badge described the machine's internal position in a queue — which
 * is information about us, not about their document.
 *
 * Four states, and each answers the only question the reader actually has: is anything required
 * of me? נקלט — no, wait. בבדיקה — yes, look at it. שויך — no, it landed. לא נקרא — yes, file it
 * by hand.
 *
 * The seven stages are NOT replaced. They keep flowing through `DocumentProcessingSnapshot.stage`,
 * through `data-stage` on the badge, and through every suite that measures them.
 */
export type DocumentUserState = 'intake' | 'review' | 'completed' | 'failed';

export const DOCUMENT_USER_STATE_META: Record<
  DocumentUserState,
  { label: string; tone: DocumentStageTone }
> = {
  intake: { label: 'נקלט', tone: 'info' },
  review: { label: 'בבדיקה', tone: 'await' },
  completed: { label: 'שויך', tone: 'done' },
  failed: { label: 'לא נקרא', tone: 'alert' },
};

const STAGE_USER_STATE: Record<DocumentProcessingStage, DocumentUserState> = {
  unprocessed: 'intake',
  queued: 'intake',
  processing: 'intake',
  extracted: 'intake',
  review: 'review',
  completed: 'completed',
  failed: 'failed',
};

/**
 * One sentence per stage rather than per state, for one reason: `unprocessed` means nothing was
 * ever sent to be read. It shares the "נקלט" label honestly — the document IS in the system — but
 * "המערכת קוראת את המסמך" would be a claim about work that is not running. A status badge may
 * simplify; it may not say something untrue.
 */
const STAGE_USER_DESCRIPTION: Record<DocumentProcessingStage, string> = {
  unprocessed: 'המסמך נשמר במערכת וטרם נשלח לקריאה',
  queued: 'המערכת קוראת את המסמך',
  processing: 'המערכת קוראת את המסמך',
  extracted: 'המערכת קוראת את המסמך',
  review: 'ממתין לאישורך',
  completed: 'המערכת סיימה לקרוא את המסמך',
  failed: 'לא הצלחנו לקרוא את המסמך. אפשר לשייך ידנית.',
};

export function documentUserState(stage: DocumentProcessingStage): DocumentUserState {
  return STAGE_USER_STATE[stage];
}

export function documentUserStateDescription(stage: DocumentProcessingStage): string {
  return STAGE_USER_DESCRIPTION[stage];
}

export const DOCUMENT_USER_STATE_FILTERS: ReadonlyArray<{ value: DocumentUserState; label: string }> =
  (Object.entries(DOCUMENT_USER_STATE_META) as Array<[DocumentUserState, { label: string }]>)
    .map(([value, { label }]) => ({ value, label }));

/**
 * The `processing` query parameter survives navigation, and it used to carry one of the seven
 * engineering stages. An old link, a bookmark or a Back button still holds `?processing=extracted`,
 * and the honest reading of it is the state that CONTAINS that stage — a superset, so a link that
 * matched rows before never lands on an unexplained empty list. Anything unrecognised filters
 * nothing at all, exactly as it did before.
 */
export function documentUserStateFromParam(value: string | null): DocumentUserState | null {
  if (!value) return null;
  if (value in DOCUMENT_USER_STATE_META) return value as DocumentUserState;
  if (value in STAGE_USER_STATE) return STAGE_USER_STATE[value as DocumentProcessingStage];
  return null;
}

/**
 * `completed` is a fact about the JOB, not about the filing — today the only path to it is a
 * confirmed price list (0048:1744), which leaves the document sitting in the inbox. So the badge
 * names the destination when the row has one, and refuses the word "שויך" when it does not: the
 * filing column on the same row would be saying "לא משויך" beside it, and a screen that
 * contradicts itself teaches people to distrust all of it.
 *
 * Naming the destination costs nothing here — `entity_type` is already on the row. Naming the
 * document AT the destination ("חשבונית 1042") would cost a second, polymorphic lookup:
 * `entity_id` has no foreign key, so PostgREST cannot embed it, and it would take one extra query
 * per target table on every gallery load. Not worth a more specific word.
 */
export function documentUserStateLabel(
  stage: DocumentProcessingStage,
  doc?: Pick<DocumentRow, 'entity_type' | 'entity_id'> | null,
): string {
  const state = documentUserState(stage);
  if (state !== 'completed' || !doc) return DOCUMENT_USER_STATE_META[state].label;
  // 'inbox' is not-yet-filed and 'archive' is decided-to-have-no-target (types.ts:250). Neither
  // is a destination, and both carry a null entity_id.
  if (doc.entity_id === null || doc.entity_type === 'inbox' || doc.entity_type === 'archive') return 'נקרא';
  if (doc.entity_type === 'invoice') return 'שויך לחשבונית';
  if (doc.entity_type === 'goods_receipt') return 'שויך לקבלת סחורה';
  return DOCUMENT_USER_STATE_META.completed.label;
}

export type InterpretationContract = {
  schema_version: '1';
  document_type:
    | 'invoice'
    | 'delivery_note'
    | 'credit_note'
    | 'price_list'
    | 'quote'
    | 'payment_confirmation'
    | 'other';
  document_type_confidence: number | null;
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
  feedback: DocumentFeedback[];
  exportTemplates: DocumentExportTemplateRow[];
  exportTemplateVersions: DocumentExportTemplateVersion[];
  exports: DocumentExportRow[];
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
    feedback: [],
    exportTemplates: [],
    exportTemplateVersions: [],
    exports: [],
    actorNames: new Map(),
  };
}

async function fetchByColumnIds<T>(
  table: string,
  column: string,
  ids: readonly string[],
): Promise<T[]> {
  if (!ids.length) return [];
  return fetchInChunks(ids, (chunk) => fetchAll<T>((from, to) => supabase
    .from(table)
    .select(ALL_COLUMNS)
    .in(column, chunk)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to)));
}

async function fetchByDocumentIds<T>(table: string, documentIds: readonly string[]): Promise<T[]> {
  return fetchByColumnIds<T>(table, 'document_id', documentIds);
}

async function fetchJobs(documentIds: readonly string[] | null): Promise<DocumentProcessingJob[]> {
  if (documentIds?.length === 0) return [];
  if (documentIds) return fetchByDocumentIds<DocumentProcessingJob>('document_processing_jobs', documentIds);
  return fetchAll<DocumentProcessingJob>((from, to) => supabase
    .from('document_processing_jobs')
    .select(ALL_COLUMNS)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to));
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
  const [annotations, ruleApplications, reviewCorrections, typeReviewDecisions, feedback,
    exports, exportTemplates] = await Promise.all([
    fetchByColumnIds<DocumentAnnotation>('document_annotations', 'interpretation_id', currentInterpretationIds),
    fetchByColumnIds<DocumentRuleApplication>('document_rule_applications', 'interpretation_id', currentInterpretationIds),
    fetchByColumnIds<DocumentReviewCorrection>('document_review_corrections', 'interpretation_id', currentInterpretationIds),
    fetchByColumnIds<DocumentTypeReviewDecision>('document_type_review_decisions', 'interpretation_id', currentInterpretationIds),
    fetchByColumnIds<DocumentFeedback>('document_feedback', 'interpretation_id', currentInterpretationIds),
    fetchByColumnIds<DocumentExportRow>('document_exports', 'interpretation_id', currentInterpretationIds),
    fetchAll<DocumentExportTemplateRow>((from, to) => supabase
      .from('document_export_templates').select(ALL_COLUMNS).eq('active', true)
      .order('created_at', { ascending: false }).order('id').range(from, to)),
  ]);

  const [learningRules, exportTemplateVersions, actorNames] = await Promise.all([
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

  for (const snapshot of Object.values(snapshots)) {
    const ruleIds = new Set(snapshot.ruleApplications.map((application) => application.rule_id));
    snapshot.learningRules = learningRules.filter((rule) => ruleIds.has(rule.id));
    snapshot.actorNames = actorNames;
    snapshot.exportTemplates = snapshot.interpretation ? exportTemplates : [];
    const templateIds = new Set(snapshot.exportTemplates.map((template) => template.id));
    snapshot.exportTemplateVersions = exportTemplateVersions.filter((version) => templateIds.has(version.template_id));
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

import { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, Eye, History, RefreshCw, RotateCcw } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import {
  ConfirmDialog,
  DataTable,
  ErrorNote,
  KpiCard,
  Modal,
  Note,
  SkeletonCards,
  SkeletonTable,
  StatusBadge,
  useToast,
  type Column,
} from '../components/ui';
import { ok, toHebrewError } from '../lib/errors';
import { fmtDateTime, fmtMoneyRounded, fmtNum } from '../lib/format';
import { DOCUMENT_PROCESSING_CHANGED_EVENT } from '../lib/useDocumentProcessing';
import { supabase } from '../lib/supabase';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { useQuery, unwrap } from '../lib/useQuery';
import {
  attemptStatusMeta,
  calibrationReviewRpcName,
  normalizeIncorrectCalibration,
  type CalibrationAction,
} from './documentOperationsModel';

interface DocumentOperationsMetrics {
  window_days: number;
  documents_waiting: number;
  documents_processing: number;
  documents_completed: number;
  documents_review_required: number;
  documents_failed: number;
  oldest_queue_age_seconds: number | null;
  retry_count: number;
  average_processing_duration_ms: number | null;
  last_failure: { code: string | null; message: string | null; at: string } | null;
  last_interpretation: {
    provider: string;
    model: string;
    prompt_version: string;
    schema_version: string;
    at: string;
  } | null;
  usage: {
    input_tokens: number | null;
    cached_input_tokens: number | null;
    output_tokens: number | null;
    cost: number | null;
  };
  automatically_classified: number;
  automatically_applied_documents: number;
  reprocessed_documents: number;
  price_list_results: {
    automatically_applied: number;
    partially_applied: number;
    review_required: number;
    reverted: number;
  };
  last_processing_at: string | null;
}

interface CalibrationBreakdown {
  interpreted_rows: number;
  reviewed_rows: number;
  human_corrected_rows: number;
  accuracy: number | null;
}

interface SupplierCalibration extends CalibrationBreakdown { supplier_id: string | null }
interface FormatCalibration extends CalibrationBreakdown { document_format: string }
interface VersionCalibration extends CalibrationBreakdown {
  provider: string;
  model: string;
  prompt_version: string;
}

interface CalibrationMetrics {
  target_document_count: number;
  reviewed_document_count: number;
  fully_reviewed_document_count: number;
  remaining_fully_reviewed_documents: number;
  total_interpreted_rows: number;
  predicted_applicable_rows: number;
  automatically_applied_rows: number;
  reviewed_rows: number;
  human_corrected_rows: number;
  incorrect_product_matches: number;
  incorrect_new_products: number;
  incorrect_prices: number;
  ambiguous_rows: number;
  policy_rejected_rows: number;
  accuracy: number | null;
  confidence_distribution: { p10: number | null; p50: number | null; p90: number | null };
  by_supplier: SupplierCalibration[];
  by_document_format: FormatCalibration[];
  by_interpretation_version: VersionCalibration[];
}

interface CalibrationQueueRow {
  shadow_run_id: string;
  shadow_line_id: string | null;
  document_id: string;
  file_name: string;
  supplier_id: string | null;
  supplier_name: string | null;
  decision_confidence: number | null;
  line_index: number;
  source_row: number | null;
  predicted_action: CalibrationAction;
  reason_code: string | null;
  matched_by: string | null;
  product_id: string | null;
  matched_product_name: string | null;
  sku: string | null;
  barcode: string | null;
  product_name: string | null;
  unit: string | null;
  proposed_unit_price: number | null;
  current_unit_price: number | null;
  price_change_percent: number | null;
  document_line_count: number;
  document_reviewed_count: number;
  is_empty_run: boolean;
}

interface ProductOption { id: string; name: string; sku: string | null; barcode: string | null }
type CalibrationVerdict = 'correct' | 'incorrect' | 'ambiguous' | 'rejected_by_policy';

interface DriftGroup {
  supplier_id: string | null;
  document_format: string;
  provider: string;
  model: string;
  prompt_version: string;
  extraction_engine: string;
  extraction_model: string;
  extraction_model_version: string;
  current_run_count: number;
  prior_run_count: number;
  current_rows: number;
  prior_rows: number;
  current_unmatched_rate: number | null;
  prior_unmatched_rate: number | null;
  unmatched_rate_delta: number | null;
  current_created_product_rate: number | null;
  prior_created_product_rate: number | null;
  created_product_rate_delta: number | null;
  current_mean_confidence: number | null;
  prior_mean_confidence: number | null;
  mean_confidence_delta: number | null;
  absolute_price_change_p90: number | null;
  absolute_price_change_max: number | null;
  new_layout_count: number | null;
  layout_change_detected: boolean | null;
}

interface DriftMetrics {
  window_days: number;
  current_window_started_at: string;
  prior_window_started_at: string;
  measured_at: string;
  groups: DriftGroup[];
}

interface ProcessingAttempt {
  job_id: string;
  document_id: string;
  previous_job_id: string | null;
  status: string;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  queue_age_seconds: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  extraction_id: string | null;
  extraction_engine: string | null;
  extraction_model: string | null;
  extraction_model_version: string | null;
  extraction_duration_ms: number | null;
  interpretation_id: string | null;
  provider: string | null;
  interpretation_model: string | null;
  prompt_version: string | null;
  schema_version: string | null;
  interpretation_duration_ms: number | null;
  document_type: string | null;
  document_type_confidence: number | null;
  supplier_confidence: number | null;
  usage: Record<string, unknown> | null;
  usage_cost: number | null;
  price_list_outcome: string | null;
  price_list_reason_code: string | null;
  price_list_applied_count: number | null;
  price_list_waiting_count: number | null;
}

interface AttemptRow extends ProcessingAttempt {
  id: string;
  file_name: string | null;
  reversal_known: boolean;
  reverted: boolean | null;
}

interface SupplierName { id: string; name: string }

type AttemptFilter = 'all' | 'attention' | 'processing' | 'completed';

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  price_list: 'מחירון',
  invoice: 'חשבונית',
  delivery_note: 'תעודת משלוח',
  receipt: 'קבלה',
  payment_confirmation: 'אישור תשלום',
  tax_receipt: 'קבלה',
  credit_note: 'תעודת זיכוי',
};

const PRICE_OUTCOME_LABEL: Record<string, string> = {
  auto_applied: 'הוחל אוטומטית',
  partially_applied: 'הוחל חלקית',
  queued_for_review: 'ממתין לבדיקה',
  rejected: 'נדחה לפי מדיניות',
};

const PREDICTED_ACTION_LABEL: Record<CalibrationQueueRow['predicted_action'], string> = {
  apply_existing_price: 'עדכון מחיר למוצר קיים',
  create_product: 'יצירת מוצר חדש',
  review: 'העברה לבדיקה',
  rejected_by_policy: 'דחייה לפי מדיניות',
};

function fmtRate(value: number | null | undefined) {
  return value == null ? '—' : `${fmtNum(value * 100)}%`;
}

function fmtDelta(value: number | null | undefined) {
  if (value == null) return '—';
  const points = value * 100;
  return `${points > 0 ? '+' : ''}${fmtNum(points)} נק׳ אחוז`;
}

function fmtPriceChange(value: number | null | undefined) {
  return value == null ? '—' : `${fmtNum(value)}%`;
}

function fmtDuration(ms: number | null | undefined) {
  if (ms == null) return '—';
  if (ms < 1000) return `${fmtNum(ms)} מ״ש`;
  if (ms < 60_000) return `${fmtNum(ms / 1000)} שנ׳`;
  return `${fmtNum(ms / 60_000)} דק׳`;
}

function fmtAge(seconds: number | null | undefined) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${fmtNum(seconds)} שנ׳`;
  if (seconds < 3600) return `${fmtNum(seconds / 60)} דק׳`;
  if (seconds < 86_400) return `${fmtNum(seconds / 3600)} שע׳`;
  return `${fmtNum(seconds / 86_400)} ימים`;
}

function documentFormatLabel(value: string) {
  if (value === 'application/pdf') return 'PDF';
  if (value.startsWith('image/')) return 'תמונה';
  if (value.includes('spreadsheet') || value.includes('excel')) return 'גיליון נתונים';
  return 'פורמט אחר';
}

function attemptFilterKey(attempt: AttemptRow): Exclude<AttemptFilter, 'all'> {
  const meta = attemptStatusMeta(attempt);
  if (meta.tone === 'alert' || meta.tone === 'await') return 'attention';
  if (meta.tone === 'info') return 'processing';
  return 'completed';
}

function attemptResult(attempt: AttemptRow) {
  if (attempt.reversal_known && attempt.reverted) return 'בוטל לאחר החלה';
  if (attempt.price_list_outcome) return PRICE_OUTCOME_LABEL[attempt.price_list_outcome] ?? 'תוצאת מחירון זמינה בפרטים';
  if (attempt.document_type) return DOCUMENT_TYPE_LABEL[attempt.document_type] ?? 'סוג מסמך זוהה';
  return '—';
}

function isActiveAttempt(attempt: AttemptRow) {
  return ['queued', 'leased', 'extracted', 'interpreting'].includes(attempt.status);
}

function newestAttempts(attempts: AttemptRow[]) {
  const seen = new Set<string>();
  return attempts.filter((attempt) => {
    if (seen.has(attempt.document_id)) return false;
    seen.add(attempt.document_id);
    return true;
  });
}

export default function DocumentOperations() {
  const { organizationAccess } = useAuth();
  const canWrite = organizationAccess?.canWrite ?? true;
  const navigate = useNavigate();
  const toast = useToast();
  const [windowDays, setWindowDays] = useState(30);
  const [filter, setFilter] = useState<AttemptFilter>('all');
  const [historyDocumentId, setHistoryDocumentId] = useState<string | null>(null);
  const [reprocessTarget, setReprocessTarget] = useState<AttemptRow | null>(null);
  const [reprocessing, setReprocessing] = useState(false);
  const [calibrationTarget, setCalibrationTarget] = useState<CalibrationQueueRow | null>(null);

  const operations = useQuery<DocumentOperationsMetrics>(async () =>
    unwrap(await supabase.rpc('get_document_operations_metrics', { p_window_days: windowDays })) as DocumentOperationsMetrics,
  [windowDays]);

  const calibration = useQuery<CalibrationMetrics>(async () =>
    unwrap(await supabase.rpc('get_price_list_calibration_metrics', { p_from: null, p_to: null })) as CalibrationMetrics);

  const calibrationQueue = useQuery<CalibrationQueueRow[]>(async () =>
    unwrap(await supabase.rpc('get_price_list_calibration_queue', { p_document_limit: 50 })) as CalibrationQueueRow[]);

  const drift = useQuery<DriftMetrics>(async () =>
    unwrap(await supabase.rpc('get_price_list_drift_metrics', { p_window_days: windowDays })) as DriftMetrics,
  [windowDays]);

  const suppliers = useQuery<SupplierName[]>(async () =>
    fetchAll<SupplierName>((from, to) => supabase.from('suppliers').select('id, name')
      .order('name').order('id').range(from, to)));

  const attempts = useQuery<AttemptRow[]>(async () => {
    const raw = unwrap(await supabase.rpc('get_document_processing_attempts', {
      p_document_id: null,
      p_limit: 100,
    })) as ProcessingAttempt[];
    const documentIds = [...new Set(raw.map((attempt) => attempt.document_id))];
    const interpretationIds = [...new Set(raw.map((attempt) => attempt.interpretation_id).filter((id): id is string => !!id))];
    const docs = documentIds.length
      ? await fetchInChunks(documentIds, (ids) => fetchAll<{ id: string; file_name: string }>((from, to) => supabase
        .from('documents').select('id, file_name').in('id', ids).order('id').range(from, to)))
      : [];
    const [priceDecisions, autoActions] = interpretationIds.length ? await Promise.all([
      fetchInChunks(interpretationIds, (ids) => fetchAll<{ interpretation_id: string; reverted_at: string | null }>((from, to) => supabase
        .from('price_list_interpretation_decisions').select('interpretation_id, reverted_at')
        .in('interpretation_id', ids).order('interpretation_id').range(from, to))),
      fetchInChunks(interpretationIds, (ids) => fetchAll<{ interpretation_id: string; reverted_at: string | null }>((from, to) => supabase
        .from('document_auto_actions').select('interpretation_id, reverted_at')
        .in('interpretation_id', ids).order('interpretation_id').range(from, to))),
    ]) : [[], []];
    const nameById = new Map(docs.map((doc) => [doc.id, doc.file_name]));
    const reversalByInterpretation = new Map(
      [...priceDecisions, ...autoActions].map((row) => [row.interpretation_id, row.reverted_at !== null]),
    );
    return raw.map((attempt) => ({
      ...attempt,
      id: attempt.job_id,
      file_name: nameById.get(attempt.document_id) ?? null,
      reversal_known: true,
      reverted: attempt.interpretation_id ? reversalByInterpretation.get(attempt.interpretation_id) ?? false : false,
    }));
  });

  const historyAttempts = useQuery<AttemptRow[]>(async () => {
    if (!historyDocumentId) return [];
    const raw = unwrap(await supabase.rpc('get_document_processing_attempts', {
      p_document_id: historyDocumentId,
      p_limit: 500,
    })) as ProcessingAttempt[];
    const interpretationIds = [...new Set(raw.map((attempt) => attempt.interpretation_id).filter((id): id is string => !!id))];
    const [document, priceDecisions, autoActions] = await Promise.all([
      supabase.from('documents').select('file_name').eq('id', historyDocumentId).single(),
      interpretationIds.length
        ? fetchInChunks(interpretationIds, (ids) => fetchAll<{ interpretation_id: string; reverted_at: string | null }>((from, to) => supabase
          .from('price_list_interpretation_decisions').select('interpretation_id, reverted_at')
          .in('interpretation_id', ids).order('interpretation_id').range(from, to)))
        : [],
      interpretationIds.length
        ? fetchInChunks(interpretationIds, (ids) => fetchAll<{ interpretation_id: string; reverted_at: string | null }>((from, to) => supabase
          .from('document_auto_actions').select('interpretation_id, reverted_at')
          .in('interpretation_id', ids).order('interpretation_id').range(from, to)))
        : [],
    ]);
    if (document.error) throw document.error;
    const reversalByInterpretation = new Map(
      [...priceDecisions, ...autoActions].map((row) => [row.interpretation_id, row.reverted_at !== null]),
    );
    return raw.map((attempt) => ({
      ...attempt,
      id: attempt.job_id,
      file_name: document.data.file_name,
      reversal_known: true,
      reverted: attempt.interpretation_id ? reversalByInterpretation.get(attempt.interpretation_id) ?? false : false,
    }));
  }, [historyDocumentId]);

  const supplierNames = useMemo(() => new Map((suppliers.data ?? []).map((supplier) => [supplier.id, supplier.name])), [suppliers.data]);
  const currentAttempts = useMemo(() => newestAttempts(attempts.data ?? []), [attempts.data]);
  const filteredAttempts = useMemo(() => currentAttempts.filter((attempt) =>
    filter === 'all' || attemptFilterKey(attempt) === filter), [currentAttempts, filter]);
  const selectedHistory = historyAttempts.data ?? [];

  async function refreshAll() {
    await Promise.all([
      operations.refetch(), attempts.refetch(), historyAttempts.refetch(), calibration.refetch(), drift.refetch(), suppliers.refetch(),
      calibrationQueue.refetch(),
    ]);
  }

  async function reprocess(reason?: string) {
    if (!canWrite || !reprocessTarget || !reason) return;
    setReprocessing(true);
    try {
      ok(await supabase.rpc('reprocess_document', {
        p_document_id: reprocessTarget.document_id,
        p_reason: reason,
      }));
      toast('המסמך הוחזר לתור העיבוד.');
      setReprocessTarget(null);
      setHistoryDocumentId(null);
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
      await Promise.all([operations.refetch(), attempts.refetch()]);
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setReprocessing(false);
    }
  }

  const attemptColumns: Column<AttemptRow>[] = [
    {
      key: 'document', header: 'מסמך', priority: 1, sortValue: (row) => row.file_name ?? row.document_id,
      render: (row) => <span className="font-medium text-ink">{row.file_name ?? 'מסמך ללא שם זמין'}</span>,
    },
    {
      key: 'status', header: 'מצב תפעולי', priority: 1,
      sortValue: (row) => attemptFilterKey(row), render: (row) => <StatusBadge meta={attemptStatusMeta(row)} />,
    },
    {
      key: 'updated', header: 'עדכון אחרון', priority: 2, sortValue: (row) => row.updated_at,
      render: (row) => <span className="num">{fmtDateTime(row.updated_at)}</span>,
    },
    {
      key: 'attempts', header: 'ניסיונות', className: 'num', priority: 2,
      sortValue: (row) => row.attempt_count, render: (row) => <span className="num">{fmtNum(row.attempt_count)}</span>,
    },
    {
      key: 'confidence', header: 'ביטחון בסוג', className: 'num', priority: 2,
      sortValue: (row) => row.document_type_confidence ?? -1,
      render: (row) => <span className="num">{fmtRate(row.document_type_confidence)}</span>,
    },
    { key: 'result', header: 'תוצאה', priority: 2, render: attemptResult },
  ];

  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">מרכז תפעול מסמכים</h1>
          <p className="mt-1 text-sm text-ink-soft">מצב תור העיבוד, ניסיונות קודמים ובקרת אוטומציה לבעלים.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-auto!" aria-label="טווח מדדי תפעול" value={windowDays}
            onChange={(event) => setWindowDays(Number(event.target.value))}>
            <option value={7}>7 ימים</option>
            <option value={30}>30 ימים</option>
            <option value={90}>90 ימים</option>
          </select>
          <button type="button" className="btn-secondary" onClick={() => void refreshAll()}
            disabled={operations.fetching || attempts.fetching || calibration.fetching || drift.fetching}
            aria-label="רענון מרכז תפעול מסמכים">
            <RefreshCw size={16} aria-hidden="true" /> רענון
          </button>
        </div>
      </header>

      <OperationsOverview query={operations} />

      <section aria-labelledby="document-attempts-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="document-attempts-title" className="section-title">מסמכים וניסיונות עיבוד</h2>
            <p className="mt-1 text-xs text-ink-muted">הרשימה מציגה עד 100 ניסיונות אחרונים; פתיחת שורה טוענת בנפרד עד 500 ניסיונות של אותו מסמך.</p>
          </div>
          {attempts.fetching && attempts.data && <span className="text-xs text-ink-muted" role="status">מעדכן ניסיונות…</span>}
        </div>
        {attempts.loading && !attempts.data ? <SkeletonTable title={false} cols={6} /> : (
          <DataTable rows={filteredAttempts} columns={attemptColumns} searchable pageSize={20}
            searchLabel="חיפוש מסמך במרכז התפעול"
            searchFn={(row, q) => (row.file_name ?? '').toLocaleLowerCase('he').includes(q)}
            error={attempts.error}
            activeFilters={filter === 'all' ? 0 : 1}
            onClearFilters={() => setFilter('all')}
            emptyTitle="אין מסמכים במצב שנבחר"
            emptySubtitle={filter === 'all' ? 'טרם נרשמו ניסיונות עיבוד.' : 'נקה את הסינון כדי לראות מצבים אחרים.'}
            toolbar={
              <select className="input w-auto!" aria-label="סינון מסמכים לפי מצב תפעולי" value={filter}
                onChange={(event) => setFilter(event.target.value as AttemptFilter)}>
                <option value="all">כל המצבים</option>
                <option value="attention">דורש טיפול</option>
                <option value="processing">בעיבוד</option>
                <option value="completed">הושלם</option>
              </select>
            }
            onRowClick={(row) => setHistoryDocumentId(row.document_id)}
            rowLabel={(row) => `מסמך ${row.file_name ?? 'ללא שם'}`}
            rowActions={(row) => [
              { key: 'history', label: 'ניסיונות קודמים', icon: History, onSelect: () => setHistoryDocumentId(row.document_id) },
              { key: 'review', label: 'פתיחת בדיקה', icon: Eye, hidden: !row.interpretation_id, onSelect: () => navigate(`/documents/${encodeURIComponent(row.document_id)}/review`) },
              { key: 'reprocess', label: row.status === 'failed' ? 'ניסיון נוסף' : 'עיבוד מחדש', icon: RotateCcw, hidden: !canWrite || isActiveAttempt(row), onSelect: () => setReprocessTarget(row) },
            ]}
          />
        )}
      </section>

      <CalibrationSection query={calibration} supplierNames={supplierNames} supplierNamesKnown={suppliers.data !== null} suppliersError={suppliers.error} />
      {canWrite
        ? <CalibrationQueueSection query={calibrationQueue} onReview={setCalibrationTarget} />
        : <Note tone="idle">קורפוס הכיול זמין לצפייה במדדים. רישום החלטות מושבת במצב קריאה בלבד.</Note>}
      <DriftSection query={drift} supplierNames={supplierNames} supplierNamesKnown={suppliers.data !== null} suppliersError={suppliers.error} />

      <AttemptHistoryModal attempts={selectedHistory} open={historyDocumentId !== null}
        loading={historyAttempts.loading} error={historyAttempts.error}
        onClose={() => setHistoryDocumentId(null)}
        onReview={(row) => navigate(`/documents/${encodeURIComponent(row.document_id)}/review`)}
        onReprocess={canWrite ? (row) => setReprocessTarget(row) : null} />

      <ConfirmDialog open={canWrite && reprocessTarget !== null} onClose={() => setReprocessTarget(null)}
        onConfirm={(reason) => void reprocess(reason)} requireReason busy={reprocessing}
        title="עיבוד המסמך מחדש"
        message={`המסמך ״${reprocessTarget?.file_name ?? 'ללא שם זמין'}״ יקבל ניסיון חדש. התוצאה הקודמת והראיות נשמרות, והסיבה נרשמת ביומן הביקורת.`}
        confirmLabel="החזרה לתור" />
      <CalibrationReviewModal row={canWrite ? calibrationTarget : null} onClose={() => setCalibrationTarget(null)}
        onSaved={async () => {
          setCalibrationTarget(null);
          await Promise.all([calibrationQueue.refetch(), calibration.refetch()]);
        }} />
    </div>
  );
}

function OperationsOverview({ query }: { query: ReturnType<typeof useQuery<DocumentOperationsMetrics>> }) {
  const metrics = query.data;
  return (
    <section aria-labelledby="document-operations-overview-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="document-operations-overview-title" className="section-title">מצב התפעול</h2>
        {query.fetching && metrics && <span className="text-xs text-ink-muted" role="status">מעדכן מדדים…</span>}
      </div>
      {query.loading && !metrics ? <SkeletonCards count={5} cols={5} /> : query.error && !metrics ? <ErrorNote message={query.error} /> : metrics && (
        <>
          {query.error && <ErrorNote message={query.error} />}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
            <KpiCard title="ממתינים" value={fmtNum(metrics.documents_waiting)} sub={metrics.documents_waiting > 0 ? `הוותיק ממתין ${fmtAge(metrics.oldest_queue_age_seconds)}` : 'אין מסמכים בתור'} tone={metrics.documents_waiting > 0 ? 'await' : 'idle'} />
            <KpiCard title="בעיבוד" value={fmtNum(metrics.documents_processing)} sub="עבודה פעילה עכשיו" tone={metrics.documents_processing > 0 ? 'info' : 'idle'} />
            <KpiCard title="נדרשת בדיקה" value={fmtNum(metrics.documents_review_required)} sub="ממתין להחלטה אנושית" tone={metrics.documents_review_required > 0 ? 'await' : 'idle'} />
            <KpiCard title="נכשלו" value={fmtNum(metrics.documents_failed)} sub="המצב הנוכחי לכל מסמך" tone={metrics.documents_failed > 0 ? 'alert' : 'idle'} />
            <KpiCard title="הושלמו" value={fmtNum(metrics.documents_completed)} sub="המצב הנוכחי לכל מסמך" tone="done" />
          </div>

          {metrics.last_failure && (
            <Note tone="alert">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>הכשל האחרון נרשם ב־<span className="num">{fmtDateTime(metrics.last_failure.at)}</span>. פתח את המסמך שנכשל לקבלת פרטים ולניסיון נוסף.</span>
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">פרטי כשל טכניים</summary>
                  <p className="mt-2 whitespace-pre-wrap" dir="auto">{metrics.last_failure.message ?? metrics.last_failure.code ?? 'לא נמסרו פרטים'}</p>
                </details>
              </div>
            </Note>
          )}

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="card card-pad">
              <h3 className="font-semibold text-ink">ביצועי עיבוד</h3>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <Metric label="משך ממוצע" value={fmtDuration(metrics.average_processing_duration_ms)} />
                <Metric label="ניסיונות חוזרים" value={fmtNum(metrics.retry_count)} />
                <Metric label="עובדו מחדש" value={fmtNum(metrics.reprocessed_documents)} />
                <Metric label="עיבוד אחרון" value={fmtDateTime(metrics.last_processing_at)} />
              </dl>
            </div>
            <div className="card card-pad">
              <h3 className="font-semibold text-ink">אוטומציה</h3>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <Metric label="סווגו אוטומטית" value={fmtNum(metrics.automatically_classified)} />
                <Metric label="הוחלו אוטומטית" value={fmtNum(metrics.automatically_applied_documents)} />
                <Metric label="מחירונים אוטומטיים" value={fmtNum(metrics.price_list_results.automatically_applied)} />
                <Metric label="מחירונים חלקיים" value={fmtNum(metrics.price_list_results.partially_applied)} />
                <Metric label="מחירונים לבדיקה" value={fmtNum(metrics.price_list_results.review_required)} />
                <Metric label="מחירונים שבוטלו" value={fmtNum(metrics.price_list_results.reverted)} />
              </dl>
            </div>
            <div className="card card-pad">
              <h3 className="font-semibold text-ink">שימוש מדווח</h3>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <Metric label="קלט" value={fmtNum(metrics.usage.input_tokens)} suffix="טוקנים" />
                <Metric label="קלט שמור" value={fmtNum(metrics.usage.cached_input_tokens)} suffix="טוקנים" />
                <Metric label="פלט" value={fmtNum(metrics.usage.output_tokens)} suffix="טוקנים" />
                <Metric label="עלות" value={fmtMoneyRounded(metrics.usage.cost)} />
              </dl>
              <p className="mt-3 text-xs text-ink-muted">עלות מוצגת רק כשהספק מדווח אותה; היעדר נתון נשאר <span className="num">—</span>.</p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function CalibrationSection({ query, supplierNames, supplierNamesKnown, suppliersError }: {
  query: ReturnType<typeof useQuery<CalibrationMetrics>>;
  supplierNames: Map<string, string>;
  supplierNamesKnown: boolean;
  suppliersError: string | null;
}) {
  const metrics = query.data;
  return (
    <section aria-labelledby="price-list-calibration-title" className="space-y-3">
      <div>
        <h2 id="price-list-calibration-title" className="section-title">כיול אוטומציית מחירונים</h2>
        <p className="mt-1 text-sm text-ink-soft">מדידה מול החלטות אנושיות. הנתונים אינם משנים ספים אוטומטית.</p>
      </div>
      {query.loading && !metrics ? <SkeletonCards count={5} cols={5} /> : query.error && !metrics ? <ErrorNote message={query.error} /> : metrics && (
        <>
          {query.error && <ErrorNote message={query.error} />}
          <div className="card card-pad">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold text-ink">קורפוס בדיקה אנושי</h3>
                <p className="text-sm text-ink-soft"><span className="num">{fmtNum(metrics.fully_reviewed_document_count)}</span> מתוך <span className="num">{fmtNum(metrics.target_document_count)}</span> מחירונים נבדקו במלואם.</p>
              </div>
              <span className="badge-info"><span className="num">{fmtNum(metrics.remaining_fully_reviewed_documents)}</span>&nbsp;נותרו</span>
            </div>
            <progress className="mt-3 h-2 w-full accent-action" max={metrics.target_document_count}
              value={Math.min(metrics.fully_reviewed_document_count, metrics.target_document_count)}
              aria-label="התקדמות קורפוס כיול מחירונים" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <KpiCard title="שורות מפוענחות" value={fmtNum(metrics.total_interpreted_rows)} />
            <KpiCard title="צפויות להחלה" value={fmtNum(metrics.predicted_applicable_rows)} />
            <KpiCard title="הוחלו אוטומטית" value={fmtNum(metrics.automatically_applied_rows)} />
            <KpiCard title="שורות שנבדקו" value={fmtNum(metrics.reviewed_rows)} />
            <KpiCard title="תוקנו בידי אדם" value={fmtNum(metrics.human_corrected_rows)} tone={metrics.human_corrected_rows > 0 ? 'await' : 'idle'} />
            <KpiCard title="דיוק בשורות שנבדקו" value={fmtRate(metrics.accuracy)} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="card card-pad">
              <h3 className="font-semibold text-ink">סוגי תיקון</h3>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <Metric label="התאמת מוצר שגויה" value={fmtNum(metrics.incorrect_product_matches)} />
                <Metric label="מוצר חדש שגוי" value={fmtNum(metrics.incorrect_new_products)} />
                <Metric label="מחיר שגוי" value={fmtNum(metrics.incorrect_prices)} />
                <Metric label="שורות עמומות" value={fmtNum(metrics.ambiguous_rows)} />
                <Metric label="נדחו לפי מדיניות" value={fmtNum(metrics.policy_rejected_rows)} />
              </dl>
            </div>
            <div className="card card-pad">
              <h3 className="font-semibold text-ink">התפלגות ביטחון</h3>
              <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
                <Metric label="אחוזון 10" value={fmtRate(metrics.confidence_distribution.p10)} />
                <Metric label="חציון" value={fmtRate(metrics.confidence_distribution.p50)} />
                <Metric label="אחוזון 90" value={fmtRate(metrics.confidence_distribution.p90)} />
              </dl>
            </div>
          </div>
          {suppliersError && <Note tone="idle">שמות ספקים אינם זמינים כרגע; המדדים עצמם נשארו מוצגים.</Note>}
          <CalibrationBreakdowns metrics={metrics} supplierNames={supplierNames} namesKnown={supplierNamesKnown} />
        </>
      )}
    </section>
  );
}

function CalibrationBreakdowns({ metrics, supplierNames, namesKnown }: {
  metrics: CalibrationMetrics;
  supplierNames: Map<string, string>;
  namesKnown: boolean;
}) {
  return (
    <details className="card card-pad">
      <summary className="cursor-pointer font-semibold text-ink">פירוט לפי ספק, פורמט וגרסת עיבוד</summary>
      <div className="mt-4 space-y-5">
        <BreakdownTable title="לפי ספק" rows={metrics.by_supplier.map((row) => ({
          key: row.supplier_id ?? 'none',
          label: row.supplier_id ? (supplierNames.get(row.supplier_id) ?? (namesKnown ? 'ספק לא זמין' : '—')) : 'ללא ספק מזוהה',
          ...row,
        }))} />
        <BreakdownTable title="לפי פורמט" rows={metrics.by_document_format.map((row) => ({
          key: row.document_format, label: documentFormatLabel(row.document_format), ...row,
        }))} />
        <BreakdownTable title="לפי גרסת עיבוד" rows={metrics.by_interpretation_version.map((row) => ({
          key: `${row.provider}/${row.model}/${row.prompt_version}`,
          label: `${row.provider} · ${row.model} · ${row.prompt_version}`,
          ...row,
        }))} />
      </div>
    </details>
  );
}

function BreakdownTable({ title, rows }: {
  title: string;
  rows: Array<CalibrationBreakdown & { key: string; label: string }>;
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-ink">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-ink-muted">אין עדיין נתונים לפירוט.</p> : (
        <div className="overflow-x-auto">
          <table className="data-table min-w-[620px]">
            <thead><tr><th>קבוצה</th><th className="num">שורות</th><th className="num">נבדקו</th><th className="num">תוקנו</th><th className="num">דיוק</th></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.key}><td>{row.label}</td><td className="num">{fmtNum(row.interpreted_rows)}</td><td className="num">{fmtNum(row.reviewed_rows)}</td><td className="num">{fmtNum(row.human_corrected_rows)}</td><td className="num">{fmtRate(row.accuracy)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CalibrationQueueSection({ query, onReview }: {
  query: ReturnType<typeof useQuery<CalibrationQueueRow[]>>;
  onReview: (row: CalibrationQueueRow) => void;
}) {
  const rows = (query.data ?? []).map((row) => ({ ...row, id: row.shadow_line_id ?? row.shadow_run_id }));
  const columns: Column<CalibrationQueueRow & { id: string }>[] = [
    {
      key: 'document', header: 'מחירון', priority: 1,
      render: (row) => <span><strong className="block text-ink">{row.file_name}</strong><span className="text-xs text-ink-muted">{row.supplier_name ?? 'ספק לא מזוהה'}</span></span>,
    },
    {
      key: 'line', header: 'שורה', className: 'num', priority: 2,
      render: (row) => row.is_empty_run ? <span>ללא שורות</span> : <span className="num">{fmtNum(row.source_row ?? row.line_index + 1)}</span>,
    },
    {
      key: 'identity', header: 'זיהוי שחושב', priority: 1,
      render: (row) => row.is_empty_run
        ? <span>הפענוח לא החזיר שורות מוצר</span>
        : <span>{row.matched_product_name ?? row.product_name ?? 'לא זוהה מוצר'}<span className="block text-xs text-ink-muted num">{row.sku ?? row.barcode ?? 'ללא SKU או ברקוד'}</span></span>,
    },
    {
      key: 'prediction', header: 'פעולה חזויה', priority: 1,
      render: (row) => PREDICTED_ACTION_LABEL[row.predicted_action],
    },
    {
      key: 'price', header: 'מחיר נוכחי ← חזוי', className: 'num', priority: 2,
      render: (row) => <span className="num">{fmtMoneyRounded(row.current_unit_price)} ← {fmtMoneyRounded(row.proposed_unit_price)}</span>,
    },
    {
      key: 'progress', header: 'בדיקת המסמך', className: 'num', priority: 2,
      render: (row) => row.is_empty_run ? <span>נדרשת הכרעת מסמך</span> : <span className="num">{fmtNum(row.document_reviewed_count)} / {fmtNum(row.document_line_count)}</span>,
    },
  ];

  return (
    <section aria-labelledby="calibration-queue-title" className="space-y-3">
      <div>
        <h2 id="calibration-queue-title" className="section-title">תור החלטות לקורפוס הכיול</h2>
        <p className="mt-1 text-sm text-ink-soft">עד 50 מחירונים בכל פעם. כל החלטה נשמרת כראיה בלתי ניתנת לדריסה ואינה משנה סף או מחיר בעצמה.</p>
      </div>
      {query.loading && !query.data ? <SkeletonTable title={false} cols={6} /> : (
        <DataTable rows={rows} columns={columns} pageSize={20} error={query.error}
          emptyTitle="אין כרגע שורות שממתינות להחלטת כיול"
          emptySubtitle="מחירונים חדשים במצב shadow יופיעו כאן לאחר הפענוח."
          onRowClick={(row) => onReview(row)}
          rowLabel={(row) => row.is_empty_run
            ? `בדיקת מחירון ללא שורות ${row.file_name}`
            : `בדיקת שורה ${row.source_row ?? row.line_index + 1} במחירון ${row.file_name}`}
          rowActions={(row) => [{
            key: 'calibrate', label: 'תיעוד החלטה', icon: ClipboardCheck,
            onSelect: () => onReview(row),
          }]} />
      )}
    </section>
  );
}

function CalibrationReviewModal({ row, onClose, onSaved }: {
  row: CalibrationQueueRow | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [verdict, setVerdict] = useState<CalibrationVerdict>('correct');
  const [expectedAction, setExpectedAction] = useState<CalibrationQueueRow['predicted_action']>('review');
  const [expectedProductId, setExpectedProductId] = useState('');
  const [expectedPrice, setExpectedPrice] = useState('');
  const [errorLabels, setErrorLabels] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const products = useQuery<ProductOption[]>(async () => row && !row.is_empty_run
    ? fetchAll<ProductOption>((from, to) => supabase.from('products')
      .select('id, name, sku, barcode').order('name').order('id').range(from, to))
    : [], [row?.shadow_line_id]);

  useEffect(() => {
    setVerdict('correct');
    setExpectedAction('review');
    setExpectedProductId('');
    setExpectedPrice('');
    setErrorLabels([]);
    setReason('');
    setIdempotencyKey(crypto.randomUUID());
  }, [row?.shadow_line_id]);

  function toggleLabel(label: string) {
    setErrorLabels((current) => current.includes(label)
      ? current.filter((item) => item !== label)
      : [...current, label]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!row || !reason.trim()) return;
    if (row.is_empty_run) {
      setSaving(true);
      try {
        ok(await supabase.rpc(calibrationReviewRpcName(true), {
          p_shadow_run_id: row.shadow_run_id,
          p_idempotency_key: idempotencyKey,
          p_verdict: verdict,
          p_reason: reason.trim(),
        }));
        toast('הכרעת המסמך ללא השורות נשמרה ביומן הראיות.');
        await onSaved();
      } catch (error) {
        toast(toHebrewError(error), 'error');
      } finally {
        setSaving(false);
      }
      return;
    }
    if (!row.shadow_line_id) {
      toast('מזהה שורת הכיול חסר.', 'error');
      return;
    }
    let action: CalibrationQueueRow['predicted_action'] = expectedAction;
    let productId: string | null = expectedProductId || null;
    let unitPrice: number | null = expectedPrice === '' ? null : Number(expectedPrice);
    let labels = errorLabels;
    if (verdict === 'correct') {
      action = row.predicted_action;
      productId = row.product_id;
      unitPrice = row.proposed_unit_price;
      labels = [];
    } else if (verdict === 'ambiguous') {
      action = 'review'; productId = null; unitPrice = null; labels = ['ambiguous'];
    } else if (verdict === 'rejected_by_policy') {
      action = 'rejected_by_policy'; productId = null; unitPrice = null; labels = ['rejected_by_policy'];
    } else if (verdict === 'incorrect') {
      const normalized = normalizeIncorrectCalibration(
        row, action, expectedProductId, expectedPrice, labels,
      );
      if (normalized.problem) { toast(normalized.problem, 'error'); return; }
      productId = normalized.productId;
      unitPrice = normalized.unitPrice;
    } else if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice <= 0)) {
      toast('המחיר הצפוי חייב להיות מספר חיובי.', 'error');
      return;
    }
    setSaving(true);
    try {
      ok(await supabase.rpc(calibrationReviewRpcName(false), {
        p_shadow_line_id: row.shadow_line_id,
        p_idempotency_key: idempotencyKey,
        p_verdict: verdict,
        p_error_labels: labels,
        p_expected_action: action,
        p_expected_product_id: productId,
        p_expected_unit_price: unitPrice,
        p_reason: reason.trim(),
      }));
      toast('החלטת הכיול נשמרה ביומן הראיות.');
      await onSaved();
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={row !== null} onClose={onClose} wide title="תיעוד החלטת כיול"
      description="ההשוואה מתעדת מה האוטומציה חזתה מול ההחלטה האנושית. אין כאן שינוי מחיר או סף.">
      {row && <form className="space-y-5" onSubmit={(event) => void submit(event)}>
        <div className="card card-pad">
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="מסמך" value={row.file_name} />
            <Metric label="ספק" value={row.supplier_name ?? '—'} />
            <Metric label="פעולה חזויה" value={row.is_empty_run ? 'לא זוהו שורות' : PREDICTED_ACTION_LABEL[row.predicted_action]} />
            <Metric label="מחיר חזוי" value={fmtMoneyRounded(row.proposed_unit_price)} />
            <Metric label="מוצר שחושב" value={row.matched_product_name ?? row.product_name ?? '—'} />
            <Metric label="SKU" value={row.sku ?? '—'} />
            <Metric label="ברקוד" value={row.barcode ?? '—'} />
            <Metric label="ביטחון" value={fmtRate(row.decision_confidence)} />
          </div>
        </div>

        {row.is_empty_run && <p className="rounded-xl border border-line-soft bg-surface-muted p-3 text-sm text-ink-body">
          סמן “התחזית נכונה” רק אם במסמך אכן אין שורות מחיר. אם קיימות שורות שהפענוח החמיץ, סמן “התחזית שגויה”.
        </p>}

        <label className="block text-sm font-medium text-ink-body">החלטת הבודק
          <select className="input mt-1" value={verdict}
            onChange={(event) => setVerdict(event.target.value as CalibrationVerdict)}>
            <option value="correct">התחזית נכונה</option>
            <option value="incorrect">התחזית שגויה — נדרש תיקון</option>
            <option value="ambiguous">השורה עמומה ולא ניתנת להכרעה</option>
            <option value="rejected_by_policy">יש לדחות לפי מדיניות</option>
          </select>
        </label>

        {verdict === 'incorrect' && !row.is_empty_run && <div className="space-y-4 rounded-xl border border-line-soft p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-ink-body">הפעולה הנכונה
              <select className="input mt-1" value={expectedAction}
                onChange={(event) => {
                  const action = event.target.value as CalibrationQueueRow['predicted_action'];
                  setExpectedAction(action);
                  setExpectedProductId('');
                  setExpectedPrice('');
                  setErrorLabels([]);
                }}>
                <option value="apply_existing_price">עדכון מחיר למוצר קיים</option>
                <option value="create_product">יצירת מוצר חדש</option>
                <option value="review">העברה לבדיקה</option>
                <option value="rejected_by_policy">דחייה לפי מדיניות</option>
              </select>
            </label>
            {expectedAction === 'apply_existing_price' && <label className="text-sm font-medium text-ink-body">המוצר הנכון
              <select className="input mt-1" value={expectedProductId}
                onChange={(event) => setExpectedProductId(event.target.value)} disabled={products.loading}>
                <option value="">בחירת מוצר…</option>
                {(products.data ?? []).map((product) => <option key={product.id} value={product.id}>
                  {product.name}{product.sku ? ` · ${product.sku}` : product.barcode ? ` · ${product.barcode}` : ''}
                </option>)}
              </select>
              {products.error && <span className="mt-1 block text-xs text-danger">רשימת המוצרים לא נטענה.</span>}
            </label>}
            {(expectedAction === 'apply_existing_price' || expectedAction === 'create_product') && <label className="text-sm font-medium text-ink-body">המחיר הנכון
              <input className="input mt-1 num" type="number" min="0.01" step="0.01" inputMode="decimal"
                value={expectedPrice} onChange={(event) => setExpectedPrice(event.target.value)} />
            </label>}
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-ink-body">סוג הטעות, אם יש סיווג מתאים</legend>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label><input type="checkbox" className="me-2" checked={errorLabels.includes('incorrect_action')} onChange={() => toggleLabel('incorrect_action')} />פעולה שגויה</label>
              {row.predicted_action === 'apply_existing_price' && <label><input type="checkbox" className="me-2" checked={errorLabels.includes('incorrect_product_match')} onChange={() => toggleLabel('incorrect_product_match')} />התאמת מוצר שגויה</label>}
              {row.predicted_action === 'create_product' && <label><input type="checkbox" className="me-2" checked={errorLabels.includes('incorrect_new_product')} onChange={() => toggleLabel('incorrect_new_product')} />יצירת מוצר שגויה</label>}
              {(row.proposed_unit_price !== null || expectedAction === 'apply_existing_price' || expectedAction === 'create_product')
                && <label><input type="checkbox" className="me-2" checked={errorLabels.includes('incorrect_price')} onChange={() => toggleLabel('incorrect_price')} />מחיר שגוי או חסר</label>}
            </div>
          </fieldset>
        </div>}

        <label className="block text-sm font-medium text-ink-body">סיבת ההחלטה
          <textarea className="input mt-1 min-h-24" required maxLength={1000} value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="מה נבדק ומה הוביל להחלטה" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>ביטול</button>
          <button type="submit" className="btn-primary" disabled={saving || !reason.trim()}>
            {saving ? 'שומר החלטה…' : 'שמירת החלטה'}
          </button>
        </div>
      </form>}
    </Modal>
  );
}

function DriftSection({ query, supplierNames, supplierNamesKnown, suppliersError }: {
  query: ReturnType<typeof useQuery<DriftMetrics>>;
  supplierNames: Map<string, string>;
  supplierNamesKnown: boolean;
  suppliersError: string | null;
}) {
  const rows = (query.data?.groups ?? []).map((group, index) => ({ ...group, id: `${group.supplier_id ?? 'none'}-${group.document_format}-${group.provider}-${group.model}-${group.prompt_version}-${group.extraction_engine}-${group.extraction_model_version}-${index}` }));
  const columns: Column<DriftGroup & { id: string }>[] = [
    {
      key: 'supplier', header: 'ספק', priority: 1,
      render: (row) => row.supplier_id ? (supplierNames.get(row.supplier_id) ?? (supplierNamesKnown ? 'ספק לא זמין' : '—')) : 'ללא ספק מזוהה',
    },
    { key: 'format', header: 'פורמט', priority: 2, render: (row) => documentFormatLabel(row.document_format) },
    {
      key: 'version', header: 'גרסת עיבוד', priority: 3,
      render: (row) => <span>{row.provider} · {row.model} · {row.prompt_version}<span className="block text-xs text-ink-muted">{row.extraction_engine} · {row.extraction_model} · {row.extraction_model_version}</span></span>,
    },
    { key: 'runs', header: 'הרצות עכשיו / קודם', className: 'num', priority: 2, render: (row) => <span className="num">{fmtNum(row.current_run_count)} / {fmtNum(row.prior_run_count)}</span> },
    { key: 'unmatched', header: 'ללא התאמה', className: 'num', priority: 1, render: (row) => <span className="num">{fmtRate(row.current_unmatched_rate)} <span className="text-xs text-ink-muted">({fmtDelta(row.unmatched_rate_delta)})</span></span> },
    { key: 'created', header: 'הצעת מוצר חדש', className: 'num', priority: 2, render: (row) => <span className="num">{fmtRate(row.current_created_product_rate)} <span className="text-xs text-ink-muted">({fmtDelta(row.created_product_rate_delta)})</span></span> },
    { key: 'confidence', header: 'ביטחון ממוצע', className: 'num', priority: 2, render: (row) => <span className="num">{fmtRate(row.current_mean_confidence)} <span className="text-xs text-ink-muted">({fmtDelta(row.mean_confidence_delta)})</span></span> },
    { key: 'price', header: 'שינוי מחיר P90', className: 'num', priority: 2, render: (row) => <span className="num">{fmtPriceChange(row.absolute_price_change_p90)}</span> },
    {
      key: 'layout', header: 'מבנה מסמך', priority: 1,
      render: (row) => row.layout_change_detected === null
        ? <span className="badge-idle">אין בסיס להשוואה</span>
        : row.layout_change_detected
          ? <span className="badge-alert">שינוי מבנה זוהה · <span className="num">{fmtNum(row.new_layout_count)}</span> חדשים</span>
          : <span className="badge-done">ללא שינוי מזוהה</span>,
    },
  ];
  return (
    <section aria-labelledby="price-list-drift-title" className="space-y-3">
      <div>
        <h2 id="price-list-drift-title" className="section-title">השוואת שינויי מחירונים</h2>
        <p className="mt-1 text-sm text-ink-soft">
          שינוי מבני — פורמט, חוזה העיבוד, כותרות, מספר שדות או סדרם — מבטל זכאות קודמת ומעביר אוטומטית את המבנה החדש למצב צל, עד החלטת מפעיל מפורשת.
          <span className="mt-1 block">שינויים מספריים בין החלונות בשיעורי אי־התאמה והצעת מוצר חדש, בביטחון ובמחיר הם מדדי תצפית ותעדוף בדיקה בלבד; הם אינם מייצרים סף drift אוטומטי ואינם משנים לבדם את זכאות המבנה. סף הביטחון המפורש של מדיניות הקליטה ממשיך להיבדק לכל מסמך.</span>
          <span className="mt-1 block">קורפוס 50 המחירונים נשאר תהליך כיול אנושי; אין למידה עצמית או שינוי ספים אוטומטי.</span>
        </p>
      </div>
      {query.loading && !query.data ? <SkeletonTable title={false} cols={7} /> : query.error && !query.data ? <ErrorNote message={query.error} /> : (
        <>
          {query.error && <ErrorNote message={query.error} />}
          {suppliersError && <Note tone="idle">שמות ספקים אינם זמינים כרגע; קבוצות לא מזוהות מוצגות כ־<span className="num">—</span>.</Note>}
          <DataTable rows={rows} columns={columns} pageSize={15}
            emptyTitle="אין עדיין בסיס להשוואת שינוי"
            emptySubtitle="לאחר שתי תקופות מדידה יופיעו כאן השוואות לפי ספק, פורמט וגרסת עיבוד." />
        </>
      )}
    </section>
  );
}

function AttemptHistoryModal({ attempts, open, loading, error, onClose, onReview, onReprocess }: {
  attempts: AttemptRow[];
  open: boolean;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onReview: (attempt: AttemptRow) => void;
  onReprocess: ((attempt: AttemptRow) => void) | null;
}) {
  const current = attempts[0];
  return (
    <Modal open={open} onClose={onClose} wide title={`ניסיונות עיבוד — ${current?.file_name ?? 'מסמך'}`}
      description="התוצאה הנוכחית מוצגת ראשונה; עד 500 תוצאות נשמרות להשוואה ואינן נדרסות.">
      {loading ? <p role="status" className="text-sm text-ink-muted">טוען היסטוריית עיבוד…</p> : error ? <ErrorNote message={error} /> : attempts.length === 0 ? <p className="text-sm text-ink-muted">לא נמצאו ניסיונות למסמך.</p> : (
        <div className="space-y-3">
          {attempts.map((attempt, index) => (
            <article key={attempt.job_id} className="rounded-xl border border-line-soft p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-ink">{index === 0 ? 'תוצאה נוכחית' : `תוצאה קודמת ${index}`}</h3>
                    <StatusBadge meta={attemptStatusMeta(attempt)} />
                  </div>
                  <p className="mt-1 text-xs text-ink-muted"><span className="num">{fmtDateTime(attempt.updated_at)}</span></p>
                </div>
                {index === 0 && (
                  <div className="flex flex-wrap gap-2">
                    {attempt.interpretation_id && <button type="button" className="btn-secondary" onClick={() => onReview(attempt)}><Eye size={15} aria-hidden="true" /> פתיחת בדיקה</button>}
                    {onReprocess && !isActiveAttempt(attempt) && <button type="button" className="btn-secondary" onClick={() => onReprocess(attempt)}><RotateCcw size={15} aria-hidden="true" /> עיבוד מחדש</button>}
                  </div>
                )}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Metric label="סוג מסמך" value={attempt.document_type ? DOCUMENT_TYPE_LABEL[attempt.document_type] ?? 'סוג אחר' : '—'} />
                <Metric label="ביטחון בסוג" value={fmtRate(attempt.document_type_confidence)} />
                <Metric label="משך חילוץ" value={fmtDuration(attempt.extraction_duration_ms)} />
                <Metric label="משך פענוח" value={fmtDuration(attempt.interpretation_duration_ms)} />
                <Metric label="תוצאת מחירון" value={attemptResult(attempt)} />
                <Metric label="שורות שהוחלו" value={fmtNum(attempt.price_list_applied_count)} />
                <Metric label="שורות לבדיקה" value={fmtNum(attempt.price_list_waiting_count)} />
                <Metric label="עלות מדווחת" value={fmtMoneyRounded(attempt.usage_cost)} />
              </dl>
              {attempt.status === 'failed' && (
                <Note tone="alert" className="mt-4">
                  <strong>פרטי כשל:</strong> <span dir="auto">{attempt.last_error_message ?? attempt.last_error_code ?? 'לא נמסרו פרטים'}</span>
                </Note>
              )}
              <details className="mt-4 text-xs text-ink-soft">
                <summary className="cursor-pointer font-medium">פרטי גרסה טכניים</summary>
                <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Metric label="מנוע חילוץ" value={[attempt.extraction_engine, attempt.extraction_model, attempt.extraction_model_version].filter(Boolean).join(' · ') || '—'} />
                  <Metric label="פענוח" value={[attempt.provider, attempt.interpretation_model, attempt.prompt_version].filter(Boolean).join(' · ') || '—'} />
                  <Metric label="גרסת חוזה" value={attempt.schema_version ?? '—'} />
                  <Metric label="גיל בתור" value={fmtAge(attempt.queue_age_seconds)} />
                </dl>
              </details>
            </article>
          ))}
          {current?.interpretation_id && (
            <Link className="btn-secondary" to={`/documents/${encodeURIComponent(current.document_id)}/review`}>
              מעבר למרחב הבדיקה המלא
            </Link>
          )}
        </div>
      )}
    </Modal>
  );
}

function Metric({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink-body"><span className="num">{value}</span>{suffix && value !== '—' ? ` ${suffix}` : ''}</dd>
    </div>
  );
}

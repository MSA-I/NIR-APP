import { useEffect, useMemo, useState } from 'react';
import { Eye, FileSearch, RefreshCw, RotateCcw } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import {
  ConfirmDialog,
  DataTable,
  KpiCard,
  Note,
  SkeletonCards,
  SkeletonTable,
  useToast,
  type Column,
} from '../components/ui';
import { DocumentStatusBadge } from '../components/DocumentStatusBadge';
import { ok, toHebrewError } from '../lib/errors';
import { fmtDateTime, fmtMoneyRounded, fmtNum } from '../lib/format';
import { supabase } from '../lib/supabase';
import { DOCUMENT_PROCESSING_CHANGED_EVENT, useDocumentProcessing } from '../lib/useDocumentProcessing';
import { useQuery, unwrap } from '../lib/useQuery';
import {
  attemptUiStatus,
  recoveryInvokeErrorMessage,
  selectPrimaryOperationalIssue,
  type OperationalAttemptState,
} from './documentOperationsModel';

interface DocumentControlMetrics {
  window_days: number;
  documents_waiting: number;
  documents_processing: number;
  documents_stuck: number;
  documents_review_required: number;
  documents_failed: number;
  documents_completed: number;
  retry_count: number;
  average_processing_duration_ms: number | null;
  last_processing_at: string | null;
}

interface DocumentControlAttempt extends OperationalAttemptState {
  id: string;
  job_id: string;
  document_id: string;
  file_name: string;
  status: string;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  queue_age_seconds: number | null;
  price_list_outcome: string | null;
  is_stuck: boolean;
}

interface PriceReviewRow {
  id: string;
  document_id: string;
  file_name: string;
  supplier_name: string | null;
  source_row: number | null;
  predicted_action: string;
  product_name: string | null;
  matched_product_name: string | null;
  sku: string | null;
  proposed_unit_price: number | null;
  current_unit_price: number | null;
  document_line_count: number;
  document_reviewed_count: number;
  is_empty_run: boolean;
}

interface PriceReviewRpcRow extends Omit<PriceReviewRow, 'id'> {
  review_key: string;
}

type AttemptFilter = 'all' | 'attention' | 'processing' | 'completed';

type RecoveryTarget = Pick<DocumentControlAttempt, 'job_id' | 'document_id' | 'file_name'>;

const PRICE_ACTION_LABEL: Record<string, string> = {
  apply_existing_price: 'בדיקת עדכון מחיר למוצר קיים',
  create_product: 'בדיקת מוצר חדש',
  review: 'נדרשת החלטה',
  rejected_by_policy: 'בדיקת חריגה ממדיניות',
};

function attemptFilterKey(attempt: DocumentControlAttempt): Exclude<AttemptFilter, 'all'> {
  const status = attemptUiStatus(attempt);
  if (status.state === 'failed' || status.state === 'stuck' || status.state === 'review') return 'attention';
  if (status.state === 'processing') return 'processing';
  return 'completed';
}

function isActiveAttempt(attempt: DocumentControlAttempt) {
  return ['queued', 'leased', 'extracted', 'interpreting'].includes(attempt.status);
}

function fmtDuration(ms: number | null) {
  if (ms === null) return '—';
  if (ms < 1000) return `${fmtNum(ms)} מ״ש`;
  if (ms < 60_000) return `${fmtNum(ms / 1000)} שנ׳`;
  return `${fmtNum(ms / 60_000)} דק׳`;
}

export default function DocumentOperations() {
  const { organizationAccess, profile } = useAuth();
  const canWrite = organizationAccess?.canWrite ?? true;
  const canRecoverStuck = canWrite && profile?.role === 'owner';
  const navigate = useNavigate();
  const toast = useToast();
  const [windowDays, setWindowDays] = useState(30);
  const [filter, setFilter] = useState<AttemptFilter>('all');
  const [reprocessTarget, setReprocessTarget] = useState<DocumentControlAttempt | null>(null);
  const [reprocessing, setReprocessing] = useState(false);
  const [recoveryTarget, setRecoveryTarget] = useState<RecoveryTarget | null>(null);
  const [recovering, setRecovering] = useState(false);

  const operations = useQuery<DocumentControlMetrics>(async () =>
    unwrap(await supabase.rpc('get_document_operations_metrics', { p_window_days: windowDays })) as DocumentControlMetrics,
  [windowDays]);

  const attempts = useQuery<DocumentControlAttempt[]>(async () => {
    const rows = unwrap(await supabase.rpc('get_document_control_attempts', {
      p_document_id: null,
      p_limit: 100,
    })) as Omit<DocumentControlAttempt, 'id'>[];
    return rows.map((row) => ({ ...row, id: row.job_id }));
  });

  const priceReviews = useQuery<PriceReviewRow[]>(async () => {
    const rows = unwrap(await supabase.rpc('get_document_control_price_review_queue', {
      p_document_limit: 50,
    })) as PriceReviewRpcRow[];
    return rows.map((row) => ({ ...row, id: row.review_key }));
  });

  const currentProcessing = useDocumentProcessing();
  const attemptNames = useMemo(() => new Map((attempts.data ?? []).map((row) => [row.document_id, row.file_name])), [attempts.data]);
  const currentIssues = useMemo<DocumentControlAttempt[]>(() => Object.values(currentProcessing.snapshots)
    .flatMap((snapshot) => snapshot.job ? [{
      id: snapshot.job.id,
      job_id: snapshot.job.id,
      document_id: snapshot.job.document_id,
      file_name: attemptNames.get(snapshot.job.document_id) ?? 'מסמך ללא שם זמין',
      status: snapshot.job.status,
      attempt_count: snapshot.job.attempt_count,
      created_at: snapshot.job.created_at,
      updated_at: snapshot.job.updated_at,
      queue_age_seconds: snapshot.job.queue_age_seconds ?? null,
      last_error_code: snapshot.job.last_error_code ?? null,
      price_list_outcome: null,
      is_stuck: snapshot.job.is_stuck ?? false,
      stuck_reason: snapshot.job.stuck_reason ?? null,
    }] : []), [attemptNames, currentProcessing.snapshots]);
  const currentIssue = useMemo(() => selectPrimaryOperationalIssue(currentIssues), [currentIssues]);
  const filteredAttempts = useMemo(() => (attempts.data ?? []).filter((attempt) =>
    filter === 'all' || attemptFilterKey(attempt) === filter), [attempts.data, filter]);

  useEffect(() => {
    const refresh = () => void Promise.all([
      operations.refetch(), attempts.refetch(), priceReviews.refetch(), currentProcessing.refetch(),
    ]);
    const interval = window.setInterval(refresh, 10_000);
    window.addEventListener('focus', refresh);
    window.addEventListener(DOCUMENT_PROCESSING_CHANGED_EVENT, refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(DOCUMENT_PROCESSING_CHANGED_EVENT, refresh);
    };
  }, [attempts.refetch, currentProcessing.refetch, operations.refetch, priceReviews.refetch]);

  async function refreshAll() {
    await Promise.all([
      operations.refetch(), attempts.refetch(), priceReviews.refetch(), currentProcessing.refetch(),
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
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
      await Promise.all([operations.refetch(), attempts.refetch()]);
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setReprocessing(false);
    }
  }

  async function recoverStuck(reason?: string) {
    if (!canRecoverStuck || !recoveryTarget || !reason) return;
    setRecovering(true);
    try {
      const response = await supabase.functions.invoke('recover-document-processing', {
        body: {
          job_id: recoveryTarget.job_id,
          request_id: crypto.randomUUID(),
          reason,
        },
      });
      if (response.error) throw new Error(await recoveryInvokeErrorMessage(response) ?? response.error.message);
      const result = response.data as { outcome?: string; job_id?: string; idempotent?: boolean } | null;
      const message = result?.idempotent
        ? 'השחזור כבר בוצע קודם; מצב המסמך עודכן.'
        : result?.outcome === 'requeued'
          ? 'נפתח ניסיון עיבוד חדש.'
          : result?.outcome === 'interpretation_recovered'
            ? 'נמצאה תוצאת פענוח קיימת והמסמך הועבר להמשך טיפול.'
            : 'העיבוד שוחזר וממשיך מהשלב הבטוח האחרון.';
      toast(message);
      setRecoveryTarget(null);
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
      await Promise.all([operations.refetch(), attempts.refetch(), currentProcessing.refetch()]);
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setRecovering(false);
    }
  }

  const attemptColumns: Column<DocumentControlAttempt>[] = [
    {
      key: 'document', header: 'מסמך', priority: 1, sortValue: (row) => row.file_name,
      render: (row) => <span className="font-medium text-ink">{row.file_name}</span>,
    },
    {
      key: 'status', header: 'מצב', priority: 1,
      sortValue: (row) => attemptUiStatus(row).priority,
      render: (row) => <DocumentStatusBadge status={attemptUiStatus(row)} />,
    },
    {
      key: 'updated', header: 'עדכון אחרון', priority: 2, sortValue: (row) => row.updated_at,
      render: (row) => <span className="num">{fmtDateTime(row.updated_at)}</span>,
    },
    {
      key: 'attempts', header: 'ניסיונות', priority: 2, className: 'num', sortValue: (row) => row.attempt_count,
      render: (row) => <span className="num">{fmtNum(row.attempt_count)}</span>,
    },
  ];

  const priceReviewColumns: Column<PriceReviewRow>[] = [
    {
      key: 'document', header: 'מחירון', priority: 1, sortValue: (row) => row.file_name,
      render: (row) => <span><strong className="block text-ink">{row.file_name}</strong><span className="text-xs text-ink-muted">{row.supplier_name ?? 'ספק לא זוהה'}</span></span>,
    },
    {
      key: 'decision', header: 'מה צריך לבדוק', priority: 1,
      render: (row) => <span>{row.is_empty_run ? 'המסמך לא החזיר שורות מוצר' : PRICE_ACTION_LABEL[row.predicted_action] ?? 'נדרשת החלטה'}</span>,
    },
    {
      key: 'product', header: 'מוצר', priority: 2,
      render: (row) => <span>{row.matched_product_name ?? row.product_name ?? 'לא זוהה מוצר'}{row.sku && <span className="block text-xs text-ink-muted num">{row.sku}</span>}</span>,
    },
    {
      key: 'price', header: 'מחיר נוכחי ← מוצע', priority: 2, className: 'num',
      render: (row) => <span className="num">{fmtMoneyRounded(row.current_unit_price)} ← {fmtMoneyRounded(row.proposed_unit_price)}</span>,
    },
  ];

  const metrics = operations.data;
  const attentionCount = metrics?.documents_review_required ?? 0;
  const processingCount = (metrics?.documents_waiting ?? 0) + (metrics?.documents_processing ?? 0);
  const failureCount = (metrics?.documents_stuck ?? 0) + (metrics?.documents_failed ?? 0);

  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-5">
        <div className="max-w-2xl">
          <p className="mb-1 text-xs font-semibold text-action">מסמכים שדורשים החלטה</p>
          <h1 className="page-title">בקרת מסמכים</h1>
          <p className="mt-1 text-sm text-ink-soft">תמונה ברורה של מה בעיבוד, מה נעצר ומה מחכה לך—עם פעולה ישירה לכל מסמך.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-auto!" aria-label="טווח בקרת מסמכים" value={windowDays}
            onChange={(event) => setWindowDays(Number(event.target.value))}>
            <option value={7}>7 ימים</option>
            <option value={30}>30 ימים</option>
            <option value={90}>90 ימים</option>
          </select>
          <button type="button" className="btn-secondary min-h-11" onClick={() => void refreshAll()}
            disabled={operations.fetching || attempts.fetching || priceReviews.fetching}
            aria-label="רענון בקרת מסמכים">
            <RefreshCw size={16} aria-hidden="true" /> רענון
          </button>
        </div>
      </header>

      <section aria-labelledby="document-control-overview-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="document-control-overview-title" className="section-title">מה קורה עכשיו</h2>
            <p className="mt-1 text-sm text-ink-soft">ארבעה מספרים בלבד, לפי המצב הנוכחי של כל מסמך.</p>
          </div>
          {metrics && <p className="text-xs text-ink-muted">משך עיבוד ממוצע: <span className="num">{fmtDuration(metrics.average_processing_duration_ms)}</span></p>}
        </div>
        {operations.loading && !metrics ? <SkeletonCards count={4} cols={4} /> : metrics && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard title="דורש טיפול" value={fmtNum(attentionCount)} sub="ממתין להחלטה שלך" tone={attentionCount ? 'await' : 'idle'} />
            <KpiCard title="בעיבוד" value={fmtNum(processingCount)} sub="בתור או בעבודה עכשיו" tone={processingCount ? 'info' : 'idle'} />
            <KpiCard title="תקלות" value={fmtNum(failureCount)} sub="נעצר או נכשל" tone={failureCount ? 'alert' : 'idle'} />
            <KpiCard title="הושלם" value={fmtNum(metrics.documents_completed)} sub={`ב־${windowDays} הימים האחרונים`} tone="done" />
          </div>
        )}
        {operations.error && <Note tone="alert" role="alert">{operations.error}</Note>}
      </section>

      {currentIssue && (
        <section aria-labelledby="document-control-attention-title" className="rounded-xl border border-alert/30 bg-alert-soft p-4 sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p id="document-control-attention-title" className="text-xs font-semibold text-alert">הפריט הדחוף ביותר</p>
              <h2 className="mt-1 truncate text-lg font-semibold text-ink">{currentIssue.file_name}</h2>
              <p className="mt-1 text-sm text-ink-soft">{attemptUiStatus(currentIssue).description}</p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              {canRecoverStuck && attemptUiStatus(currentIssue).state === 'stuck' && (
                <button type="button" className="btn-primary min-h-11 w-full sm:w-auto" onClick={() => setRecoveryTarget(currentIssue)}>
                  <RotateCcw size={16} aria-hidden="true" /> שחזור עיבוד
                </button>
              )}
              <button type="button" className="btn-secondary min-h-11 w-full sm:w-auto"
                onClick={() => navigate(`/documents/${encodeURIComponent(currentIssue.document_id)}/review`)}>
                <Eye size={16} aria-hidden="true" /> פתיחת המסמך
              </button>
            </div>
          </div>
        </section>
      )}

      <section aria-labelledby="document-control-recent-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="document-control-recent-title" className="section-title">מסמכים אחרונים</h2>
            <p className="mt-1 text-sm text-ink-soft">לחיצה על מסמך פותחת את סביבת הבדיקה שלו.</p>
          </div>
          {attempts.fetching && attempts.data && <span className="text-xs text-ink-muted" role="status">מעדכן מסמכים…</span>}
        </div>
        {attempts.loading && !attempts.data ? <SkeletonTable title={false} cols={4} /> : (
          <DataTable rows={filteredAttempts} columns={attemptColumns} searchable pageSize={20}
            searchLabel="חיפוש מסמך בבקרת מסמכים"
            searchFn={(row, query) => row.file_name.toLocaleLowerCase('he').includes(query)}
            error={attempts.error}
            activeFilters={filter === 'all' ? 0 : 1}
            onClearFilters={() => setFilter('all')}
            emptyTitle="אין מסמכים במצב שנבחר"
            emptySubtitle={filter === 'all' ? 'מסמכים חדשים יופיעו כאן לאחר העלאה.' : 'אפשר לנקות את הסינון ולראות מצבים אחרים.'}
            toolbar={
              <select className="input w-auto!" aria-label="סינון מסמכים לפי מצב" value={filter}
                onChange={(event) => setFilter(event.target.value as AttemptFilter)}>
                <option value="all">כל המצבים</option>
                <option value="attention">דורש טיפול</option>
                <option value="processing">בעיבוד</option>
                <option value="completed">הושלם</option>
              </select>
            }
            onRowClick={(row) => navigate(`/documents/${encodeURIComponent(row.document_id)}/review`)}
            rowLabel={(row) => `מסמך ${row.file_name}`}
            rowActions={(row) => [
              { key: 'review', label: 'פתיחת בדיקה', icon: Eye, onSelect: () => navigate(`/documents/${encodeURIComponent(row.document_id)}/review`) },
              { key: 'recover', label: 'שחזור עיבוד', icon: RotateCcw, hidden: !canRecoverStuck || attemptUiStatus(row).state !== 'stuck', onSelect: () => setRecoveryTarget(row) },
              { key: 'reprocess', label: row.status === 'failed' ? 'ניסיון נוסף' : 'עיבוד מחדש', icon: RotateCcw, hidden: !canWrite || isActiveAttempt(row), onSelect: () => setReprocessTarget(row) },
            ]}
          />
        )}
      </section>

      <section aria-labelledby="document-control-price-title" className="space-y-3">
        <div>
          <h2 id="document-control-price-title" className="section-title">מחירונים שממתינים לבדיקה</h2>
          <p className="mt-1 text-sm text-ink-soft">רק החלטות עסקיות פתוחות—בלי נתוני מודל או מדדי מעבדה.</p>
        </div>
        {priceReviews.loading && !priceReviews.data ? <SkeletonTable title={false} cols={4} /> : (
          <DataTable rows={priceReviews.data ?? []} columns={priceReviewColumns} pageSize={10}
            error={priceReviews.error}
            emptyTitle="אין כרגע מחירונים שממתינים לבדיקה"
            emptySubtitle="מחירון חדש שידרוש החלטה יופיע כאן."
            onRowClick={(row) => navigate(`/documents/${encodeURIComponent(row.document_id)}/review`)}
            rowLabel={(row) => `בדיקת מחירון ${row.file_name}`}
            rowActions={(row) => [{
              key: 'review-price-list', label: 'פתיחת המסמך', icon: FileSearch,
              onSelect: () => navigate(`/documents/${encodeURIComponent(row.document_id)}/review`),
            }]}
          />
        )}
      </section>

      <ConfirmDialog open={canWrite && reprocessTarget !== null} onClose={() => setReprocessTarget(null)}
        onConfirm={(reason) => void reprocess(reason)} requireReason busy={reprocessing}
        title="עיבוד המסמך מחדש" message="המסמך יחזור לתור העיבוד. ההיסטוריה הקודמת תישמר."
        confirmLabel="עיבוד מחדש" />
      <ConfirmDialog open={canRecoverStuck && recoveryTarget !== null} onClose={() => setRecoveryTarget(null)}
        onConfirm={(reason) => void recoverStuck(reason)} requireReason busy={recovering}
        title="שחזור עיבוד תקוע" message="השחזור ממשיך מהשלב הבטוח האחרון ואינו מעלה את הקובץ מחדש."
        confirmLabel="שחזור עיבוד" />
    </div>
  );
}

import type { TKey } from '../lib/i18n/t';
import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Camera, FileSearch, RefreshCw, Upload } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import {
  Card,
  ConfirmDialog,
  DataTable,
  ICON,
  KpiCard,
  Note,
  PageHeader,
  SkeletonCards,
  SkeletonTable,
  useToast,
  type Column,
} from '../components/ui';
import { DocumentStatusBadge } from '../components/DocumentStatusBadge';
import { ok } from '../lib/errors';
import { reasonOr } from '../lib/reason';
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

/**
 * What the two operational commands write to the ledger. Neither screen asks a person for a reason
 * any more (#299), and both boundaries refuse a blank one — the RPC with `reason_required` (22023)
 * and the Edge function with `invalid_request`. So the action name is the reason: it says which
 * command ran, and `reasonOr` appends the admission that nobody added a note. Descriptive on
 * purpose — `audit_logs` shows the string, not the button that produced it.
 */
const REPROCESS_ACTION = 'החזרת מסמך לתור העיבוד ממסך בקרת המסמכים';
const RECOVER_STUCK_ACTION = 'שחזור עיבוד תקוע ממסך בקרת המסמכים';

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
  /** 0225: both prices are the SUPPLIER's own money — a price list is that supplier's quote. */
  currency: string | null;
  document_line_count: number;
  document_reviewed_count: number;
  is_empty_run: boolean;
}

interface PriceReviewRpcRow extends Omit<PriceReviewRow, 'id'> {
  review_key: string;
}

type AttemptFilter = 'all' | 'attention' | 'processing' | 'completed';

type RecoveryTarget = Pick<DocumentControlAttempt, 'job_id' | 'document_id' | 'file_name'>;

const PRICE_ACTION_KEYS: Record<string, TKey> = {
  apply_existing_price: 'documentOps.priceActionApplyExisting',
  create_product: 'documentOps.priceActionCreateProduct',
  review: 'documentOps.priceActionReview',
  rejected_by_policy: 'documentOps.priceActionRejectedByPolicy',
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

function fmtDuration(ms: number | null, t: (key: TKey, vars?: Record<string, string | number>) => string) {
  if (ms === null) return '—';
  if (ms < 1000) return t('documentOps.durationMs', { value: fmtNum(ms) });
  if (ms < 60_000) return t('documentOps.durationSeconds', { value: fmtNum(ms / 1000) });
  return t('documentOps.durationMinutes', { value: fmtNum(ms / 60_000) });
}

export default function DocumentOperations() {
  const { errorText, t } = useT();
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
      file_name: attemptNames.get(snapshot.job.document_id) ?? t('documentOps.get'),
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

  async function reprocess() {
    // The reason left this dialog (#299), so `reason` left this guard with it. What the guard was
    // actually for stays: no write without write access, and no write without a target row.
    if (!canWrite || !reprocessTarget) return;
    setReprocessing(true);
    try {
      ok(await supabase.rpc('reprocess_document', {
        p_document_id: reprocessTarget.document_id,
        // `reprocess_document` raises `reason_required` (22023, `0093:25`) on a blank reason, so the
        // ledger keeps a sentence even though nobody is asked to write one.
        p_reason: reasonOr(null, REPROCESS_ACTION),
      }));
      toast(t('documentOps.toast'));
      setReprocessTarget(null);
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
      await Promise.all([operations.refetch(), attempts.refetch()]);
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setReprocessing(false);
    }
  }

  async function recoverStuck() {
    if (!canRecoverStuck || !recoveryTarget) return;
    setRecovering(true);
    try {
      const response = await supabase.functions.invoke('recover-document-processing', {
        body: {
          job_id: recoveryTarget.job_id,
          request_id: crypto.randomUUID(),
          // The Edge contract rejects the request outright when the trimmed reason is shorter than
          // one character (`recover-document-processing/core.ts:48-55`), so the same rule as the
          // RPC above applies: the box is gone, the sentence is not.
          reason: reasonOr(null, RECOVER_STUCK_ACTION),
        },
      });
      if (response.error) throw new Error(await recoveryInvokeErrorMessage(response) ?? response.error.message);
      const result = response.data as { outcome?: string; job_id?: string; idempotent?: boolean } | null;
      const message = result?.idempotent
        ? t('documentOps.text')
        : result?.outcome === 'requeued'
          ? t('documentOps.text_2')
          : result?.outcome === 'interpretation_recovered'
            ? t('documentOps.text_3')
            : t('documentOps.text_4');
      toast(message);
      setRecoveryTarget(null);
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
      await Promise.all([operations.refetch(), attempts.refetch(), currentProcessing.refetch()]);
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setRecovering(false);
    }
  }

  const attemptColumns: Column<DocumentControlAttempt>[] = [
    {
      key: 'document', header: t('documentOps.text_5'), priority: 1, sortValue: (row) => row.file_name,
      // <bdi>: a file name is a NAME, and the name-isolation rule (DESIGN.md, חוק בידוד השמות)
      // covers it. Measured in Chrome, artifacts/w8/filenames-bidi-probe.json: without an isolate,
      // `invoice-2026-08 סופי.pdf` renders in this RTL cell as `pdf.יפוס invoice-2026-08` — the
      // extension torn off the name and parked at the far margin. Pure-Hebrew and pure-Latin names
      // are unaffected, which is why the defect survived: it needs both scripts in one name.
      render: (row) => <span className="font-medium text-ink"><bdi>{row.file_name}</bdi></span>,
    },
    {
      key: 'status', header: t('documentOps.text_6'), priority: 1,
      sortValue: (row) => attemptUiStatus(row).priority,
      render: (row) => <DocumentStatusBadge status={attemptUiStatus(row)} />,
    },
    {
      key: 'updated', header: t('documentOps.text_7'), priority: 2, sortValue: (row) => row.updated_at,
      render: (row) => <span className="num">{fmtDateTime(row.updated_at)}</span>,
    },
    {
      key: 'attempts', header: t('documentOps.text_8'), priority: 2, className: 'num', sortValue: (row) => row.attempt_count,
      render: (row) => <span className="num">{fmtNum(row.attempt_count)}</span>,
    },
  ];

  const priceReviewColumns: Column<PriceReviewRow>[] = [
    {
      key: 'document', header: t('documentOps.text_9'), priority: 1, sortValue: (row) => row.file_name,
      render: (row) => <span><strong className="block text-ink"><bdi>{row.file_name}</bdi></strong><span className="text-xs text-ink-muted">{row.supplier_name ?? t('documentOps.text_10')}</span></span>,
    },
    {
      key: 'decision', header: t('documentOps.text_11'), priority: 1,
      render: (row) => <span>{row.is_empty_run ? t('documentOps.text_12') : (row.predicted_action in PRICE_ACTION_KEYS ? t(PRICE_ACTION_KEYS[row.predicted_action]) : t('documentOps.text_13'))}</span>,
    },
    {
      key: 'product', header: t('documentOps.text_14'), priority: 2,
      render: (row) => <span><bdi>{row.matched_product_name ?? row.product_name ?? t('documentOps.text_15')}</bdi>{row.sku && <span className="block text-xs text-ink-muted num">{row.sku}</span>}</span>,
    },
    {
      key: 'price', header: t('documentOps.text_16'), priority: 2, className: 'num',
      render: (row) => <span className="num">{fmtMoneyRounded(row.current_unit_price, row.currency)} ← {fmtMoneyRounded(row.proposed_unit_price, row.currency)}</span>,
    },
  ];

  const metrics = operations.data;
  const attentionCount = metrics?.documents_review_required ?? 0;
  const processingCount = (metrics?.documents_waiting ?? 0) + (metrics?.documents_processing ?? 0);
  const failureCount = (metrics?.documents_stuck ?? 0) + (metrics?.documents_failed ?? 0);

  return (
    <div className="min-w-0 space-y-6">
      {/* The eyebrow („מסמכים שדורשים החלטה") is gone, not lost: PageHeader resolves this route's
          own one-line description from the catalogue — „בקרה על קליטת המסמכים: מה נתקע בעיבוד, מה
          נכשל ומה ממתין להחלטה אנושית" — which says the same thing in the place every other screen
          says it. The rule under the header is kept through `className`. */}
      <PageHeader
        className="border-b border-line pb-5"
        title={t('documentOps.title')}
        actions={
          <>
            <select className="input w-auto!" aria-label={t('documentOps.aria_label')} value={windowDays}
              onChange={(event) => setWindowDays(Number(event.target.value))}>
              <option value={7}>{t('documentOps.text_17')}</option>
              <option value={30}>{t('documentOps.text_18')}</option>
              <option value={90}>{t('documentOps.text_19')}</option>
            </select>
            <button type="button" className="btn-secondary" onClick={() => void refreshAll()}
              disabled={operations.fetching || attempts.fetching || priceReviews.fetching}
              aria-label={t('documentOps.aria_label_2')}>
              <RefreshCw size={ICON.sm} aria-hidden="true" /> {t('documentOps.refresh')}
            </button>
          </>
        }
      />

      <section aria-labelledby="document-control-overview-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="document-control-overview-title" className="section-title">{t('documentOps.text_20')}</h2>
          {metrics && <p className="text-xs text-ink-muted">{t('documentOps.fmtDuration')} <span className="num">{fmtDuration(metrics.average_processing_duration_ms, t)}</span></p>}
        </div>
        {operations.loading && !metrics ? <SkeletonCards count={4} cols={4} /> : metrics && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard title={t('documentOps.title_2')} value={fmtNum(attentionCount)} sub={t('documentOps.sub')} tone={attentionCount ? 'await' : 'idle'} />
            <KpiCard title={t('documentOps.title_3')} value={fmtNum(processingCount)} sub={t('documentOps.sub_2')} tone={processingCount ? 'info' : 'idle'} />
            <KpiCard title={t('documentOps.title_4')} value={fmtNum(failureCount)} sub={t('documentOps.sub_3')} tone={failureCount ? 'alert' : 'idle'} />
            <KpiCard title={t('documentOps.kpiCompleted')} value={fmtNum(metrics.documents_completed)} sub={t('documentOps.lastNDays', { days: windowDays })} tone="done" />
          </div>
        )}
        {operations.error && <Note tone="alert" role="alert">{operations.error}</Note>}
      </section>

      <Card className="space-y-4" as="section" aria-labelledby="consolidated-invoices-title">
        <div>
          <h2 id="consolidated-invoices-title" className="section-title">{t('documentOps.text_21')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('documentOps.text_22')}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link className="btn-primary w-full sm:w-auto" to="/documents/consolidated-invoices">
            <Camera size={ICON.sm} aria-hidden="true" /> {t('documentOps.photographDocuments')}
          </Link>
          <Link className="btn-secondary w-full sm:w-auto" to="/documents/consolidated-invoices">
            <Upload size={ICON.sm} aria-hidden="true" /> {t('documentOps.uploadDocuments')}
          </Link>
          <Link className="btn-secondary w-full sm:w-auto" to="/documents/consolidated-invoices">
            <FileSearch size={ICON.sm} aria-hidden="true" /> {t('documentOps.viewMatches')}
          </Link>
        </div>
      </Card>

      {/* `note-alert`, not a hand-rolled box. The previous markup asked for `border-alert/30` and
          `text-alert`, and there is no `--color-alert` token in @theme — only the six surfaces
          `alert-wash|line|soft|on-soft|fg|solid`. Both classes resolved to nothing, so the most
          urgent item on the screen rendered with no border and with inherited text colour. The
          triangle keeps the meaning off colour alone (WCAG 2.1 AA). */}
      {currentIssue && (
        <section aria-labelledby="document-control-attention-title"
          className="note-alert flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p id="document-control-attention-title" className="flex items-center gap-1.5 text-xs font-semibold">
              <AlertTriangle size={ICON.xs} aria-hidden="true" /> {t('documentOps.mostUrgentItem')}
            </p>
            <h2 className="mt-1 truncate text-lg font-semibold text-ink"><bdi>{currentIssue.file_name}</bdi></h2>
            <p className="mt-1">{(() => {
              const key = attemptUiStatus(currentIssue).descriptionKey;
              return key ? t(key) : null;
            })()}</p>
          </div>
          <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
            {canRecoverStuck && attemptUiStatus(currentIssue).state === 'stuck' && (
              <button type="button" className="btn-primary w-full sm:w-auto" onClick={() => setRecoveryTarget(currentIssue)}>
                <RefreshCw size={ICON.sm} aria-hidden="true" /> {t('documentOps.recoverProcessing')}
              </button>
            )}
            <button type="button" className="btn-secondary w-full sm:w-auto"
              onClick={() => navigate(`/documents/${encodeURIComponent(currentIssue.document_id)}/review`)}>
              <FileSearch size={ICON.sm} aria-hidden="true" /> {t('documentOps.openDocument')}
            </button>
          </div>
        </section>
      )}

      <section aria-labelledby="document-control-recent-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="document-control-recent-title" className="section-title">{t('documentOps.text_23')}</h2>
          {attempts.fetching && attempts.data && <span className="text-xs text-ink-muted" role="status">{t('documentOps.text_24')}</span>}
        </div>
        {attempts.loading && !attempts.data ? <SkeletonTable title={false} cols={4} /> : (
          <DataTable rows={filteredAttempts} columns={attemptColumns} searchable pageSize={20}
            tableLabel={t('documentOps.tableLabel')}
            searchLabel={t('documentOps.searchLabel')}
            searchFn={(row, query) => row.file_name.toLocaleLowerCase('he').includes(query)}
            error={attempts.error}
            activeFilters={filter === 'all' ? 0 : 1}
            onClearFilters={() => setFilter('all')}
            emptyTitle={t('documentOps.emptyTitle')}
            emptySubtitle={filter === 'all' ? t('documentOps.text_25') : t('documentOps.text_26')}
            toolbar={
              <select className="input w-auto!" aria-label={t('documentOps.aria_label_3')} value={filter}
                onChange={(event) => setFilter(event.target.value as AttemptFilter)}>
                <option value="all">{t('documentOps.text_27')}</option>
                <option value="attention">{t('documentOps.text_28')}</option>
                <option value="processing">{t('documentOps.text_29')}</option>
                <option value="completed">{t('documentOps.text_30')}</option>
              </select>
            }
            onRowClick={(row) => navigate(`/documents/${encodeURIComponent(row.document_id)}/review`)}
            rowLabel={(row) => t('documentOps.documentRowLabel', { file: row.file_name })}
            // One icon per meaning across the document screens: `FileSearch` opens the review
            // workspace, `RefreshCw` sends a document through processing again. `Eye` is reserved
            // for viewing the ORIGINAL file (DocumentsInbox: „צפייה במקור"), and `RotateCcw` for
            // undoing an automatic decision — neither of which is what these three do.
            rowActions={(row) => [
              { key: 'review', label: t('documentOps.openReview'), icon: FileSearch, onSelect: () => navigate(`/documents/${encodeURIComponent(row.document_id)}/review`) },
              { key: 'recover', label: t('documentOps.attemptUiStatus'), icon: RefreshCw, hidden: !canRecoverStuck || attemptUiStatus(row).state !== 'stuck', onSelect: () => setRecoveryTarget(row) },
              { key: 'reprocess', label: row.status === 'failed' ? t('documentOps.isActiveAttempt') : t('documentOps.isActiveAttempt_2'), icon: RefreshCw, hidden: !canWrite || isActiveAttempt(row), onSelect: () => setReprocessTarget(row) },
            ]}
          />
        )}
      </section>

      <section aria-labelledby="document-control-price-title" className="space-y-3">
        <h2 id="document-control-price-title" className="section-title">{t('documentOps.text_31')}</h2>
        {priceReviews.loading && !priceReviews.data ? <SkeletonTable title={false} cols={4} /> : (
          <DataTable rows={priceReviews.data ?? []} columns={priceReviewColumns} pageSize={10}
            tableLabel={t('documentOps.tableLabel_2')}
            error={priceReviews.error}
            emptyTitle={t('documentOps.emptyTitle_2')}
            emptySubtitle={t('documentOps.emptySubtitle')}
            onRowClick={(row) => navigate(`/documents/${encodeURIComponent(row.document_id)}/review`)}
            rowLabel={(row) => t('documentOps.priceReviewRowLabel', { file: row.file_name })}
            rowActions={(row) => [{
              key: 'review-price-list', label: t('documentOps.text_32'), icon: FileSearch,
              onSelect: () => navigate(`/documents/${encodeURIComponent(row.document_id)}/review`),
            }]}
          />
        )}
      </section>

      {/* Both confirmations stay: a document already handed to the queue cannot be pulled back out,
          and the recovery Edge call has no inverse. What went is the reason textarea — nobody
          investigating a requeue learns anything from a box the operator filled to get past it, and
          the ledger keeps a truthful sentence either way (#299). */}
      <ConfirmDialog open={canWrite && reprocessTarget !== null} onClose={() => setReprocessTarget(null)}
        onConfirm={() => void reprocess()} busy={reprocessing}
        title={t('documentOps.title_5')} message={t('documentOps.message')}
        confirmLabel={t('documentOps.confirmLabel')} />
      <ConfirmDialog open={canRecoverStuck && recoveryTarget !== null} onClose={() => setRecoveryTarget(null)}
        onConfirm={() => void recoverStuck()} busy={recovering}
        title={t('documentOps.title_6')} message={t('documentOps.message_2')}
        confirmLabel={t('documentOps.confirmLabel_2')} />
    </div>
  );
}

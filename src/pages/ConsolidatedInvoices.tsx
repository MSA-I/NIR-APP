import type { TKey } from '../lib/i18n/t';
import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, FileCheck2, RefreshCw, Upload } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { documentUploadMimeType, DOCUMENT_UPLOAD_ACCEPT } from '../components/FileUpload';
import { SupplierSelectField, useQuickSupplier } from '../components/QuickSupplierPicker';
import { enqueueUploadCenterBatch } from '../components/UploadCenter';
import {
  DataTable,
  ErrorNote,
  Note,
  PageHeader,
  SkeletonTable,
  Card,
  ICON,
  useToast,
  type Column,
} from '../components/ui';
import {
  completeConsolidatedInvoiceIntake,
  consolidatedPageStatusLabel,
  consolidatedPageTypeLabel,
  consolidatedStatusLabel,
  consolidatedStatusTone,
  consolidatedWarningLabel,
  getConsolidatedInvoiceWorkspace,
  listConsolidatedInvoiceCases,
  listConsolidatedInvoiceLegalEntities,
  matchChannelLabel,
  matchGroupLabel,
  openConsolidatedInvoiceIntake,
  previousJerusalemMonth,
  refreshConsolidatedInvoiceReconciliation,
  uploadConsolidatedInvoicePage,
  type ConsolidatedInvoiceCaseSummary,
  type ConsolidatedInvoiceMatchLine,
  type ConsolidatedInvoiceSource,
  type ConsolidatedInvoiceWorkspace,
  type ConsolidatedMatchChannel,
  type ConsolidatedPageResume,
} from '../lib/consolidatedInvoices';
import { fmtDate, fmtDateTime, fmtMoneyExact, fmtNum } from '../lib/format';
import { INVOICE_REVIEW_STATUS, RECEIPT_STATUS } from '../lib/status';
import { supabase } from '../lib/supabase';
import { fetchAll } from '../lib/supabasePaging';
import { unwrap, useQuery } from '../lib/useQuery';

type CaseRow = ConsolidatedInvoiceCaseSummary & { id: string };
type SourceRow = ConsolidatedInvoiceSource & { id: string };
type MatchRow = ConsolidatedInvoiceMatchLine & { id: string };

interface ActiveIntake {
  intakeId: string;
  caseId: string;
  completeKey: string;
}

function statusBadge(status: ConsolidatedInvoiceCaseSummary['status']) {
  return <span className={`badge-${consolidatedStatusTone(status)}`}>{consolidatedStatusLabel(status)}</span>;
}

function sourceTypeLabel(source: ConsolidatedInvoiceSource, t: (key: TKey, vars?: Record<string, string | number>) => string) {
  if (source.source_type === 'interim_invoice') return t('consolidated.sourceInterimInvoice');
  if (source.source_type === 'goods_receipt') return t('consolidated.sourceGoodsReceipt');
  if (source.status === 'filed_as_invoice') return t('consolidated.sourceFiledAsInvoice');
  if (source.status === 'filed_as_goods_receipt') return t('consolidated.sourceFiledAsReceipt');
  return t('consolidated.sourcePendingFiling');
}

function sourceStatusLabel(
  source: ConsolidatedInvoiceSource,
  statusLabel: (meta: { key: string } | null | undefined) => string,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
) {
  if (source.late_arrival) return <span className="badge-await">{t('consolidated.sourceLateArrival')}</span>;
  if (source.status === 'filed_as_invoice') return t('consolidated.statusFiledAsInvoice');
  if (source.status === 'filed_as_goods_receipt') return t('consolidated.statusFiledAsReceipt');
  if (source.status === 'pending_evidence') return t('consolidated.statusPendingFiling');
  return statusLabel(INVOICE_REVIEW_STATUS[source.status])
    || statusLabel(RECEIPT_STATUS[source.status])
    || source.status;
}

function compactNumber(value: number | null) {
  return <span className="num" dir="ltr">{fmtNum(value)}</span>;
}

function money(value: number | null) {
  return <span className="num" dir="ltr">{fmtMoneyExact(value)}</span>;
}

const matchChannels: readonly ConsolidatedMatchChannel[] = [
  'anchor_vs_interim',
  'anchor_vs_receipts',
  'interim_vs_receipts',
];

export default function ConsolidatedInvoices() {
  const { errorText, t } = useT();
  const { profile, organizationAccess } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const month = useMemo(() => previousJerusalemMonth(), []);
  const caseId = params.get('case');
  const canWrite = organizationAccess.canWrite && (profile?.role === 'owner' || profile?.role === 'office');
  const [supplierId, setSupplierId] = useState('');
  const [legalEntityId, setLegalEntityId] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [activeIntake, setActiveIntake] = useState<ActiveIntake | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const pageResumes = useRef(new Map<number, ConsolidatedPageResume>());

  const cases = useQuery(
    () => listConsolidatedInvoiceCases(month.value),
    [month.value],
  );
  const workspace = useQuery<ConsolidatedInvoiceWorkspace | null>(
    () => (caseId ? getConsolidatedInvoiceWorkspace(caseId) : Promise.resolve(null)),
    [caseId],
  );
  const suppliers = useQuery(async () => {
    if (!canWrite) return [];
    return fetchAll<{ id: string; name: string }>((from, to) => supabase.from('suppliers')
      .select('id, name').is('deleted_at', null).order('name').order('id').range(from, to));
  }, [canWrite]);
  const legalEntities = useQuery(
    () => (canWrite ? listConsolidatedInvoiceLegalEntities() : Promise.resolve([])),
    [canWrite],
  );
  const supplierPicker = useQuickSupplier(suppliers.data, setSupplierId);

  useEffect(() => {
    if (!legalEntityId && legalEntities.data?.length === 1) setLegalEntityId(legalEntities.data[0]!.id);
  }, [legalEntities.data, legalEntityId]);

  const selectedSupplierName = supplierPicker.suppliers.find((supplier) => supplier.id === supplierId)?.name ?? null;

  async function runIntake(files: File[], existing: ActiveIntake | null) {
    if (!profile || !canWrite || !supplierId || !legalEntityId || !files.length || busy) return;
    setBusy(true);
    setUploadError(null);
    try {
      const mimeTypes = files.map(documentUploadMimeType);
      const intake = existing ?? await (async () => {
        const opened = await openConsolidatedInvoiceIntake({
          supplierId,
          targetMonth: month.value,
          legalEntityId,
          pageCount: files.length,
          idempotencyKey: crypto.randomUUID(),
        });
        const next = { intakeId: opened.intake_id, caseId: opened.case_id, completeKey: crypto.randomUUID() };
        setActiveIntake(next);
        return next;
      })();

      const items = files.map((file, index) => ({ file, pageNumber: index + 1, mimeType: mimeTypes[index]! }));
      const batch = await enqueueUploadCenterBatch(items, async (item, context) => {
        const resume = pageResumes.current.get(item.pageNumber) ?? {
          clientUploadKey: crypto.randomUUID(),
          storagePath: null,
          documentId: null,
        };
        pageResumes.current.set(item.pageNumber, resume);
        const uploaded = await uploadConsolidatedInvoicePage({
          orgId: profile.org_id,
          intakeId: intake.intakeId,
          pageNumber: item.pageNumber,
          file: item.file,
          mimeType: item.mimeType,
          resume,
          onProgress: context.onProgress,
          registerAbort: context.registerAbort,
          onStored: () => context.markStored(),
          onResume: (next) => pageResumes.current.set(item.pageNumber, next),
        });
        context.markRegistered(uploaded.registration.document_id);
      }, {
        source: t('consolidated.text'),
        supplierName: selectedSupplierName,
        describe: (item) => ({ name: item.file.name, type: item.mimeType, size: item.file.size }),
        classifyFailure: (_item, error) => ({
          message: errorText(error),
          retryable: false,
          storedSafely: error instanceof Error && /register_consolidated_invoice_page/i.test(error.message),
        }),
      });

      if (batch.failed.length > 0) {
        const message = batch.failed.length === files.length
          ? t('consolidated.text_2')
          : t('consolidated.pagesFailed', { count: fmtNum(batch.failed.length) });
        setUploadError(message);
        return;
      }

      const completed = await completeConsolidatedInvoiceIntake({
        intakeId: intake.intakeId,
        idempotencyKey: intake.completeKey,
      });
      setActiveIntake(null);
      setSelectedFiles([]);
      pageResumes.current.clear();
      toast(t('consolidated.pagesReceived', { count: fmtNum(completed.source_page_count) }));
      setParams({ case: completed.case_id }, { replace: true });
      void cases.refetch();
    } catch (error) {
      setUploadError(errorText(error));
    } finally {
      setBusy(false);
      if (captureRef.current) captureRef.current.value = '';
      if (uploadRef.current) uploadRef.current.value = '';
    }
  }

  function receiveFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setSelectedFiles(files);
    setActiveIntake(null);
    pageResumes.current.clear();
    void runIntake(files, null);
  }

  async function refreshWorkspace() {
    if (!caseId || !canWrite || refreshing) return;
    setRefreshing(true);
    try {
      await refreshConsolidatedInvoiceReconciliation({
        caseId,
        idempotencyKey: crypto.randomUUID(),
        reason: t('consolidated.text_3'),
      });
      toast(t('consolidated.toast'));
      void workspace.refetch();
      void cases.refetch();
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setRefreshing(false);
    }
  }

  const caseRows: CaseRow[] = (cases.data ?? []).map((row) => ({ ...row, id: row.case_id }));
  const caseColumns: Column<CaseRow>[] = [
    { key: 'supplier', header: t('consolidated.text_4'), priority: 1, render: (row) => <span className="font-medium">{row.supplier_name}</span> },
    { key: 'month', header: t('consolidated.text_5'), priority: 1, render: () => month.label },
    { key: 'status', header: t('consolidated.statusBadge'), priority: 1, render: (row) => statusBadge(row.status) },
    { key: 'warnings', header: t('consolidated.fmtNum'), priority: 2, render: (row) => <span className="num">{fmtNum(row.warning_count)}</span> },
    { key: 'updated', header: t('consolidated.fmtDateTime'), priority: 2, render: (row) => <span className="num">{fmtDateTime(row.updated_at)}</span> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('consolidated.title')}
        meta={t('consolidated.meta')}
        actions={caseId ? <button type="button" className="btn-secondary min-h-11" onClick={() => navigate('/documents/consolidated-invoices')}>{t('consolidated.navigate')}</button> : undefined}
      />

      {canWrite && (
        <Card as="section" aria-labelledby="consolidated-intake-title" className="space-y-4">
          <div>
            <h2 id="consolidated-intake-title" className="section-title">{t('consolidated.text_6')}</h2>
            <p className="mt-1 text-sm text-ink-soft">{t('consolidated.text_7')}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <SupplierSelectField picker={supplierPicker} id="consolidated-supplier" label={t('consolidated.label')}
              value={supplierId} placeholder={suppliers.loading ? t('consolidated.text_8') : t('consolidated.text_9')} disabled={busy || !!suppliers.error} />
            <div>
              <label className="label" htmlFor="consolidated-legal-entity">{t('consolidated.text_10')}</label>
              <select id="consolidated-legal-entity" className="input" value={legalEntityId}
                disabled={busy || legalEntities.loading || !!legalEntities.error}
                onChange={(event) => setLegalEntityId(event.target.value)}>
                <option value="">{t('consolidated.text_11')}</option>
                {(legalEntities.data ?? []).map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
              </select>
            </div>
            <div>
              <span className="label">{t('consolidated.text_12')}</span>
              <div className="input flex min-h-11 items-center bg-surface-sunken font-medium" aria-label={t('consolidated.lockedMonthLabel', { month: month.label })}>
                {month.label}
              </div>
              <p className="mt-1 text-xs text-ink-muted">{t('consolidated.text_13')}</p>
            </div>
          </div>
          {(suppliers.error || legalEntities.error) && <ErrorNote message={suppliers.error ?? legalEntities.error ?? t('consolidated.text_14')} />}
          {!legalEntities.loading && !legalEntities.error && legalEntities.data?.length === 0 && (
            <Note tone="alert">{t('consolidated.text_15')}</Note>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" className="btn-primary min-h-11 w-full sm:w-auto" disabled={busy || !supplierId || !legalEntityId}
              onClick={() => captureRef.current?.click()}>
              <Camera size={ICON.md} aria-hidden="true" /> {t('consolidated.photographDocuments')}
            </button>
            <button type="button" className="btn-secondary min-h-11 w-full sm:w-auto" disabled={busy || !supplierId || !legalEntityId}
              onClick={() => uploadRef.current?.click()}>
              <Upload size={ICON.md} aria-hidden="true" /> {t('consolidated.uploadDocuments')}
            </button>
            <input ref={captureRef} type="file" className="sr-only" accept={DOCUMENT_UPLOAD_ACCEPT} capture="environment" multiple
              aria-label={t('consolidated.aria_label')} onChange={(event) => receiveFiles(event.currentTarget.files)} />
            <input ref={uploadRef} type="file" className="sr-only" accept={DOCUMENT_UPLOAD_ACCEPT} multiple
              aria-label={t('consolidated.aria_label_2')} onChange={(event) => receiveFiles(event.currentTarget.files)} />
          </div>
          <div aria-live="polite" className="text-sm text-ink-soft">
            {busy ? t('consolidated.uploadingPages', { count: fmtNum(selectedFiles.length) }) : null}
          </div>
          {uploadError && (
            <Note tone="alert" role="alert">
              <div className="min-w-0 flex-1 space-y-3">
                <p>{uploadError}</p>
                {activeIntake && selectedFiles.length > 0 && (
                  <button type="button" className="btn-secondary min-h-11" disabled={busy}
                    onClick={() => void runIntake(selectedFiles, activeIntake)}>{t('consolidated.runIntake')}</button>
                )}
              </div>
            </Note>
          )}
        </Card>
      )}

      {!canWrite && (
        <Note tone="idle">{t('consolidated.text_16')}</Note>
      )}

      {caseId ? (
        workspace.loading && !workspace.data ? <SkeletonTable cols={6} />
          : workspace.error ? <ErrorNote message={workspace.error} />
            : workspace.data ? <WorkspaceView
              workspace={workspace.data}
              canWrite={canWrite}
              refreshing={refreshing}
              onRefresh={() => void refreshWorkspace()}
              onReload={() => workspace.refetch()}
            />
              : null
      ) : (
        <section aria-labelledby="consolidated-cases-title" className="space-y-3">
          <div>
            <h2 id="consolidated-cases-title" className="section-title">{t('consolidated.text_17')}</h2>
            <p className="mt-1 text-sm text-ink-soft">{t('consolidated.lockedMonthIntro', { month: month.label })}</p>
          </div>
          {cases.loading && !cases.data ? <SkeletonTable title={false} cols={5} /> : (
            <DataTable rows={caseRows} columns={caseColumns} mobile="cards" searchable
              searchFn={(row, query) => row.supplier_name.toLocaleLowerCase('he').includes(query)}
              searchLabel={t('consolidated.searchLabel')} error={cases.error}
              emptyTitle={t('consolidated.emptyTitle')}
              emptySubtitle={t('consolidated.emptySubtitle')}
              onRowClick={(row) => setParams({ case: row.case_id })}
              rowLabel={(row) => t('consolidated.caseRowLabel', { supplier: row.supplier_name })} />
          )}
        </section>
      )}
    </div>
  );
}

function WorkspaceView({ workspace, canWrite, refreshing, onRefresh, onReload }: {
  workspace: ConsolidatedInvoiceWorkspace;
  canWrite: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onReload: () => Promise<unknown>;
}) {
  const { errorText, statusLabel, t } = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [retryingReview, setRetryingReview] = useState(false);
  const openDocument = async (documentId: string) => {
    try {
      const row = unwrap(await supabase.from('documents').select('storage_path')
        .eq('id', documentId).single()) as { storage_path: string };
      const { data, error } = await supabase.storage.from('documents').createSignedUrl(row.storage_path, 300);
      if (error || !data?.signedUrl) throw error ?? new Error('signed URL missing');
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast(errorText(error), 'error');
    }
  };
  const sourceRows: SourceRow[] = workspace.sources.map((source) => ({ ...source, id: `${source.source_type}:${source.source_id}` }));
  const primaryPage = workspace.pages.find((page) => page.is_primary) ?? workspace.pages[0] ?? null;
  const reviewReason = workspace.intake?.reason_code
    ? consolidatedWarningLabel(workspace.intake.reason_code)
    : t('consolidated.text_18');
  const retryReview = async () => {
    if (!primaryPage?.job_id || retryingReview) return;
    setRetryingReview(true);
    try {
      const response = await supabase.functions.invoke('interpret-document', {
        body: { jobId: primaryPage.job_id },
      });
      if (response.error) throw response.error;
      await onReload();
      toast(t('consolidated.toast_2'));
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setRetryingReview(false);
    }
  };
  const interimTotal = workspace.sources
    .filter((source) => source.source_type === 'interim_invoice')
    .reduce((sum, source) => sum + (source.total_amount ?? 0), 0);
  const receiptTotal = workspace.sources
    .filter((source) => source.source_type === 'goods_receipt')
    .reduce((sum, source) => sum + (source.total_amount ?? 0), 0);
  const sourceColumns: Column<SourceRow>[] = [
    { key: 'type', header: t('consolidated.sourceTypeLabel'), priority: 1, render: (row) => <span className="font-medium">{sourceTypeLabel(row, t)}</span> },
    { key: 'number', header: t('consolidated.text_19'), priority: 1, render: (row) => <span className="num" dir="ltr">{row.document_number ?? '—'}</span> },
    { key: 'date', header: t('consolidated.fmtDate'), priority: 2, render: (row) => <span className="num">{fmtDate(row.document_date)}</span> },
    { key: 'amount', header: t('consolidated.money'), priority: 1, render: (row) => money(row.total_amount) },
    { key: 'status', header: t('consolidated.sourceStatusLabel'), priority: 2, render: (row) => sourceStatusLabel(row, statusLabel, t) },
    { key: 'source', header: t('consolidated.text_20'), priority: 1, render: (row) => row.document_id
      ? <button type="button" className="btn-secondary min-h-11" onClick={(event) => { event.stopPropagation(); void openDocument(row.document_id!); }}>{t('consolidated.stopPropagation')}</button>
      : <span className="text-ink-muted">{t('consolidated.text_21')}</span> },
  ];

  return (
    <section aria-labelledby="consolidated-workspace-title" className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="consolidated-workspace-title" className="section-title">{workspace.case.supplier_name} · {workspace.case.legal_entity_name}</h2>
            {statusBadge(workspace.case.status)}
          </div>
          <p className="mt-1 text-sm text-ink-soft">{fmtDate(workspace.case.target_month)} · {t('consolidated.matchVersion')} <span className="num">{fmtNum(workspace.case.current_revision)}</span></p>
        </div>
        {canWrite && workspace.anchor && (
          <button type="button" className="btn-secondary min-h-11" disabled={refreshing} onClick={onRefresh}>
            <RefreshCw size={ICON.sm} aria-hidden="true" className={refreshing ? 'animate-spin ' : ''} /> {t('consolidated.refreshMatch')}
          </button>
        )}
      </div>

      {workspace.case.status === 'needs_review' && (
        <Note tone="await" role="status">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t('consolidated.text_22')}</p>
            <p className="mt-1">{reviewReason}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {primaryPage?.job_id && canWrite && (
                <button type="button" className="btn-primary min-h-11"
                  disabled={retryingReview} onClick={() => void retryReview()}>
                    <RefreshCw size={ICON.sm} aria-hidden="true" className={retryingReview ? 'animate-spin ' : ''} />
                  {t('consolidated.text_23')}
                </button>
              )}
              {primaryPage && (
                <button type="button" className="btn-secondary min-h-11"
                  onClick={() => navigate(`/documents/${primaryPage.document_id}/review`)}>
                  {t('consolidated.text_24')}
                </button>
              )}
            </div>
          </div>
        </Note>
      )}
      {workspace.case.status === 'blocked' && (
        <Note tone="alert" role="alert">
          <p className="font-medium">{t('consolidated.text_25')}</p>
          <p className="mt-1">{reviewReason}</p>
        </Note>
      )}
      {workspace.pages.length > 0 && (
        <Card as="section" aria-labelledby="consolidated-pages-title" className="space-y-3">
          <h3 id="consolidated-pages-title" className="section-title">{t('consolidated.text_26')}</h3>
          <ul className="divide-y divide-line-soft">
            {workspace.pages.map((page) => (
              <li key={page.document_id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">{t('consolidated.pageWord')} {fmtNum(page.page_number)} · {page.file_name}</p>
                  <p className="mt-1 text-sm text-ink-soft">
                    {page.is_primary ? t('consolidated.text_27') : t('consolidated.text_28')} ·
                    {' '}{consolidatedPageTypeLabel(page.document_type)} · {consolidatedPageStatusLabel(page.job_status)}
                  </p>
                </div>
                <button type="button" className="btn-secondary min-h-11"
                  onClick={() => navigate(`/documents/${page.document_id}/review`)}>
                  {t('consolidated.text_29')}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {workspace.warnings.length > 0 && (
        <Note tone="await" role="status">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t('consolidated.warningsFound', { count: fmtNum(workspace.warnings.length) })}</p>
            <ul className="mt-2 list-disc space-y-1 ps-5">
              {workspace.warnings.map((warning, index) => <li key={`${warning.code}:${warning.source_id ?? index}`}>{consolidatedWarningLabel(warning.code)}</li>)}
            </ul>
          </div>
        </Note>
      )}

      <Card pad={false} clip>
        <dl className="grid grid-cols-1 divide-y divide-line-soft sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:divide-x-reverse">
          <div className="p-4"><dt className="text-xs text-ink-muted">{t('consolidated.money_2')}</dt><dd className="mt-1 text-lg font-semibold">{money(workspace.anchor?.total_amount ?? null)}</dd></div>
          <div className="p-4"><dt className="text-xs text-ink-muted">{t('consolidated.money_3')}</dt><dd className="mt-1 text-lg font-semibold">{money(interimTotal)}</dd></div>
          <div className="p-4"><dt className="text-xs text-ink-muted">{t('consolidated.money_4')}</dt><dd className="mt-1 text-lg font-semibold">{money(receiptTotal)}</dd></div>
        </dl>
      </Card>

      <Card as="section" aria-labelledby="consolidated-anchor-title" className="space-y-3">
        <div className="flex items-center gap-2">
          <FileCheck2 size={ICON.md} className="text-action" aria-hidden="true" />
          <h3 id="consolidated-anchor-title" className="section-title">{t('consolidated.text_30')}</h3>
        </div>
        {workspace.anchor ? (
          <div className="space-y-4">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs text-ink-muted">{t('consolidated.text_31')}</dt><dd className="num mt-1 font-medium" dir="ltr">{workspace.anchor.invoice_number}</dd></div>
            <div><dt className="text-xs text-ink-muted">{t('consolidated.fmtDate_2')}</dt><dd className="num mt-1 font-medium">{fmtDate(workspace.anchor.invoice_date)}</dd></div>
            <div><dt className="text-xs text-ink-muted">{t('consolidated.money_5')}</dt><dd className="mt-1 font-medium">{money(workspace.anchor.amount_before_vat)}</dd></div>
            <div><dt className="text-xs text-ink-muted">{t('consolidated.money_6')}</dt><dd className="mt-1 font-medium">{money(workspace.anchor.total_amount)}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-2">
            {workspace.anchor.document_ids.map((documentId, index) => (
              <button key={documentId} type="button" className="btn-secondary min-h-11"
                onClick={() => void openDocument(documentId)}>{t('consolidated.viewPage')} {fmtNum(index + 1)}</button>
            ))}
          </div>
          </div>
        ) : <Note tone="idle">{t('consolidated.text_32')}</Note>}
      </Card>

      <section aria-labelledby="consolidated-sources-title" className="space-y-3">
        <div>
          <h3 id="consolidated-sources-title" className="section-title">{t('consolidated.text_33')}</h3>
          <p className="mt-1 text-sm text-ink-soft">{t('consolidated.text_34')}</p>
        </div>
        <DataTable rows={sourceRows} columns={sourceColumns} mobile="cards" pageSize={10}
          emptyTitle={t('consolidated.emptyTitle_2')} emptySubtitle={t('consolidated.emptySubtitle_2')} />
      </section>

      {matchChannels.map((channel) => (
        <ReconciliationTable key={channel} channel={channel} lines={workspace.reconciliation[channel]} />
      ))}
    </section>
  );
}

function ReconciliationTable({ channel, lines }: { channel: ConsolidatedMatchChannel; lines: ConsolidatedInvoiceMatchLine[] }) {
  const { t } = useT();
  const rows: MatchRow[] = lines.map((line, index) => ({ ...line, id: `${channel}:${index}:${line.product_id ?? 'unknown'}` }));
  const columns: Column<MatchRow>[] = [
    { key: 'result', header: t('consolidated.matchGroupLabel'), priority: 1, render: (row) => <span className={row.result === 'matched' ? 'badge-done' : 'badge-await'}>{matchGroupLabel(row.result)}</span> },
    {
      key: 'product', header: t('consolidated.text_35'), priority: 1,
      render: (row) => (
        <div className="min-w-40">
          <div className="font-medium"><bdi>{row.product_name ?? t('consolidated.text_36')}</bdi></div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-muted" dir="ltr">
            {row.supplier_sku && <span>SKU {row.supplier_sku}</span>}
            {row.barcode && <span>{row.barcode}</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'quantities', header: t('consolidated.text_37'), priority: 1,
      render: (row) => <span className="flex min-w-36 flex-col text-xs"><span>{t('consolidated.anchorWord')} {compactNumber(row.anchor_quantity)}</span><span>{t('consolidated.interimWord')} {compactNumber(row.interim_quantity)}</span><span>{t('consolidated.receivedWord')} {compactNumber(row.received_quantity)}</span></span>,
    },
    {
      key: 'prices', header: t('consolidated.text_38'), priority: 2,
      render: (row) => <span className="flex min-w-36 flex-col text-xs"><span>{t('consolidated.anchorWord')} {money(row.anchor_unit_price)}</span><span>{t('consolidated.interimWord')} {money(row.interim_unit_price)}</span></span>,
    },
    {
      key: 'amounts', header: t('consolidated.text_39'), priority: 2,
      render: (row) => <span className="flex min-w-36 flex-col text-xs"><span>{t('consolidated.anchorWord')} {money(row.anchor_amount)}</span><span>{t('consolidated.interimWord')} {money(row.interim_amount)}</span></span>,
    },
    {
      key: 'difference', header: t('consolidated.text_40'), priority: 1,
      render: (row) => <span className="flex min-w-28 flex-col text-xs"><span>{t('consolidated.quantityWord')} {compactNumber(row.difference_quantity)}</span><span>{t('consolidated.amountWord')} {money(row.difference_amount)}</span></span>,
    },
  ];
  return (
    <section aria-labelledby={`match-${channel}`} className="space-y-3">
      <div>
        <h3 id={`match-${channel}`} className="section-title">{matchChannelLabel(channel)}</h3>
        <p className="mt-1 text-sm text-ink-soft">{t('consolidated.text_41')}</p>
      </div>
      <DataTable rows={rows} columns={columns} mobile="cards" pageSize={15}
        emptyTitle={t('consolidated.emptyTitle_3')} emptySubtitle={t('consolidated.emptySubtitle_3')} />
    </section>
  );
}

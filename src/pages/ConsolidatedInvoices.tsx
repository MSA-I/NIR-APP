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
import { toHebrewError } from '../lib/errors';
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

function sourceTypeLabel(source: ConsolidatedInvoiceSource) {
  if (source.source_type === 'interim_invoice') return 'חשבונית ביניים';
  if (source.source_type === 'goods_receipt') return 'קבלת סחורה';
  if (source.status === 'filed_as_invoice') return 'מסמך תומך שתויק כחשבונית ביניים';
  if (source.status === 'filed_as_goods_receipt') return 'מסמך תומך שתויק כקבלת סחורה';
  return 'מסמך תומך שממתין לתיוק';
}

function sourceStatusLabel(source: ConsolidatedInvoiceSource) {
  if (source.late_arrival) return <span className="badge-await">מסמך מאוחר</span>;
  if (source.status === 'filed_as_invoice') return 'תויק כחשבונית ביניים';
  if (source.status === 'filed_as_goods_receipt') return 'תויק כקבלת סחורה';
  if (source.status === 'pending_evidence') return 'ממתין לתיוק';
  return INVOICE_REVIEW_STATUS[source.status]?.label ?? RECEIPT_STATUS[source.status]?.label ?? source.status;
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
        source: 'חשבונית מרכזת',
        supplierName: selectedSupplierName,
        describe: (item) => ({ name: item.file.name, type: item.mimeType, size: item.file.size }),
        classifyFailure: (_item, error) => ({
          message: toHebrewError(error),
          retryable: false,
          storedSafely: error instanceof Error && /register_consolidated_invoice_page/i.test(error.message),
        }),
      });

      if (batch.failed.length > 0) {
        const message = batch.failed.length === files.length
          ? 'העלאת העמודים לא הושלמה. אפשר לנסות שוב בלי ליצור פעולה חדשה.'
          : `${fmtNum(batch.failed.length)} עמודים לא הושלמו. אפשר לנסות שוב מאותה נקודה.`;
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
      toast(`${fmtNum(completed.source_page_count)} עמודים נקלטו כחשבונית מרכזת אחת.`);
      setParams({ case: completed.case_id }, { replace: true });
      void cases.refetch();
    } catch (error) {
      setUploadError(toHebrewError(error));
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
        reason: 'רענון ידני מסביבת ההתאמה',
      });
      toast('נוצרה גרסת התאמה מעודכנת.');
      void workspace.refetch();
      void cases.refetch();
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setRefreshing(false);
    }
  }

  const caseRows: CaseRow[] = (cases.data ?? []).map((row) => ({ ...row, id: row.case_id }));
  const caseColumns: Column<CaseRow>[] = [
    { key: 'supplier', header: 'ספק', priority: 1, render: (row) => <span className="font-medium">{row.supplier_name}</span> },
    { key: 'month', header: 'חודש', priority: 1, render: () => month.label },
    { key: 'status', header: 'מצב', priority: 1, render: (row) => statusBadge(row.status) },
    { key: 'warnings', header: 'אזהרות', priority: 2, render: (row) => <span className="num">{fmtNum(row.warning_count)}</span> },
    { key: 'updated', header: 'עדכון', priority: 2, render: (row) => <span className="num">{fmtDateTime(row.updated_at)}</span> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="חשבוניות מרכזות"
        meta="חשבונית ספק אחת מרכזת את מסמכי אותו ספק בחודש הקודם ומשמשת כעוגן החוב היחיד."
        actions={caseId ? <button type="button" className="btn-secondary min-h-11" onClick={() => navigate('/documents/consolidated-invoices')}>כל תיקי ההתאמה</button> : undefined}
      />

      {canWrite && (
        <Card as="section" aria-labelledby="consolidated-intake-title" className="space-y-4">
          <div>
            <h2 id="consolidated-intake-title" className="section-title">קליטת חשבונית מרכזת</h2>
            <p className="mt-1 text-sm text-ink-soft">בחרו ספק וישות משפטית, ואז צלמו או העלו את כל עמודי החשבונית בפעולה אחת.</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <SupplierSelectField picker={supplierPicker} id="consolidated-supplier" label="ספק קנוני *"
              value={supplierId} placeholder={suppliers.loading ? 'טוען ספקים…' : 'בחירת ספק'} disabled={busy || !!suppliers.error} />
            <div>
              <label className="label" htmlFor="consolidated-legal-entity">ישות משפטית *</label>
              <select id="consolidated-legal-entity" className="input" value={legalEntityId}
                disabled={busy || legalEntities.loading || !!legalEntities.error}
                onChange={(event) => setLegalEntityId(event.target.value)}>
                <option value="">בחירת ישות משפטית</option>
                {(legalEntities.data ?? []).map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
              </select>
            </div>
            <div>
              <span className="label">חודש החשבונית</span>
              <div className="input flex min-h-11 items-center bg-surface-sunken font-medium" aria-label={`חודש נעול: ${month.label}`}>
                {month.label}
              </div>
              <p className="mt-1 text-xs text-ink-muted">החודש הקלנדרי הקודם לפי שעון ישראל; לא ניתן לשינוי.</p>
            </div>
          </div>
          {(suppliers.error || legalEntities.error) && <ErrorNote message={suppliers.error ?? legalEntities.error ?? 'שגיאה בטעינת אפשרויות הקליטה'} />}
          {!legalEntities.loading && !legalEntities.error && legalEntities.data?.length === 0 && (
            <Note tone="alert">לא נמצאה ישות משפטית מורשית לקליטה.</Note>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" className="btn-primary min-h-11 w-full sm:w-auto" disabled={busy || !supplierId || !legalEntityId}
              onClick={() => captureRef.current?.click()}>
              <Camera size={ICON.md} aria-hidden="true" /> צילום מסמכים
            </button>
            <button type="button" className="btn-secondary min-h-11 w-full sm:w-auto" disabled={busy || !supplierId || !legalEntityId}
              onClick={() => uploadRef.current?.click()}>
              <Upload size={ICON.md} aria-hidden="true" /> העלאת מסמכים
            </button>
            <input ref={captureRef} type="file" className="sr-only" accept={DOCUMENT_UPLOAD_ACCEPT} capture="environment" multiple
              aria-label="צילום עמודי חשבונית מרכזת" onChange={(event) => receiveFiles(event.currentTarget.files)} />
            <input ref={uploadRef} type="file" className="sr-only" accept={DOCUMENT_UPLOAD_ACCEPT} multiple
              aria-label="העלאת עמודי חשבונית מרכזת" onChange={(event) => receiveFiles(event.currentTarget.files)} />
          </div>
          <div aria-live="polite" className="text-sm text-ink-soft">
            {busy ? `מעלה ${fmtNum(selectedFiles.length)} עמודים תחת חשבונית מרכזת אחת…` : null}
          </div>
          {uploadError && (
            <Note tone="alert" role="alert">
              <div className="min-w-0 flex-1 space-y-3">
                <p>{uploadError}</p>
                {activeIntake && selectedFiles.length > 0 && (
                  <button type="button" className="btn-secondary min-h-11" disabled={busy}
                    onClick={() => void runIntake(selectedFiles, activeIntake)}>ניסיון נוסף מאותה נקודה</button>
                )}
              </div>
            </Note>
          )}
        </Card>
      )}

      {!canWrite && (
        <Note tone="idle">הגישה שלך היא לצפייה בתיקי ההתאמה שנקלטו. צילום והעלאה זמינים לבעלים ולמשרד.</Note>
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
            <h2 id="consolidated-cases-title" className="section-title">תיקי ספק–חודש</h2>
            <p className="mt-1 text-sm text-ink-soft">החודש הנעול: {month.label}. פתיחת תיק מציגה את העוגן, המקורות והפערים ברמת מוצר.</p>
          </div>
          {cases.loading && !cases.data ? <SkeletonTable title={false} cols={5} /> : (
            <DataTable rows={caseRows} columns={caseColumns} mobile="cards" searchable
              searchFn={(row, query) => row.supplier_name.toLocaleLowerCase('he').includes(query)}
              searchLabel="חיפוש תיק לפי ספק" error={cases.error}
              emptyTitle="אין עדיין חשבוניות מרכזות לחודש זה"
              emptySubtitle="לאחר צילום או העלאה, תיק הספק וההתאמות יופיעו כאן."
              onRowClick={(row) => setParams({ case: row.case_id })}
              rowLabel={(row) => `תיק ההתאמה של ${row.supplier_name}`} />
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
      toast(toHebrewError(error), 'error');
    }
  };
  const sourceRows: SourceRow[] = workspace.sources.map((source) => ({ ...source, id: `${source.source_type}:${source.source_id}` }));
  const primaryPage = workspace.pages.find((page) => page.is_primary) ?? workspace.pages[0] ?? null;
  const reviewReason = workspace.intake?.reason_code
    ? consolidatedWarningLabel(workspace.intake.reason_code)
    : 'צריך לבדוק את המסמך לפני יצירת חוב.';
  const retryReview = async () => {
    if (!primaryPage?.job_id || retryingReview) return;
    setRetryingReview(true);
    try {
      const response = await supabase.functions.invoke('interpret-document', {
        body: { jobId: primaryPage.job_id },
      });
      if (response.error) throw response.error;
      await onReload();
      toast('המסמך נבדק מחדש מול כללי המרכזת המעודכנים.');
    } catch (error) {
      toast(toHebrewError(error), 'error');
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
    { key: 'type', header: 'מקור', priority: 1, render: (row) => <span className="font-medium">{sourceTypeLabel(row)}</span> },
    { key: 'number', header: 'מספר', priority: 1, render: (row) => <span className="num" dir="ltr">{row.document_number ?? '—'}</span> },
    { key: 'date', header: 'תאריך', priority: 2, render: (row) => <span className="num">{fmtDate(row.document_date)}</span> },
    { key: 'amount', header: 'סכום', priority: 1, render: (row) => money(row.total_amount) },
    { key: 'status', header: 'מצב', priority: 2, render: sourceStatusLabel },
    { key: 'source', header: 'מקור', priority: 1, render: (row) => row.document_id
      ? <button type="button" className="btn-secondary min-h-11" onClick={(event) => { event.stopPropagation(); void openDocument(row.document_id!); }}>צפייה במקור</button>
      : <span className="text-ink-muted">אין קובץ מקושר</span> },
  ];

  return (
    <section aria-labelledby="consolidated-workspace-title" className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="consolidated-workspace-title" className="section-title">{workspace.case.supplier_name} · {workspace.case.legal_entity_name}</h2>
            {statusBadge(workspace.case.status)}
          </div>
          <p className="mt-1 text-sm text-ink-soft">{fmtDate(workspace.case.target_month)} · גרסת התאמה <span className="num">{fmtNum(workspace.case.current_revision)}</span></p>
        </div>
        {canWrite && workspace.anchor && (
          <button type="button" className="btn-secondary min-h-11" disabled={refreshing} onClick={onRefresh}>
            <RefreshCw size={ICON.sm} aria-hidden="true" className={refreshing ? 'animate-spin ' : ''} /> רענון התאמה
          </button>
        )}
      </div>

      {workspace.case.status === 'needs_review' && (
        <Note tone="await" role="status">
          <div className="min-w-0 flex-1">
            <p className="font-medium">המסמך נשמר, אך עדיין לא נוצר חוב.</p>
            <p className="mt-1">{reviewReason}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {primaryPage?.job_id && canWrite && (
                <button type="button" className="btn-primary min-h-11"
                  disabled={retryingReview} onClick={() => void retryReview()}>
                    <RefreshCw size={ICON.sm} aria-hidden="true" className={retryingReview ? 'animate-spin ' : ''} />
                  בדיקה מחדש
                </button>
              )}
              {primaryPage && (
                <button type="button" className="btn-secondary min-h-11"
                  onClick={() => navigate(`/documents/${primaryPage.document_id}/review`)}>
                  פתיחת העמוד שדורש בדיקה
                </button>
              )}
            </div>
          </div>
        </Note>
      )}
      {workspace.case.status === 'blocked' && (
        <Note tone="alert" role="alert">
          <p className="font-medium">רישום החוב נעצר בגלל סתירה עסקית.</p>
          <p className="mt-1">{reviewReason}</p>
        </Note>
      )}
      {workspace.pages.length > 0 && (
        <Card as="section" aria-labelledby="consolidated-pages-title" className="space-y-3">
          <h3 id="consolidated-pages-title" className="section-title">עמודי החבילה</h3>
          <ul className="divide-y divide-line-soft">
            {workspace.pages.map((page) => (
              <li key={page.document_id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">עמוד {fmtNum(page.page_number)} · {page.file_name}</p>
                  <p className="mt-1 text-sm text-ink-soft">
                    {page.is_primary ? 'עוגן החשבונית' : 'מסמך תומך'} ·
                    {' '}{consolidatedPageTypeLabel(page.document_type)} · {consolidatedPageStatusLabel(page.job_status)}
                  </p>
                </div>
                <button type="button" className="btn-secondary min-h-11"
                  onClick={() => navigate(`/documents/${page.document_id}/review`)}>
                  בדיקת העמוד
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {workspace.warnings.length > 0 && (
        <Note tone="await" role="status">
          <div className="min-w-0 flex-1">
            <p className="font-medium">נמצאו {fmtNum(workspace.warnings.length)} אזהרות. הן גלויות אך אינן חוסמות חוב תקין.</p>
            <ul className="mt-2 list-disc space-y-1 ps-5">
              {workspace.warnings.map((warning, index) => <li key={`${warning.code}:${warning.source_id ?? index}`}>{consolidatedWarningLabel(warning.code)}</li>)}
            </ul>
          </div>
        </Note>
      )}

      <Card pad={false} clip>
        <dl className="grid grid-cols-1 divide-y divide-line-soft sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:divide-x-reverse">
          <div className="p-4"><dt className="text-xs text-ink-muted">סכום העוגן</dt><dd className="mt-1 text-lg font-semibold">{money(workspace.anchor?.total_amount ?? null)}</dd></div>
          <div className="p-4"><dt className="text-xs text-ink-muted">חשבוניות ביניים</dt><dd className="mt-1 text-lg font-semibold">{money(interimTotal)}</dd></div>
          <div className="p-4"><dt className="text-xs text-ink-muted">קבלות שהושלמו</dt><dd className="mt-1 text-lg font-semibold">{money(receiptTotal)}</dd></div>
        </dl>
      </Card>

      <Card as="section" aria-labelledby="consolidated-anchor-title" className="space-y-3">
        <div className="flex items-center gap-2">
          <FileCheck2 size={ICON.md} className="text-action" aria-hidden="true" />
          <h3 id="consolidated-anchor-title" className="section-title">עוגן החוב</h3>
        </div>
        {workspace.anchor ? (
          <div className="space-y-4">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs text-ink-muted">מספר חשבונית</dt><dd className="num mt-1 font-medium" dir="ltr">{workspace.anchor.invoice_number}</dd></div>
            <div><dt className="text-xs text-ink-muted">תאריך</dt><dd className="num mt-1 font-medium">{fmtDate(workspace.anchor.invoice_date)}</dd></div>
            <div><dt className="text-xs text-ink-muted">לפני מע״מ</dt><dd className="mt-1 font-medium">{money(workspace.anchor.amount_before_vat)}</dd></div>
            <div><dt className="text-xs text-ink-muted">סה״כ</dt><dd className="mt-1 font-medium">{money(workspace.anchor.total_amount)}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-2">
            {workspace.anchor.document_ids.map((documentId, index) => (
              <button key={documentId} type="button" className="btn-secondary min-h-11"
                onClick={() => void openDocument(documentId)}>צפייה בעמוד {fmtNum(index + 1)}</button>
            ))}
          </div>
          </div>
        ) : <Note tone="idle">העמודים נקלטו, והחשבונית המרכזת עדיין ממתינה לקריאה ולעיגון.</Note>}
      </Card>

      <section aria-labelledby="consolidated-sources-title" className="space-y-3">
        <div>
          <h3 id="consolidated-sources-title" className="section-title">מקורות תומכים</h3>
          <p className="mt-1 text-sm text-ink-soft">חשבוניות ביניים ותעודות קבלה משמשות התאמה בלבד ואינן נספרות שוב כחוב.</p>
        </div>
        <DataTable rows={sourceRows} columns={sourceColumns} mobile="cards" pageSize={10}
          emptyTitle="לא נמצאו מקורות תומכים" emptySubtitle="מסמך מאותו ספק וחודש יצור גרסת התאמה חדשה." />
      </section>

      {matchChannels.map((channel) => (
        <ReconciliationTable key={channel} channel={channel} lines={workspace.reconciliation[channel]} />
      ))}
    </section>
  );
}

function ReconciliationTable({ channel, lines }: { channel: ConsolidatedMatchChannel; lines: ConsolidatedInvoiceMatchLine[] }) {
  const rows: MatchRow[] = lines.map((line, index) => ({ ...line, id: `${channel}:${index}:${line.product_id ?? 'unknown'}` }));
  const columns: Column<MatchRow>[] = [
    { key: 'result', header: 'קבוצה', priority: 1, render: (row) => <span className={row.result === 'matched' ? 'badge-done' : 'badge-await'}>{matchGroupLabel(row.result)}</span> },
    {
      key: 'product', header: 'מוצר וזהות', priority: 1,
      render: (row) => (
        <div className="min-w-40">
          <div className="font-medium"><bdi>{row.product_name ?? 'מוצר לא מזוהה'}</bdi></div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-muted" dir="ltr">
            {row.supplier_sku && <span>SKU {row.supplier_sku}</span>}
            {row.barcode && <span>{row.barcode}</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'quantities', header: 'כמויות', priority: 1,
      render: (row) => <span className="flex min-w-36 flex-col text-xs"><span>מרכזת {compactNumber(row.anchor_quantity)}</span><span>ביניים {compactNumber(row.interim_quantity)}</span><span>התקבל {compactNumber(row.received_quantity)}</span></span>,
    },
    {
      key: 'prices', header: 'מחיר יחידה', priority: 2,
      render: (row) => <span className="flex min-w-36 flex-col text-xs"><span>מרכזת {money(row.anchor_unit_price)}</span><span>ביניים {money(row.interim_unit_price)}</span></span>,
    },
    {
      key: 'amounts', header: 'סכומים', priority: 2,
      render: (row) => <span className="flex min-w-36 flex-col text-xs"><span>מרכזת {money(row.anchor_amount)}</span><span>ביניים {money(row.interim_amount)}</span></span>,
    },
    {
      key: 'difference', header: 'פער', priority: 1,
      render: (row) => <span className="flex min-w-28 flex-col text-xs"><span>כמות {compactNumber(row.difference_quantity)}</span><span>סכום {money(row.difference_amount)}</span></span>,
    },
  ];
  return (
    <section aria-labelledby={`match-${channel}`} className="space-y-3">
      <div>
        <h3 id={`match-${channel}`} className="section-title">{matchChannelLabel(channel)}</h3>
        <p className="mt-1 text-sm text-ink-soft">מותאם · חסר מקור · מקור שלא הופיע · עמום · פערי כמות ומחיר</p>
      </div>
      <DataTable rows={rows} columns={columns} mobile="cards" pageSize={15}
        emptyTitle="אין שורות בערוץ התאמה זה" emptySubtitle="השורות יופיעו לאחר השלמת קריאת העוגן והמקורות." />
    </section>
  );
}

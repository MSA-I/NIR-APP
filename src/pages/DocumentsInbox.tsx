import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Eye, FileDown, FileInput, Files, FileSearch, FileText, Loader2, ReceiptText, RefreshCw, Search, Upload, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { useQuery, unwrap } from '../lib/useQuery';
import { INBOX_CHANGED_EVENT } from '../components/QuickCapture';
import { ConfirmDialog, DataTable, ErrorNote, Modal, Note, SkeletonTable, useToast, type Column } from '../components/ui';
import { ok, toHebrewError } from '../lib/errors';
import { fmtDate, fmtDateTime, todayISO } from '../lib/format';
import type { DocumentKind, DocumentRow } from '../lib/types';
import {
  DOCUMENT_KIND_OPTIONS,
  DOCUMENT_UPLOAD_ACCEPT,
  documentKindLabel,
  documentUploadFailure,
  mergeDocumentUploadSummary,
  uploadDocument,
} from '../components/FileUpload';
import { openReservedPopup } from '../lib/popup';
import { runUploadBatch, type UploadBatchSummary } from '../lib/uploadBatch';
import { fetchAll } from '../lib/supabasePaging';
import {
  DOCUMENT_PROCESSING_CHANGED_EVENT,
  DOCUMENT_PROCESSING_STAGE_META,
  useDocumentProcessing,
  type DocumentProcessingStage,
} from '../lib/useDocumentProcessing';

type RefileTarget = 'invoice' | 'goods_receipt';
type SupplierOption = { id: string; name: string };
type GalleryDocument = DocumentRow & { supplier: SupplierOption | null };

type InvoicePick = { id: string; invoice_number: string; invoice_date: string; supplier: { name: string } | null };
type ReceiptPick = { id: string; number: number; received_at: string; order: { supplier: { name: string } | null } | null };
type RefileOption = { id: string; title: string; sub: string };

const PROCESSING_FILTERS: Array<{ value: DocumentProcessingStage; label: string }> =
  (Object.entries(DOCUMENT_PROCESSING_STAGE_META) as Array<
    [DocumentProcessingStage, (typeof DOCUMENT_PROCESSING_STAGE_META)[DocumentProcessingStage]]
  >).map(([value, { label }]) => ({ value, label }));

function ProcessingBadge({ documentId, stage }: { documentId: string; stage: DocumentProcessingStage | null }) {
  if (!stage) {
    return (
      <span data-testid="document-processing-status" data-document-id={documentId} className="badge-idle">
        סטטוס לא זמין
      </span>
    );
  }
  const meta = DOCUMENT_PROCESSING_STAGE_META[stage];
  return (
    <span data-testid="document-processing-status" data-document-id={documentId} className={`badge-${meta.tone}`}>
      {meta.label}
    </span>
  );
}

function isUnfiled(doc: DocumentRow) {
  return doc.entity_type === 'inbox' || doc.entity_id === null;
}

/** Re-filing changes only the document's owner record. Metadata selected at upload remains
 *  intact, so a delivery note linked to a receipt is not silently renamed by the UI. */
function RefileModal({ doc, target, onClose, onDone }: {
  doc: DocumentRow; target: RefileTarget; onClose: () => void; onDone: () => void | Promise<unknown>;
}) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(timeout);
  }, [q]);

  const { data: options, loading, error } = useQuery<RefileOption[]>(async () => {
    let result: RefileOption[];
    if (target === 'invoice') {
      let query = supabase.from('invoices')
        .select('id, invoice_number, invoice_date, supplier:suppliers(name)')
        .is('deleted_at', null).order('invoice_date', { ascending: false }).limit(20);
      if (dq) query = query.ilike('invoice_number', `%${dq}%`);
      const rows = unwrap(await query) as InvoicePick[];
      result = rows.map((row) => ({
        id: row.id,
        title: `חשבונית ${row.invoice_number}${row.supplier ? ` — ${row.supplier.name}` : ''}`,
        sub: fmtDate(row.invoice_date),
      }));
    } else {
      let query = supabase.from('goods_receipts')
        .select('id, number, received_at, order:purchase_orders(supplier:suppliers(name))')
        .order('received_at', { ascending: false }).limit(20);
      const numeric = /^\d+$/.test(dq);
      if (dq && numeric) query = query.eq('number', Number(dq));
      let rows = unwrap(await query) as ReceiptPick[];
      if (dq && !numeric) rows = rows.filter((row) => row.order?.supplier?.name.includes(dq));
      result = rows.map((row) => ({
        id: row.id,
        title: `קבלה #${row.number}${row.order?.supplier ? ` — ${row.order.supplier.name}` : ''}`,
        sub: fmtDate(row.received_at),
      }));
    }
    return result;
  }, [target, dq]);

  async function assign(option: RefileOption) {
    setBusy(true);
    try {
      ok(await supabase.rpc('file_document', {
        p_document_id: doc.id,
        p_entity_type: target,
        p_entity_id: option.id,
        p_reason: target === 'invoice' ? 'שיוך מסמך לחשבונית' : 'שיוך מסמך לקבלת סחורה',
      }));
      toast('המסמך שויך');
      onClose();
      window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
      await onDone();
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={target === 'invoice' ? 'שיוך לחשבונית' : 'שיוך לקבלת סחורה'} busy={busy} statusMessage={busy ? 'משייך את המסמך' : undefined}>
      <p className="mb-3 truncate text-sm text-ink-soft">המסמך: {doc.file_name}</p>
      <label className="mb-3 block">
        <span className="sr-only">חיפוש יעד לשיוך</span>
        <span className="relative block">
          <Search size={15} className="absolute top-1/2 start-3 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
          <input className="input ps-9!" value={q} onChange={(event) => setQ(event.target.value)}
            placeholder={target === 'invoice' ? 'חיפוש לפי מספר חשבונית...' : 'חיפוש לפי מספר קבלה או ספק...'} />
        </span>
      </label>
      {error ? (
        <ErrorNote message={error} />
      ) : loading ? (
        <div className="space-y-2 text-sm text-ink-muted" role="status">טוען יעדים…</div>
      ) : options?.length ? (
        <ul className="max-h-72 overflow-y-auto rounded-lg border border-line-soft divide-y divide-line-soft">
          {options.map((option) => (
            <li key={option.id}>
              <button type="button" disabled={busy} onClick={() => void assign(option)}
                className="row-hover flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2.5 text-start text-sm focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2 disabled:opacity-50">
                <span className="min-w-0 truncate text-ink-body">{option.title}</span>
                <span className="shrink-0 text-xs text-ink-muted">{option.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-sm text-ink-muted">
          {dq ? 'לא נמצאו תוצאות' : target === 'invoice' ? 'אין חשבוניות במערכת' : 'אין קבלות סחורה במערכת'}
        </div>
      )}
    </Modal>
  );
}

function UploadModal({ suppliers, onClose, onDone }: {
  suppliers: SupplierOption[]; onClose: () => void; onDone: () => void | Promise<unknown>;
}) {
  const { profile } = useAuth();
  const toast = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState<DocumentKind>('other');
  const [supplierId, setSupplierId] = useState('');
  const [documentDate, setDocumentDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [uploadSummary, setUploadSummary] = useState<UploadBatchSummary | null>(null);

  async function submit() {
    if (!profile || files.length === 0) return;
    setBusy(true);
    try {
      const result = await runUploadBatch(files, (file) => uploadDocument(profile.org_id, 'inbox', null, file, {
        documentKind: kind,
        supplierId: supplierId || null,
        documentDate: documentDate || null,
      }));
      const failures = result.failed.map(({ item, error }) => ({ item, ...documentUploadFailure(error) }));
      const failed = failures.filter(({ retryable }) => retryable).map(({ item }) => item);
      const registered = failures.filter(({ registered: isRegistered }) => isRegistered).length;
      setFiles(failed);
      const summary = mergeDocumentUploadSummary(uploadSummary, files, result);
      setUploadSummary(summary);
      if (result.succeeded.length || registered) {
        window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
        await onDone();
      }
      if (summary.failed.length) {
        const currentFailure = failures[0]?.message;
        toast(`${summary.succeeded.length} הועלו וממתינים לעיבוד, ${summary.failed.length} לא הושלמו.${currentFailure ? ` ${currentFailure}` : ''}`, 'error');
      } else {
        toast(summary.succeeded.length === 1 ? 'הועלה וממתין לעיבוד' : `${summary.succeeded.length} מסמכים הועלו וממתינים לעיבוד`);
        onClose();
      }
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="העלאת מסמך" busy={busy} statusMessage={busy ? 'מעלה את המסמכים' : undefined}>
      <p className="mb-4 text-sm text-ink-muted">המסמך ייקלט כלא משויך. אפשר לשייך אותו לחשבונית או לקבלת סחורה לאחר ההעלאה.</p>
      <div className="space-y-3">
        <label className="block">
          <span className="label">קובץ</span>
          <input type="file" className="input" multiple
            accept={DOCUMENT_UPLOAD_ACCEPT}
            disabled={busy || !!uploadSummary?.failed.length}
            onChange={(event) => { setUploadSummary(null); setFiles(Array.from(event.target.files ?? [])); }} />
          {files.length > 0 && <div className="mt-1 text-xs text-ink-muted">{files.map((file) => file.name).join(', ')}</div>}
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label>
            <span className="label">סוג מסמך</span>
            <select className="input" value={kind} onChange={(event) => setKind(event.target.value as DocumentKind)}>
              {DOCUMENT_KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span className="label">תאריך מסמך</span>
            <input type="date" className="input num" value={documentDate} onChange={(event) => setDocumentDate(event.target.value)} />
          </label>
        </div>
        <label className="block">
          <span className="label">ספק</span>
          <select className="input" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
            <option value="">ללא ספק</option>
            {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
          </select>
        </label>
        {uploadSummary && (
          <Note tone={uploadSummary.failed.length ? 'alert' : 'done'}>
            <div role="status">
              <div><span className="num">{uploadSummary.succeeded.length}</span> הועלו וממתינים לעיבוד · <span className="num">{uploadSummary.failed.length}</span> לא הושלמו</div>
              {uploadSummary.failed.length > 0 && <div className="mt-1 text-xs">לא הושלמו: {uploadSummary.failed.join(', ')}. ניסיון חוזר ישלח רק קבצים שניתן לנסות שוב.</div>}
            </div>
          </Note>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
        {(!uploadSummary || files.length > 0) && (
          <button type="button" className="btn-primary" disabled={busy || files.length === 0} onClick={() => void submit()}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            {uploadSummary?.failed.length ? 'ניסיון חוזר לנכשלים בלבד' : 'העלאה'}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** `/documents` — one register for every active document. `/inbox` redirects here with
 *  `filing=unfiled`, so capture and archive are two views of the same source of truth. */
export default function DocumentsGallery() {
  const { profile } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filingParam = params.get('filing');
  const filing = filingParam === 'linked' || filingParam === 'unfiled' ? filingParam : 'all';
  const processingParam = params.get('processing');
  const processingFilter = PROCESSING_FILTERS.some(({ value }) => value === processingParam)
    ? processingParam as DocumentProcessingStage
    : 'all';
  const canFile = profile?.role === 'owner' || profile?.role === 'office';
  const canUpload = !!profile && ['owner', 'office', 'kitchen'].includes(profile.role);
  const canEnqueue = canUpload;
  const canRetry = canFile;

  const [q, setQ] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [refile, setRefile] = useState<{ doc: DocumentRow; target: RefileTarget } | null>(null);
  const [retryDoc, setRetryDoc] = useState<DocumentRow | null>(null);
  const [retrying, setRetrying] = useState(false);

  const { data, loading, fetching, error, refetch } = useQuery<{
    docs: GalleryDocument[]; suppliers: SupplierOption[];
  }>(async () => {
    const suppliers = await fetchAll<SupplierOption>((from, to) => supabase.from('suppliers').select('id, name')
      .is('deleted_at', null).order('name').order('id').range(from, to));
    const docs = await fetchAll((from, to) => supabase.from('documents').select('*, supplier:suppliers(id, name)')
      .is('deleted_at', null).order('created_at', { ascending: false }).order('id').range(from, to)) as unknown as GalleryDocument[];
    return { docs, suppliers };
  }, []);
  const documentIds = useMemo(() => data?.docs.map((doc) => doc.id) ?? [], [data]);
  const processing = useDocumentProcessing(documentIds);

  useEffect(() => {
    const onChanged = () => { void refetch(); };
    window.addEventListener(INBOX_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(INBOX_CHANGED_EVENT, onChanged);
  }, [refetch]);

  // ponytail: rows are fetched in bounded batches so the gallery does not silently stop at
  // PostgREST's row cap. Move filters themselves server-side when client filtering becomes slow.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.docs ?? []).filter((doc) => {
      const date = doc.document_date ?? doc.created_at.slice(0, 10);
      const stage = processing.data === null ? null : processing.snapshots[doc.id]?.stage ?? 'unprocessed';
      return (!needle || doc.file_name.toLowerCase().includes(needle))
        && (!supplierId || (supplierId === 'none' ? !doc.supplier_id : doc.supplier_id === supplierId))
        && (!kind || doc.document_kind === kind)
        && (filing === 'all' || (filing === 'unfiled' ? isUnfiled(doc) : !isUnfiled(doc)))
        && (processingFilter === 'all' || stage === processingFilter)
        && (!from || date >= from)
        && (!to || date <= to);
    });
  }, [data, q, supplierId, kind, filing, processingFilter, processing.data, processing.snapshots, from, to]);

  function setFiling(value: string) {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('filing');
    else next.set('filing', value);
    setParams(next, { replace: true });
  }

  function setProcessing(value: string) {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('processing');
    else next.set('processing', value);
    setParams(next, { replace: true });
  }

  function resetFilters() {
    setQ('');
    setSupplierId('');
    setKind('');
    setFrom('');
    setTo('');
    const next = new URLSearchParams(params);
    next.delete('filing');
    next.delete('processing');
    setParams(next, { replace: true });
  }

  function review(doc: DocumentRow, panel?: 'export') {
    const query = panel ? `?panel=${panel}` : '';
    navigate(`/documents/${encodeURIComponent(doc.id)}/review${query}`);
  }

  async function retry(reason?: string) {
    if (!retryDoc) return;
    const wasUnprocessed = processing.snapshots[retryDoc.id]?.stage === 'unprocessed';
    if (!wasUnprocessed && !reason) return;
    setRetrying(true);
    try {
      ok(wasUnprocessed
        ? await supabase.rpc('enqueue_document_processing', { p_document_id: retryDoc.id })
        : await supabase.rpc('reprocess_document', { p_document_id: retryDoc.id, p_reason: reason }));
      toast(wasUnprocessed ? 'המסמך נשלח לתור העיבוד' : 'המסמך הוחזר לתור העיבוד');
      setRetryDoc(null);
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setRetrying(false);
    }
  }

  async function open(doc: DocumentRow) {
    const result = await openReservedPopup(async () => {
      const { data: url, error: openError } = await supabase.storage.from('documents').createSignedUrl(doc.storage_path, 300);
      if (openError || !url) throw openError ?? new Error('missing signed URL');
      return url.signedUrl;
    });
    if (result === 'blocked') toast('הדפדפן חסם את חלון הצפייה. יש לאפשר חלונות קופצים ולנסות שוב.', 'error');
    if (result === 'error') toast('שגיאה בפתיחת הקובץ', 'error');
  }

  const columns: Column<GalleryDocument>[] = [
    {
      key: 'file', header: 'מסמך', priority: 1, sortValue: (doc) => doc.file_name,
      render: (doc) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-10 shrink-0 place-items-center overflow-hidden border border-line bg-surface-sunken" aria-hidden="true">
            <FileText size={18} className="text-ink-faint" />
          </span>
          <span className="min-w-0 truncate font-medium text-ink-body">{doc.file_name}</span>
        </span>
      ),
    },
    { key: 'kind', header: 'סוג', sortValue: (doc) => doc.document_kind, render: (doc) => documentKindLabel(doc.document_kind) },
    { key: 'supplier', header: 'ספק', sortValue: (doc) => doc.supplier?.name ?? '', render: (doc) => doc.supplier?.name ?? '—' },
    {
      key: 'date', header: 'תאריך מסמך', className: 'num', sortValue: (doc) => doc.document_date ?? doc.created_at,
      render: (doc) => (
        <span title={doc.document_date ? undefined : `תאריך העלאה: ${fmtDateTime(doc.created_at)}`}>
          {fmtDate(doc.document_date ?? doc.created_at)}{!doc.document_date && <span className="font-sans text-xs text-ink-muted"> (העלאה)</span>}
        </span>
      ),
    },
    {
      key: 'filing', header: 'תיוק', mobileLabel: null, priority: 3, sortValue: (doc) => isUnfiled(doc) ? 0 : 1,
      render: (doc) => <span className={isUnfiled(doc) ? 'badge-await' : 'badge-done'}>{isUnfiled(doc) ? 'לא משויך' : 'משויך'}</span>,
    },
    {
      key: 'processing', header: 'עיבוד', mobileLabel: null, priority: 3,
      sortValue: (doc) => processing.snapshots[doc.id]?.stage ?? 'unprocessed',
      render: (doc) => (
        <ProcessingBadge
          documentId={doc.id}
          stage={processing.data === null ? null : processing.snapshots[doc.id]?.stage ?? 'unprocessed'}
        />
      ),
    },
  ];

  const hasFilters = !!(q || supplierId || kind || from || to || filing !== 'all' || processingFilter !== 'all');

  return (
    <div className="space-y-4" data-testid="documents-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title flex items-center gap-2"><Files size={22} /> גלריית מסמכים</h1>
          <p className="mt-1 text-sm text-ink-muted">כל החשבוניות, תעודות המשלוח, הזיכויים והמסמכים הנוספים במקום אחד.</p>
        </div>
        {canUpload && (
          <button type="button" className="btn-primary" onClick={() => setUploadOpen(true)}>
            <Upload size={16} /> העלאת מסמך
          </button>
        )}
      </div>

      <section aria-label="סינון מסמכים" className="border-y border-line-soft bg-surface px-3 py-3 sm:px-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="lg:col-span-2">
            <span className="label">שם קובץ</span>
            <span className="relative block">
              <Search size={15} className="absolute top-1/2 start-3 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
              <input type="search" className="input ps-9!" value={q} onChange={(event) => setQ(event.target.value)} placeholder="חיפוש מסמך..." />
            </span>
          </label>
          <label>
            <span className="label">ספק</span>
            <select className="input" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
              <option value="">כל הספקים</option>
              <option value="none">ללא ספק</option>
              {data?.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </select>
          </label>
          <label>
            <span className="label">סוג מסמך</span>
            <select className="input" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">כל הסוגים</option>
              {DOCUMENT_KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span className="label">סטטוס תיוק</span>
            <select className="input" value={filing} onChange={(event) => setFiling(event.target.value)}>
              <option value="all">הכול</option>
              <option value="unfiled">לא משויכים</option>
              <option value="linked">משויכים</option>
            </select>
          </label>
          <label>
            <span className="label">סטטוס עיבוד</span>
            <select data-testid="documents-processing-filter" className="input" value={processingFilter}
              onChange={(event) => setProcessing(event.target.value)}>
              <option value="all">הכול</option>
              {PROCESSING_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span className="label">מתאריך</span>
            <input type="date" className="input num" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            <span className="label">עד תאריך</span>
            <input type="date" className="input num" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <div className="flex items-end">
            <button type="button" className="btn-ghost min-h-11" disabled={!hasFilters} onClick={resetFilters}>
              <X size={15} /> ניקוי מסננים
            </button>
          </div>
        </div>
        {!loading && data && (
          <div className="mt-2 text-xs text-ink-muted" aria-live="polite">
            מציג <span className="num">{filtered.length}</span> מתוך <span className="num">{data.docs.length}</span> מסמכים
          </div>
        )}
      </section>

      {error && data && <ErrorNote message={error} />}
      {processing.error && (
        <Note tone="alert">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{processing.error} הנתונים שכבר נטענו נשארו מוצגים.</span>
            <button data-testid="documents-processing-retry" type="button" className="btn-secondary min-h-11"
              disabled={processing.fetching} onClick={() => void processing.refetch()}>
              <RefreshCw size={16} aria-hidden="true" /> ניסיון חוזר
            </button>
          </div>
        </Note>
      )}
      {fetching && data && <div className="text-xs text-ink-muted" role="status">רשימת המסמכים מתעדכנת…</div>}
      {processing.fetching && processing.data && <div className="text-xs text-ink-muted" role="status">סטטוסי העיבוד מתעדכנים…</div>}
      {error && !data ? <ErrorNote message={error} /> : loading ? <SkeletonTable cols={6} /> : (
        <DataTable rows={filtered} columns={columns} pageSize={20}
          rowLabel={(doc) => `מסמך ${doc.file_name}`}
          onRowClick={(doc) => void open(doc)}
          mobileTitle={(doc) => doc.file_name}
          mobileTrailing={(doc) => (
            <span className="flex flex-wrap justify-end gap-1">
              <ProcessingBadge documentId={doc.id}
                stage={processing.data === null ? null : processing.snapshots[doc.id]?.stage ?? 'unprocessed'} />
              <span className={isUnfiled(doc) ? 'badge-await' : 'badge-done'}>{isUnfiled(doc) ? 'לא משויך' : 'משויך'}</span>
            </span>
          )}
          rowActions={(doc) => {
            const snapshot = processing.snapshots[doc.id];
            return [
              { key: 'review', label: 'בדיקת מסמך', icon: FileSearch, hidden: !snapshot?.job, onSelect: () => review(doc) },
              { key: 'enqueue', label: 'שליחה לעיבוד', icon: RefreshCw, hidden: !canEnqueue || snapshot?.stage !== 'unprocessed', onSelect: () => setRetryDoc(doc) },
              { key: 'retry', label: 'עיבוד מחדש', icon: RefreshCw, hidden: !canRetry || snapshot?.stage !== 'failed', onSelect: () => setRetryDoc(doc) },
              { key: 'export', label: 'ייצוא', icon: FileDown, hidden: snapshot?.stage !== 'review' && snapshot?.stage !== 'completed', onSelect: () => review(doc, 'export') },
              { key: 'view', label: 'צפייה במקור', icon: Eye, onSelect: () => void open(doc) },
              { key: 'invoice', label: 'שיוך לחשבונית', icon: FileInput, hidden: !canFile || !isUnfiled(doc), onSelect: () => setRefile({ doc, target: 'invoice' }) },
              { key: 'receipt', label: 'שיוך לקבלת סחורה', icon: ReceiptText, hidden: !canFile || !isUnfiled(doc), onSelect: () => setRefile({ doc, target: 'goods_receipt' }) },
            ];
          }}
          emptyTitle={data?.docs.length ? 'לא נמצאו מסמכים לפי הסינון' : 'אין מסמכים במערכת'}
          emptySubtitle={data?.docs.length ? 'שנו או נקו את המסננים כדי לראות מסמכים נוספים' : 'מסמך חדש יופיע כאן מיד לאחר צילום או העלאה'} />
      )}

      {uploadOpen && <UploadModal suppliers={data?.suppliers ?? []} onClose={() => setUploadOpen(false)} onDone={refetch} />}
      {refile && <RefileModal doc={refile.doc} target={refile.target} onClose={() => setRefile(null)} onDone={refetch} />}
      <ConfirmDialog open={!!retryDoc} onClose={() => setRetryDoc(null)} onConfirm={(reason) => void retry(reason)}
        title={processing.snapshots[retryDoc?.id ?? '']?.stage === 'unprocessed' ? 'שליחת המסמך לעיבוד' : 'עיבוד המסמך מחדש'}
        message={processing.snapshots[retryDoc?.id ?? '']?.stage === 'unprocessed'
          ? 'המסמך השמור יישלח כעת לתור העיבוד.'
          : 'ניסיון חדש שומר את תוצאות העיבוד הקודמות ומוסיף ניסיון נפרד.'}
        confirmLabel={processing.snapshots[retryDoc?.id ?? '']?.stage === 'unprocessed' ? 'שליחה לתור' : 'החזרה לתור'}
        requireReason={processing.snapshots[retryDoc?.id ?? '']?.stage !== 'unprocessed'} busy={retrying} />

    </div>
  );
}

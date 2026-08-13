import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Archive, ChevronDown, Eye, FileDown, FileInput, FolderOpen, FileSearch, FileText, Loader2, ReceiptText, RefreshCw, RotateCcw, Search, Trash2, Undo2, Upload, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { useQuery, unwrap } from '../lib/useQuery';
import { INBOX_CHANGED_EVENT } from '../components/QuickCapture';
import { ConfirmDialog, DataTable, ErrorNote, Modal, Note, PageHeader, SkeletonTable, useToast, type Column } from '../components/ui';
import { DocumentRemovalDialog } from '../components/DocumentRemovalDialog';
import { ok, toHebrewError } from '../lib/errors';
import { fmtDate, fmtDateTime, todayISO } from '../lib/format';
import type { DocumentRow } from '../lib/types';
import {
  DOCUMENT_KIND_OPTIONS,
  DOCUMENT_UPLOAD_ACCEPT,
  beginDocumentIntake,
  documentKindLabel,
  documentUploadFailure,
  mergeDocumentUploadSummary,
  uploadDocument,
} from '../components/FileUpload';
import { openReservedPopup } from '../lib/popup';
import { runUploadBatch, type UploadBatchSummary } from '../lib/uploadBatch';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { DocumentStatusBadge } from '../components/DocumentStatusBadge';
import { UploadCenter } from '../components/UploadCenter';
import {
  DOCUMENT_STATUS_FILTERS,
  documentMatchesFilingFilter,
  documentMatchesStatusFilter,
  documentStatusFilterFromParam,
  documentUiStatus,
  type DocumentStatusFilter,
} from '../lib/documentStatus';
import {
  DOCUMENT_PROCESSING_CHANGED_EVENT,
  useDocumentProcessing,
  type DocumentProcessingStage,
} from '../lib/useDocumentProcessing';

type RefileTarget = 'invoice' | 'goods_receipt';
type SupplierOption = { id: string; name: string };
type GalleryDocument = DocumentRow & { supplier: SupplierOption | null };

/** One row of `document_auto_actions` (0077): a financial record a machine wrote with no human.
 *
 *  This type, and the badge and action built on it, are the FIRST place in `src/` that names what
 *  the automation did. Until now nothing in the browser referenced `document_auto_actions`,
 *  `document_filings` or `auto_applied` at all — an invoice the model authored was indistinguishable
 *  on screen from one a colleague typed, which makes supervising the automation impossible in the
 *  literal sense: there was nothing to look at.
 *
 *  Only the live rows are read (`reverted_at is null`). A reverted decision is history, and its
 *  document is back in the queue looking like any other unfiled document — which is the truth. */
type AutoActionRow = {
  id: string;
  document_id: string;
  invoice_id: string | null;
  decision: { decision_confidence?: number | string | null } | null;
};

/** The confidence the machine acted on, as a percentage a person can read.
 *
 *  NULL means UNKNOWN and says so. It is never rendered as 0% — the constitution's rule about
 *  dashes instead of zeros, applied where it matters most: "the system was 0% sure and created
 *  this invoice anyway" is a sentence about the software that would not be true. `decision` is
 *  jsonb, so the number can arrive as a JSON number or a numeric-as-string; both are accepted and
 *  anything else is unknown rather than NaN%. */
function autoActionConfidence(action: AutoActionRow): string {
  const raw = action.decision?.decision_confidence;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return 'לא ידועה';
  return `${Math.round(value * 100)}%`;
}

function autoActionDescription(action: AutoActionRow): string {
  return `החשבונית נוצרה ושויכה אוטומטית על ידי המערכת מתוך המסמך הזה, ללא אישור אדם, ברמת ביטחון ${autoActionConfidence(action)}.`;
}

type InvoicePick = { id: string; invoice_number: string; invoice_date: string; supplier: { name: string } | null };
type ReceiptPick = { id: string; number: number; received_at: string; order: { supplier: { name: string } | null } | null };
type RefileOption = { id: string; title: string; sub: string };

/** The badge a person reads, over the stage the machine records.
 *
 *  `data-testid` and `data-document-id` are unchanged, and `data-stage` is ADDED carrying the raw
 *  internal stage: check-browser-smoke.cjs keeps measuring real pipeline state while the text says
 *  something a procurement user can act on. Exported for documentStage.spec.tsx, which asserts that
 *  pairing directly — the gate contract is too easy to break silently from inside this file. */
export function ProcessingBadge({ documentId, stage, doc }: {
  documentId: string;
  stage: DocumentProcessingStage | null;
  doc?: Pick<DocumentRow, 'entity_type' | 'entity_id'> | null;
}) {
  if (!stage) {
    return (
      <span data-testid="document-processing-status" data-document-id={documentId} className="badge-idle">
        סטטוס לא זמין
      </span>
    );
  }
  const status = documentUiStatus({ status: stage, document: doc });
  return <DocumentStatusBadge status={status} data-testid="document-processing-status"
    data-document-id={documentId} data-stage={stage} />;
}

/** The state filter. Extracted so the RENDERED options can be asserted: pinning the exported array
 *  is not the same as pinning the control, and a scenario that only calls `selectOption('failed')`
 *  passes against both this list and the seven engineering stages it replaced. */
export function ProcessingFilterSelect({ value, onChange, includeAssignmentStates = true }: {
  value: DocumentStatusFilter | 'all'; onChange: (value: string) => void;
  includeAssignmentStates?: boolean;
}) {
  const options = includeAssignmentStates
    ? DOCUMENT_STATUS_FILTERS
    : DOCUMENT_STATUS_FILTERS.filter(({ value: option }) => option !== 'unassigned' && option !== 'assigned');
  return (
    <label>
      <span className="label">מצב המסמך</span>
      <select data-testid="documents-processing-filter" className="input" value={value}
        onChange={(event) => onChange(event.target.value)}>
        <option value="all">הכול</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

/** Decision #45's contract, and it is a contract OF THE DOCUMENTS FOLDER: `inbox`/no target =
 *  לא משויך, any business target = משויך. An archived row is null on entity_id and so reads as
 *  unfiled here — which is wrong about it, because an archived document is not "not yet filed",
 *  it is *decided to have no target*. Rather than teach this a third state and reopen #45 for
 *  the sake of one screen, the archive view drops the filing column and its filter entirely
 *  (see `columns` and the filter section). The two-value question is simply not asked where it
 *  has no meaningful answer. */
function isUnfiled(doc: DocumentRow) {
  return doc.entity_type === 'inbox' || doc.entity_id === null;
}

/** The filing answer, and — when a machine gave it — who gave it.
 *
 *  "משויך" is true of a machine-authored filing and it is not ENOUGH: a person who cannot tell an
 *  invoice the model wrote from one their colleague typed cannot supervise the automation, and the
 *  owner's decision to let a model create financial records was granted on the understanding that
 *  it stays supervisable. So the badge names the author, and the sentence naming the confidence
 *  rides along as a SIBLING rather than as `title` alone — a tooltip does not exist on touch and
 *  screen readers treat it inconsistently, which PRODUCT.md's WCAG 2.1 AA target does not allow
 *  for the only copy that distinguishes a machine's work from a person's. Same pairing, and same
 *  reason, as ProcessingBadge above. */
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
  const [supplierId, setSupplierId] = useState('');
  const [documentDate, setDocumentDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [uploadSummary, setUploadSummary] = useState<UploadBatchSummary | null>(null);

  async function submit() {
    if (!profile || files.length === 0) return;
    setBusy(true);
    try {
      // No documentKind: uploadDocument falls back to the entity default, which for the inbox is
      // 'other' — an honest "not read yet". 0084's trigger replaces it with what the document
      // actually says the moment the interpretation lands.
      const result = await runUploadBatch(files, (file) => uploadDocument(profile.org_id, 'inbox', null, file, {
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
      <p className="mb-4 text-sm text-ink-muted">
        הקובץ נשמר מיד ולא ילך לאיבוד. המערכת תזהה בעצמה מה סוג המסמך, מי הספק ולאיזו הזמנה הוא שייך,
        ותציג את הממצאים לבדיקה ולאישור לפני שהם משפיעים על משהו.
      </p>
      <div className="space-y-3">
        <label className="block">
          <span className="label">קובץ</span>
          <input type="file" className="input" multiple
            accept={DOCUMENT_UPLOAD_ACCEPT}
            disabled={busy || !!uploadSummary?.failed.length}
            onChange={(event) => { setUploadSummary(null); setFiles(Array.from(event.target.files ?? [])); }} />
          {files.length > 0 && <div className="mt-1 text-xs text-ink-muted">{files.map((file) => file.name).join(', ')}</div>}
        </label>
        {/* The "סוג מסמך" select that stood here is gone. Asking a person holding a phone beside a
            delivery truck to classify the paper BEFORE anything has read it is asking the wrong
            party at the wrong moment: the extraction pipeline reads the subtype off the document
            itself, and a human confirms or corrects it on the review screen, where the document is
            on screen to check against. A guess made at upload time is a guess that the evidence
            extracted afterwards then has to argue with. Supplier and date stay — optional, folded
            away — as hints for a document the model cannot read. */}
        <details className="rounded-lg border border-line-soft px-3 py-2">
          <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm text-action">
            פרטים ידניים (לא חובה)
          </summary>
          <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
            <label>
              <span className="label">ספק</span>
              <select className="input" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
                <option value="">זיהוי אוטומטי</option>
                {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select>
            </label>
            <label>
              <span className="label">תאריך מסמך</span>
              <input type="date" className="input num" value={documentDate} onChange={(event) => setDocumentDate(event.target.value)} />
            </label>
          </div>
        </details>
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

/** One register for every active document, served at two routes. `/documents` is all of it, and
 *  `/inbox` redirects here with `filing=unfiled` — capture and register are two views of one
 *  source of truth. `/documents/archive` sets `archive` and narrows the same query to
 *  `entity_type='archive'`: the documents interpretation could not place, which no one files by
 *  hand. One component either way, so "what is a document row" has a single answer. */
export default function DocumentsGallery({ archive = false }: { archive?: boolean }) {
  const [removalDoc, setRemovalDoc] = useState<DocumentRow | null>(null);
  const { profile, organizationAccess } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filingParam = params.get('filing');
  // The archive ignores the filing filter outright, not merely hides its control: `/inbox`
  // redirects to `?filing=unfiled` and that param survives navigation, so an archive reached
  // with it still attached would silently narrow a list whose only control for widening it
  // again is no longer on screen.
  const filing = !archive && (filingParam === 'linked' || filingParam === 'unfiled') ? filingParam : 'all';
  // The filter uses the exact same precedence result as the badge. Old raw-stage links are mapped
  // only when their meaning remains exact; ambiguous aggregate links fall back to "all" rather
  // than showing a control that says one thing over rows that say another.
  const requestedProcessingFilter = documentStatusFilterFromParam(params.get('processing'));
  const processingFilter: DocumentStatusFilter | 'all' = archive
    && (requestedProcessingFilter === 'unassigned' || requestedProcessingFilter === 'assigned')
    ? 'all'
    : requestedProcessingFilter ?? 'all';
  const canWrite = organizationAccess?.canWrite ?? true;
  const canFile = canWrite && (profile?.role === 'owner' || profile?.role === 'office');
  const canUpload = canWrite && !!profile && ['owner', 'office'].includes(profile.role);
  const canEnqueue = canUpload;
  const canRetry = canFile;
  /**
   * Removing a document is not filing it (owner, 11.08.2026, and 0121 in the database).
   * Whoever photographed the wrong page is who notices. The server holds the real boundary and
   * keeps the derived reversal for owner/office,
   * telling the dialog so through `can_remove_derived` and a named blocker.
   */
  const canRemoveDocument = canWrite && !!profile
    && ['owner', 'office', 'accountant'].includes(profile.role);

  const [q, setQ] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [refile, setRefile] = useState<{ doc: DocumentRow; target: RefileTarget } | null>(null);
  const [retryDoc, setRetryDoc] = useState<DocumentRow | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [rescueDoc, setRescueDoc] = useState<DocumentRow | null>(null);
  const [rescuing, setRescuing] = useState(false);
  const [deleteDoc, setDeleteDoc] = useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [revertDoc, setRevertDoc] = useState<DocumentRow | null>(null);
  const [reverting, setReverting] = useState(false);

  const { data, loading, fetching, error, refetch } = useQuery<{
    docs: GalleryDocument[]; suppliers: SupplierOption[];
  }>(async () => {
    const suppliers = await fetchAll<SupplierOption>((from, to) => supabase.from('suppliers').select('id, name')
      .is('deleted_at', null).order('name').order('id').range(from, to));
    // The two views partition the register; they do not overlap. The requirement is that a document
    // matching no category is *מועבר* to the archive — moved, not tagged — and a row appearing in
    // both screens was never moved anywhere. Left overlapping, the working folder would refill with
    // exactly the noise the archive exists to absorb, which is the feature failing at its purpose.
    // This `neq` is that product decision, not a stray filter. It is also safe to express it with:
    // documents.entity_type is NOT NULL (0001_init.sql:363), so no row can fall out of both halves
    // the way a nullable column would, and nothing needs a defensive `.or(...)` around it.
    //
    // Since 0075, file_document accepts ('archive', null), so this route can list rows. Nothing
    // fills it automatically yet — the interpretation layer that will (task C2) is not written —
    // so in practice the archive is still empty for most tenants, and the empty state below says
    // which emptiness that is rather than dressing it as a failure.
    const docs = await fetchAll((from, to) => {
      const rows = supabase.from('documents').select('*, supplier:suppliers(id, name)').is('deleted_at', null);
      return (archive ? rows.eq('entity_type', 'archive') : rows.neq('entity_type', 'archive'))
        .order('created_at', { ascending: false }).order('id').range(from, to);
    }) as unknown as GalleryDocument[];
    return { docs, suppliers };
  }, [archive]);
  const documentIds = useMemo(() => data?.docs.map((doc) => doc.id) ?? [], [data]);
  const processing = useDocumentProcessing(documentIds);

  /** The autonomy ledger, read in its OWN query rather than joined into the list above, and the
   *  separation is a product decision: a document register that refuses to render because the
   *  autonomy ledger is unreadable would be the tail wagging the dog. If this read fails the rows
   *  still list, the badge simply is not there and the reversal is not offered — which is the
   *  honest degradation, because offering an undo we cannot describe would be worse than none.
   *  Keyed on a joined string, the `useDocumentProcessing` idiom, so a re-render with an
   *  identical id list does not re-fetch. */
  const documentIdsKey = documentIds.join(',');
  const { data: autoActions, refetch: refetchAutoActions } = useQuery<Record<string, AutoActionRow>>(
    async () => {
      if (!documentIds.length) return {};
      const rows = await fetchInChunks(documentIds, (chunk) => fetchAll<AutoActionRow>((from, to) => supabase
        .from('document_auto_actions').select('id, document_id, invoice_id, decision')
        .in('document_id', chunk).is('reverted_at', null)
        .order('created_at', { ascending: false }).order('id').range(from, to)));
      return Object.fromEntries(rows.map((row) => [row.document_id, row]));
    },
    [documentIdsKey],
  );
  const autoActionFor = (doc: DocumentRow): AutoActionRow | null => autoActions?.[doc.id] ?? null;
  const statusFor = (doc: GalleryDocument) => {
    const autoAction = autoActionFor(doc);
    return documentUiStatus({
      status: processing.data === null ? null : processing.snapshots[doc.id]?.stage ?? 'unprocessed',
      job: processing.snapshots[doc.id]?.job,
      document: doc,
      autoAssigned: autoAction !== null,
      autoAssignmentDescription: autoAction ? autoActionDescription(autoAction) : null,
    });
  };

  // A job that has been extracted goes no further on its own: interpretation has to be asked for,
  // and until it is the document sits in the list looking like work is in progress when none is.
  // Asking for it here is what makes the queue drain to "דורש בדיקה" by itself. The handler is
  // idempotent and short-circuits before the paid call, so a repeat costs one round trip.
  const interpretInFlight = useRef(new Set<string>());
  const interpretAttempts = useRef(new Map<string, number>());
  const interpretMounted = useRef(false);
  const [interpretRetryTick, setInterpretRetryTick] = useState(0);
  const [interpretFailure, setInterpretFailure] = useState<{ jobId: string; message: string } | null>(null);
  const { snapshots: processingSnapshots, refetch: refetchProcessing } = processing;
  useEffect(() => {
    // React Strict Mode runs setup -> cleanup -> setup in development. Resetting the ref in every
    // setup keeps retry timers live after that probe while still preventing updates after unmount.
    interpretMounted.current = true;
    return () => { interpretMounted.current = false; };
  }, []);
  useEffect(() => {
    const pending = Object.values(processingSnapshots)
      .map((snapshot) => snapshot.job)
      .filter((job) => job?.status === 'extracted'
        && !interpretInFlight.current.has(job.id)
        && (interpretAttempts.current.get(job.id) ?? 0) < 3);
    if (!pending.length) return;
    let cancelled = false;
    void (async () => {
      for (const job of pending) {
        if (cancelled || !job) return;
        interpretInFlight.current.add(job.id);
        // One at a time: each is a paid model call, and a gallery of twenty should not fire twenty
        // at once. A failed transport/request is retried only while this exact job remains
        // `extracted`; the Set is released on failure so a lost response cannot strand it forever.
        let response: { error: unknown };
        try {
          response = await supabase.functions.invoke('interpret-document', { body: { jobId: job.id } });
        } catch (error) {
          response = { error };
        }
        interpretInFlight.current.delete(job.id);
        if (response.error) {
          const attempts = (interpretAttempts.current.get(job.id) ?? 0) + 1;
          interpretAttempts.current.set(job.id, attempts);
          await refetchProcessing();
          if (attempts < 3) {
            window.setTimeout(() => {
              if (interpretMounted.current) setInterpretRetryTick((value) => value + 1);
            }, 1000 * 2 ** (attempts - 1));
          } else if (!cancelled) {
            setInterpretFailure({
              jobId: job.id,
              message: 'החילוץ נשמר, אך שלב הפענוח לא הצליח לאחר שלושה ניסיונות. ניתן לנסות שוב בלי להפעיל OCR מחדש.',
            });
          }
          continue;
        }
        interpretAttempts.current.delete(job.id);
        if (interpretFailure?.jobId === job.id) setInterpretFailure(null);
      }
      if (!cancelled) await refetchProcessing();
    })();
    return () => { cancelled = true; };
  }, [processingSnapshots, refetchProcessing, interpretRetryTick, interpretFailure?.jobId]);

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
      const uiStatus = statusFor(doc);
      return (!needle || doc.file_name.toLowerCase().includes(needle))
        && (!supplierId || (supplierId === 'none' ? !doc.supplier_id : doc.supplier_id === supplierId))
        && (!kind || doc.document_kind === kind)
        && documentMatchesFilingFilter(uiStatus, filing)
        // An unread processing query resolves to `unavailable`, which matches no named filter.
        // The banner above the table explains the gap without assigning it a false state.
        && documentMatchesStatusFilter(uiStatus, processingFilter)
        && (!from || date >= from)
        && (!to || date <= to);
    });
  }, [data, q, supplierId, kind, filing, processingFilter, processing.data, processing.snapshots, from, to, autoActions]);

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

  async function retry() {
    if (!retryDoc) return;
    const wasUnprocessed = processing.snapshots[retryDoc.id]?.stage === 'unprocessed';
    setRetrying(true);
    try {
      ok(wasUnprocessed
        ? await beginDocumentIntake(retryDoc.id)
        : await supabase.rpc('reprocess_document', {
          p_document_id: retryDoc.id,
          p_reason: 'עיבוד מחדש ביוזמת המשתמש ממסך המסמכים',
        }));
      toast(wasUnprocessed ? 'המסמך נשלח לתור העיבוד' : 'המסמך הוחזר לתור העיבוד');
      setRetryDoc(null);
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setRetrying(false);
    }
  }

  /** The archive's own filing action, and the reason is not optional. It is a separate RPC from
   *  the two שיוך actions on purpose: file_document's guard takes only a row still in the inbox
   *  (0019:167), and keeping rescue separate is what makes "a reason is required" structural —
   *  a property of which action the person chose, not of a prop threaded into a shared modal. */
  async function rescue(reason?: string) {
    if (!rescueDoc || !reason) return;
    setRescuing(true);
    try {
      ok(await supabase.rpc('rescue_document_from_archive', {
        p_document_id: rescueDoc.id,
        p_reason: reason,
      }));
      toast('המסמך הוחזר לתיקיית המסמכים');
      setRescueDoc(null);
      window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
      await refetch();
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setRescuing(false);
    }
  }

  /** Undoing what the machine did, in one action, with a mandatory reason.
   *
   *  The server is the enforcement: `revert_document_auto_action` refuses an empty or
   *  whitespace-only reason by name (`reason_required`), refuses anyone who is not owner/office,
   *  refuses a second reversal (`auto_action_already_reverted`), and refuses outright when money
   *  has been allocated against the invoice — that last one arrives as
   *  `invoice_has_financial_references` from the live `soft_delete_invoice`, and `toHebrewError`
   *  already names it. The dialog is the courtesy, never the fence.
   *
   *  `refetch` AND `refetchAutoActions`, because one reversal changes two things a person is
   *  looking at: the row goes back to לא משויך, and the "שויך אוטומטית" badge must disappear.
   *  Refreshing one and not the other would leave the screen contradicting itself. */
  async function revertAutoAction(reason?: string) {
    const action = revertDoc ? autoActionFor(revertDoc) : null;
    if (!action || !reason) return;
    setReverting(true);
    try {
      ok(await supabase.rpc('revert_document_auto_action', {
        p_action_id: action.id,
        p_reason: reason,
      }));
      toast('השיוך האוטומטי בוטל והמסמך חזר לתיקיית המסמכים');
      setRevertDoc(null);
      window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
      await Promise.all([refetch(), refetchAutoActions()]);
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setReverting(false);
    }
  }

  /** Removal from the archive takes NO reason, by the owner's ruling (OPEN-DECISIONS #110), and
   *  needs no new database mechanism: this is decision #28's existing soft delete — the row is
   *  hidden, the stored file is kept for audit. Same statement AttachmentsPanel.tsx:142-144
   *  issues, same policy (documents_soft_delete, owner/office). */
  async function removeDoc() {
    if (!deleteDoc) return;
    setDeleting(true);
    try {
      ok(await supabase.from('documents').update({
        deleted_at: new Date().toISOString(), deleted_by: profile?.id ?? null,
      }).eq('id', deleteDoc.id));
      toast('המסמך הוסר');
      setDeleteDoc(null);
      window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
      await refetch();
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setDeleting(false);
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

  // The filing column is a question about the documents folder and it has no answer on the
  // archive: every row there reads "לא משויך" through isUnfiled(), which calls a deliberately
  // filed document unfiled. Dropping the column is the honest move — see isUnfiled's note.
  const columns: Column<GalleryDocument>[] = ([
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
    {
      // A document nobody has read yet has no subtype, and `other` is the row's placeholder for
      // that — not an answer. Since the upload form stopped asking, rendering it as "מסמך נוסף"
      // would put a category on a page the system has not opened. Dash, per the standing rule
      // that missing evidence is `—` and never a fabricated value. Once the interpretation lands,
      // 0084's trigger writes the real subtype and this cell says it; a document that genuinely
      // IS `other` reaches a read state and reads "מסמך נוסף" honestly.
      key: 'kind', header: 'סוג', sortValue: (doc) => doc.document_kind,
      render: (doc) => {
        const stage = processing.data === null ? null : processing.snapshots[doc.id]?.stage ?? 'unprocessed';
        const unread = doc.document_kind === 'other' && stage !== null
          && ['unprocessed', 'queued', 'processing', 'extracted'].includes(stage);
        return unread
          ? <span className="text-ink-muted" title="המערכת טרם קראה את המסמך">—</span>
          : documentKindLabel(doc.document_kind);
      },
    },
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
      key: 'processing', header: 'מצב', mobileLabel: null, priority: 3,
      // Sorted by the state on screen, not by the stage underneath — with four labels, the seven
      // internal names would scatter identical-looking badges apart — and ranked by urgency rather
      // than by name, so ascending puts what waits on a person at the top. See USER_STATE_URGENCY.
      sortValue: (doc) => statusFor(doc).priority,
      render: (doc) => (
        <DocumentStatusBadge status={statusFor(doc)} data-testid="document-processing-status"
          data-document-id={doc.id}
          data-stage={processing.data === null ? undefined : processing.snapshots[doc.id]?.stage ?? 'unprocessed'} />
      ),
    },
  ] as Array<Column<GalleryDocument> | null>).filter((column): column is Column<GalleryDocument> => column !== null);

  const hasFilters = !!(q || supplierId || kind || from || to || filing !== 'all' || processingFilter !== 'all');
  const advancedFilterCount = [supplierId, kind, from, to, !archive && filing !== 'all' ? filing : ''].filter(Boolean).length;
  const revertAction = revertDoc ? autoActionFor(revertDoc) : null;

  // Heading and icon track the nav label, because pageTitleFor derives the tab title from the
  // sidebar item and a different word would put two names on one screen. `ארכיון מסמכים` qualifies
  // the nav item's bare `ארכיון`, which can afford to be short because it sits under the מסמכים
  // group header; the page has no header above it. One name, one of them qualified.
  const HeadingIcon = archive ? Archive : FolderOpen;
  // Two ways to be empty, and they are different facts: a filter that matched nothing, and a
  // register with nothing in it. Only the second differs between the two routes. Neither may
  // stand in for a failed read (gate B30) — a failed first load renders ErrorNote instead of the
  // table, and a failed refetch keeps its own ErrorNote above whatever rows survived.
  const empty = archive
    ? { title: 'אין מסמכים בארכיון', subtitle: 'מסמכים שהמערכת לא הצליחה לשייך לאף קטגוריה יופיעו כאן' }
    : { title: 'אין מסמכים במערכת', subtitle: 'מסמך חדש יופיע כאן מיד לאחר צילום או העלאה' };

  return (
    <div className="space-y-4" data-testid="documents-page">
      {/* No upload button on the archive. uploadDocument writes entity_type='inbox', so a file
            sent from here would toast "הועלה וממתין לעיבוד" over a list that stays empty — the app
            reporting a success the screen contradicts. What the archive has no path for is
            CAPTURE: documents_insert does not admit 'archive', so no browser upload can land
            here. Filing an *existing* document here is a different thing and is possible since
            0075 — file_document accepts ('archive', null) for owner/office, with a reason and an
            audit row — it simply has no control on this screen, because the intended filer is
            the interpretation layer (task C2, not yet written). */}
      <PageHeader title={<span className="flex items-center gap-2"><HeadingIcon size={22} /> {archive ? 'ארכיון מסמכים' : 'תיקיית המסמכים'}</span>}
        meta={!archive ? 'כל החשבוניות, תעודות המשלוח, הזיכויים והמסמכים הנוספים במקום אחד.' : undefined}
        actions={<>
          {canUpload && !archive && (
            <button type="button" className="btn-primary" onClick={() => setUploadOpen(true)}>
              <Upload size={16} /> העלאת מסמך
            </button>
          )}
          <Link className="btn-secondary" to={archive ? '/documents' : '/documents/archive'}>
            {archive ? <FolderOpen size={16} /> : <Archive size={16} />}{archive ? 'חזרה לתיקיית המסמכים' : 'ארכיון'}
          </Link>
        </>} />

      {!archive && <UploadCenter />}

      <section aria-label="סינון מסמכים" className="border-y border-line-soft bg-surface px-3 py-3 sm:px-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label>
            <span className="label">שם קובץ</span>
            <span className="relative block">
              <Search size={15} className="absolute top-1/2 start-3 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
              <input type="search" className="input ps-9!" value={q} onChange={(event) => setQ(event.target.value)} placeholder="חיפוש מסמך..." />
            </span>
          </label>
          <ProcessingFilterSelect value={processingFilter} onChange={setProcessing}
            includeAssignmentStates={!archive} />
        </div>
        <details className="group mt-3 border-t border-line-soft pt-2">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-sm font-medium text-action hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
            מסננים נוספים
            {advancedFilterCount > 0 && <span className="badge badge-info num">{advancedFilterCount}</span>}
            <ChevronDown size={16} className="ms-auto transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="grid grid-cols-1 gap-3 pt-3 sm:grid-cols-2 lg:grid-cols-4">
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
            {!archive && (
              <label>
                <span className="label">סטטוס תיוק</span>
                <select className="input" value={filing} onChange={(event) => setFiling(event.target.value)}>
                  <option value="all">הכול</option>
                  <option value="unfiled">לא משויכים</option>
                  <option value="linked">משויכים</option>
                </select>
              </label>
            )}
            <label><span className="label">מתאריך</span><input type="date" className="input num" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label><span className="label">עד תאריך</span><input type="date" className="input num" value={to} onChange={(event) => setTo(event.target.value)} /></label>
            <div className="flex items-end"><button type="button" className="btn-ghost min-h-11" disabled={!hasFilters} onClick={resetFilters}><X size={15} /> ניקוי מסננים</button></div>
          </div>
        </details>
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
      {interpretFailure && (
        <Note tone="alert">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{interpretFailure.message}</span>
            <button type="button" className="btn-secondary min-h-11" onClick={() => {
              interpretAttempts.current.delete(interpretFailure.jobId);
              setInterpretFailure(null);
              setInterpretRetryTick((value) => value + 1);
            }}>
              ניסיון פענוח נוסף
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
              <DocumentStatusBadge status={statusFor(doc)} data-testid="document-processing-status"
                data-document-id={doc.id}
                data-stage={processing.data === null ? undefined : processing.snapshots[doc.id]?.stage ?? 'unprocessed'} />
            </span>
          )}
          rowActions={(doc) => {
            const snapshot = processing.snapshots[doc.id];
            const autoAction = autoActionFor(doc);
            return [
              { key: 'review', label: 'בדיקת מסמך', icon: FileSearch, hidden: !snapshot?.job, onSelect: () => review(doc) },
              { key: 'enqueue', label: 'שליחה לעיבוד', icon: RefreshCw, hidden: !canEnqueue || snapshot?.stage !== 'unprocessed', onSelect: () => setRetryDoc(doc) },
              { key: 'retry', label: 'עיבוד מחדש', icon: RefreshCw,
                hidden: !canRetry || !snapshot || !['failed', 'review', 'completed'].includes(snapshot.stage),
                onSelect: () => setRetryDoc(doc) },
              { key: 'export', label: 'ייצוא', icon: FileDown, hidden: snapshot?.stage !== 'review' && snapshot?.stage !== 'completed', onSelect: () => review(doc, 'export') },
              { key: 'view', label: 'צפייה במקור', icon: Eye, onSelect: () => void open(doc) },
              // Not offered on the archive, for the same reason the upload button is not. isUnfiled
              // reads an archived row as unfiled (entity_id is null), so both would render — and
              // file_document's guard takes only a row still in the inbox (0019:167), so either
              // would raise document_already_filed, i.e. "המסמך כבר שויך ליעד עסקי" about a document
              // sitting here precisely because it could not be assigned to any target. Whether a
              // person may rescue a document from the archive is a real and open question; an
              // action that always errors is not an answer to it.
              { key: 'invoice', label: 'שיוך לחשבונית', icon: FileInput, hidden: !canFile || archive || !isUnfiled(doc), onSelect: () => setRefile({ doc, target: 'invoice' }) },
              { key: 'receipt', label: 'שיוך לקבלת סחורה', icon: ReceiptText, hidden: !canFile || archive || !isUnfiled(doc), onSelect: () => setRefile({ doc, target: 'goods_receipt' }) },
              // The clean complement of the two gates above: `!canFile || !archive`, so the
              // archive's filing action appears exactly where theirs do not. It is its own key
              // and its own RPC — rescue_document_from_archive, not file_document, whose guard
              // structurally refuses any non-inbox row (0019:167). The document returns to the
              // folder as unfiled, where those two actions then work on it for real.
              { key: 'rescue', label: 'החזרה לטיפול', icon: Undo2, hidden: !canFile || !archive, onSelect: () => setRescueDoc(doc) },
              // The undo for a decision no human made. Gated on the AUTO-ACTION EXISTING, not on
              // the document being filed: "this row has an invoice" and "a machine wrote that
              // invoice" are different facts, and only the second one is reversible here — a
              // colleague's invoice is undone from the invoice screen, by its own command. The
              // role gate matches the server's (owner/office, the authority every comparable
              // reversal in this codebase uses); the server refuses regardless of what this hides.
              { key: 'revert-auto', label: 'ביטול השיוך האוטומטי', icon: RotateCcw, tone: 'danger',
                hidden: !canFile || !autoAction, onSelect: () => setRevertDoc(doc) },
              // Removal from the archive: no reason, by the owner's ruling (#110). Nothing new
              // in the database — decision #28's soft delete, the stored file kept for audit.
              { key: 'delete', label: 'הסרה', icon: Trash2, tone: 'danger', hidden: !canFile || !archive, onSelect: () => setDeleteDoc(doc) },
              // Removal WITH the consequences computed first (0116/0119), offered in the folder
              // rather than the archive. The archive's action above stays exactly as it is —
              // owner ruling #110 settled that removing an archived document needs no reason —
              // and this is the different case: a document that CREATED something. It asks for a
              // reason, shows what would go with it, and blocks the destructive option by name
              // when a safe reversal cannot be proven.
              { key: 'remove-with-impact', label: 'הסרה עם תצוגת השפעה', icon: Trash2, tone: 'danger',
                hidden: !canRemoveDocument || archive, onSelect: () => setRemovalDoc(doc) },
            ];
          }}
          emptyTitle={data?.docs.length ? 'לא נמצאו מסמכים לפי הסינון' : empty.title}
          emptySubtitle={data?.docs.length ? 'שנו או נקו את המסננים כדי לראות מסמכים נוספים' : empty.subtitle} />
      )}

      {uploadOpen && <UploadModal suppliers={data?.suppliers ?? []} onClose={() => setUploadOpen(false)} onDone={refetch} />}
      {refile && <RefileModal doc={refile.doc} target={refile.target} onClose={() => setRefile(null)} onDone={refetch} />}
      <ConfirmDialog open={!!retryDoc} onClose={() => setRetryDoc(null)} onConfirm={() => void retry()}
        title={processing.snapshots[retryDoc?.id ?? '']?.stage === 'unprocessed' ? 'שליחת המסמך לעיבוד' : 'עיבוד המסמך מחדש'}
        message={processing.snapshots[retryDoc?.id ?? '']?.stage === 'unprocessed'
          ? 'המסמך השמור יישלח כעת לתור העיבוד.'
          : 'ניסיון חדש שומר את תוצאות העיבוד הקודמות ומוסיף ניסיון נפרד.'}
        confirmLabel={processing.snapshots[retryDoc?.id ?? '']?.stage === 'unprocessed' ? 'שליחה לתור' : 'החזרה לתור'}
        busy={retrying} />

      {/* requireReason, always. The reason travels to audit_logs through the RPC, and the
          server refuses an empty one by name (reason_required) regardless of what the browser
          sends — this dialog is the courtesy, not the enforcement. */}
      <ConfirmDialog open={!!rescueDoc} onClose={() => setRescueDoc(null)} onConfirm={(reason) => void rescue(reason)}
        title="החזרת מסמך לטיפול"
        message={`המסמך "${rescueDoc?.file_name ?? ''}" יחזור לתיקיית המסמכים כלא משויך, ויהיה אפשר לשייך אותו לחשבונית או לקבלת סחורה.`}
        confirmLabel="החזרה לטיפול" requireReason busy={rescuing} />

      {/* The one dialog in this app that undoes a financial record nobody authorised by hand, so it
          says all four things before it offers the button: WHAT the machine did, at what
          CONFIDENCE, what the undo will change, and what survives it. `requireReason` is not a
          courtesy here either — the reason lands in audit_logs as the only human sentence attached
          to the whole episode, and the server refuses an empty one by name regardless. */}
      <ConfirmDialog open={!!revertDoc} onClose={() => setRevertDoc(null)}
        onConfirm={(reason) => void revertAutoAction(reason)}
        title="ביטול השיוך האוטומטי"
        message={`המסמך "${revertDoc?.file_name ?? ''}" שויך אוטומטית לחשבונית שהמערכת יצרה בעצמה, ללא אישור אדם, ברמת ביטחון ${revertAction ? autoActionConfidence(revertAction) : 'לא ידועה'}. הביטול יסיר את החשבונית (הרשומה נשמרת לביקורת), יחזיר את המסמך לתיקייה כלא משויך, ויסגור חריגה שנפתחה בעקבות השיוך — לא מפני שהפער נבדק. רישום היצירה ורישום הביטול נשמרים שניהם ביומן הביקורת.`}
        confirmLabel="ביטול השיוך" danger requireReason busy={reverting} />

      {/* No requireReason, deliberately: #110 rules that removal from the archive needs none.
          The message says what actually happens to the bytes, because "הסרה" alone would read
          as destruction and the file is kept. */}
      <ConfirmDialog open={!!deleteDoc} onClose={() => setDeleteDoc(null)} onConfirm={() => void removeDoc()}
        title="הסרת מסמך מהארכיון"
        message={`המסמך "${deleteDoc?.file_name ?? ''}" יוסר מהרשימה. הקובץ נשמר לביקורת.`}
        confirmLabel="הסרה" danger busy={deleting} />

      <DocumentRemovalDialog
        documentId={removalDoc?.id ?? ''}
        open={!!removalDoc}
        onClose={() => setRemovalDoc(null)}
        onRemoved={() => { void refetch(); }} />

    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Camera, FileText, Loader2, Paperclip, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { useToast, Skeleton, ConfirmDialog, ErrorNote, Note, StatusBadge } from './ui';
import { ok, toHebrewError } from '../lib/errors';
import { useQuery, unwrap } from '../lib/useQuery';
import type { DocumentKind, DocumentRow } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { openReservedPopup } from '../lib/popup';
import {
  mergeUploadBatchSummary,
  runUploadBatch,
  type UploadBatchResult,
  type UploadBatchSummary,
} from '../lib/uploadBatch';
import { fetchAll } from '../lib/supabasePaging';
import { DOCUMENT_PROCESSING_STAGE_META, useDocumentProcessing } from '../lib/useDocumentProcessing';

export const DOCUMENT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

const DOCUMENT_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  avif: 'image/avif',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  odt: 'application/vnd.oasis.opendocument.text',
};

const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/avif',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/rtf', 'text/rtf',
  'text/plain', 'text/html',
  'application/vnd.oasis.opendocument.text',
]);

export const DOCUMENT_UPLOAD_ACCEPT = [
  ...DOCUMENT_MIME_TYPES,
  ...Object.keys(DOCUMENT_MIME_BY_EXTENSION).map((extension) => `.${extension}`),
].join(',');

class DocumentUploadError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly registered = false) {
    super(message);
  }
}

export function documentUploadFailure(error: unknown) {
  if (error instanceof DocumentUploadError) {
    return { message: error.message, retryable: error.retryable, registered: error.registered };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const retryable = /(?:failed to fetch|fetch failed|network|timed? ?out|temporar(?:y|ily)|service unavailable|\b(?:408|429|5\d\d)\b)/i.test(raw);
  return { message: toHebrewError(error), retryable, registered: false };
}

export function mergeDocumentUploadSummary(
  previous: UploadBatchSummary | null,
  attempted: readonly File[],
  result: UploadBatchResult<File>,
) {
  const remainingAttempts = new Map<string, number>();
  for (const file of attempted) remainingAttempts.set(file.name, (remainingAttempts.get(file.name) ?? 0) + 1);
  const untouchedFailures = (previous?.failed ?? []).filter((name) => {
    const count = remainingAttempts.get(name) ?? 0;
    if (!count) return true;
    remainingAttempts.set(name, count - 1);
    return false;
  });
  const current = mergeUploadBatchSummary(previous, result, (file) => file.name);
  return { ...current, failed: [...untouchedFailures, ...current.failed] };
}

function uploadMimeType(file: File) {
  if (file.size > DOCUMENT_UPLOAD_MAX_BYTES) {
    throw new DocumentUploadError('הקובץ גדול מ־10MB. יש לבחור קובץ קטן יותר.', false);
  }
  const suppliedMime = file.type.trim().toLowerCase();
  if (DOCUMENT_MIME_TYPES.has(suppliedMime)) return suppliedMime;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const extensionMime = DOCUMENT_MIME_BY_EXTENSION[extension];
  if (extensionMime) return extensionMime;
  throw new DocumentUploadError('סוג הקובץ אינו נתמך. ניתן להעלות PDF, תמונה, Excel, Word, RTF, TXT, HTML או ODT.', false);
}

export const DOCUMENT_KIND_OPTIONS: { value: DocumentKind; label: string }[] = [
  { value: 'invoice', label: 'חשבונית' },
  { value: 'delivery_note', label: 'תעודת משלוח' },
  { value: 'credit', label: 'זיכוי' },
  { value: 'quote', label: 'הצעת מחיר' },
  { value: 'payment_confirmation', label: 'אישור תשלום' },
  { value: 'other', label: 'מסמך נוסף' },
];

export function documentKindLabel(kind: DocumentKind) {
  return DOCUMENT_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? 'מסמך נוסף';
}

export interface DocumentMetadata {
  documentKind?: DocumentKind;
  supplierId?: string | null;
  documentDate?: string | null;
  enqueueProcessing?: boolean;
}

function defaultDocumentKind(entityType: string): DocumentKind {
  if (entityType === 'invoice') return 'invoice';
  if (entityType === 'goods_receipt') return 'delivery_note';
  if (entityType === 'payment') return 'payment_confirmation';
  return 'other';
}

/**
 * Uploads a file to the private `documents` bucket and registers it on an entity.
 * A null entityId is an inbox capture (migration 0014): the file lands under
 * {org_id}/inbox/ and the row carries entity_type='inbox' with no entity until it is
 * re-filed from /inbox. The stored object never moves on re-filing — the bucket policy
 * reads only the leading org segment.
 */
export async function uploadDocument(orgId: string, entityType: string, entityId: string | null, file: File, metadata: DocumentMetadata = {}) {
  const mimeType = uploadMimeType(file);
  const safeName = file.name.replace(/[^\w.\-]+/g, '_');
  const { data: user, error: userError } = await supabase.auth.getUser();
  if (userError || !user.user) throw new Error(userError?.message ?? 'unauthenticated');
  // org_id must lead the path -- the bucket's RLS policy reads it to enforce tenant isolation.
  const path = entityId
    ? `${orgId}/${entityType}/${entityId}/${Date.now()}_${safeName}`
    : `${orgId}/inbox/${Date.now()}_${safeName}`;
  // Upload the exact File object. Canvas/Blob conversion would discard source pixels,
  // orientation and metadata needed by OCR and long-term document evidence.
  const up = await supabase.storage.from('documents').upload(path, file, { contentType: mimeType });
  if (up.error) throw new Error(up.error.message);
  const ins = await supabase.from('documents').insert({
    org_id: orgId, entity_type: entityType, entity_id: entityId,
    storage_path: path, file_name: file.name, mime_type: mimeType, uploaded_by: user.user.id,
    document_kind: metadata.documentKind ?? defaultDocumentKind(entityType),
    supplier_id: metadata.supplierId ?? null,
    document_date: metadata.documentDate ?? null,
  }).select('id').single();
  if (ins.error || !ins.data) {
    // The row never existed, so this cleanup can only target the object created above.
    // Preserve the insert error: a cleanup failure is secondary and must not hide the cause.
    try {
      const cleanup = await supabase.storage.from('documents').remove([up.data.path]);
      if (cleanup.error) console.error('[supplyflow] failed to clean up unregistered document', cleanup.error.message);
    } catch (cleanupError) {
      console.error('[supplyflow] failed to clean up unregistered document', cleanupError);
    }
    throw new Error(ins.error?.message ?? 'document registration failed');
  }
  if (metadata.enqueueProcessing === false) {
    return { documentId: ins.data.id, jobId: null };
  }
  const queued = await supabase.rpc('enqueue_document_processing', { p_document_id: ins.data.id });
  if (queued.error || typeof queued.data !== 'string') {
    // The source and registry row are durable now; retrying the whole upload would duplicate them.
    throw new DocumentUploadError(
      'הקובץ נשמר, אך לא נכנס לתור העיבוד. ניתן לנסות עיבוד מחדש מגלריית המסמכים.',
      false,
      true,
    );
  }
  return { documentId: ins.data.id, jobId: queued.data };
}

async function entityMetadata(entityType: string, entityId: string, documentKind: DocumentKind): Promise<DocumentMetadata> {
  if (entityType === 'invoice') {
    const row = unwrap(await supabase.from('invoices').select('supplier_id, invoice_date').eq('id', entityId).single()) as {
      supplier_id: string; invoice_date: string;
    };
    return { documentKind, supplierId: row.supplier_id, documentDate: row.invoice_date };
  }
  if (entityType === 'goods_receipt') {
    const row = unwrap(await supabase.from('goods_receipts')
      .select('received_at, order:purchase_orders(supplier_id)').eq('id', entityId).single()) as {
      received_at: string | null; order: { supplier_id: string } | null;
    };
    return { documentKind, supplierId: row.order?.supplier_id ?? null, documentDate: row.received_at?.slice(0, 10) ?? null };
  }
  if (entityType === 'payment') {
    const row = unwrap(await supabase.from('payments').select('supplier_id, paid_date').eq('id', entityId).single()) as {
      supplier_id: string; paid_date: string;
    };
    return { documentKind, supplierId: row.supplier_id, documentDate: row.paid_date };
  }
  return { documentKind };
}

export function DocumentList({ entityType, entityId, canUpload = true, capture }: {
  entityType: string; entityId: string; canUpload?: boolean; capture?: boolean;
}) {
  const { profile } = useAuth();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [uploadSummary, setUploadSummary] = useState<UploadBatchSummary | null>(null);
  const [pending, setPending] = useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [documentKind, setDocumentKind] = useState<DocumentKind>(() => defaultDocumentKind(entityType));
  const canDelete = profile?.role === 'owner' || profile?.role === 'office';
  const canReview = profile != null && ['owner', 'office', 'kitchen'].includes(profile.role);

  useEffect(() => setDocumentKind(defaultDocumentKind(entityType)), [entityType]);

  const { data: docs, loading, fetching, error, refetch } = useQuery<DocumentRow[]>(async () =>
    fetchAll<DocumentRow>((from, to) => supabase.from('documents').select('*').eq('entity_type', entityType).eq('entity_id', entityId)
      .is('deleted_at', null).order('created_at', { ascending: false }).order('id').range(from, to)),
    [entityType, entityId]);
  const processing = useDocumentProcessing(canReview && docs ? docs.map((doc) => doc.id) : []);

  async function uploadFiles(files: File[], previousSummary: UploadBatchSummary | null = null) {
    if (!files.length || !profile) return;
    setBusy(true);
    try {
      const metadata = await entityMetadata(entityType, entityId, documentKind);
      const result = await runUploadBatch(files, (file) => uploadDocument(profile.org_id, entityType, entityId, file, {
        ...metadata,
        enqueueProcessing: canReview,
      }));
      const failures = result.failed.map(({ item, error }) => ({ item, ...documentUploadFailure(error) }));
      const failed = failures.filter(({ retryable }) => retryable).map(({ item }) => item);
      const registered = failures.filter(({ registered: isRegistered }) => isRegistered).length;
      setRetryFiles(failed);
      const summary = mergeDocumentUploadSummary(previousSummary, files, result);
      setUploadSummary(summary);
      if (result.succeeded.length || registered) await refetch();
      if (summary.failed.length) {
        const succeededLabel = canReview ? 'הועלו וממתינים לעיבוד' : 'הועלו';
        const detail = failures[0] ? ` ${failures[0].message}` : '';
        toast(`${summary.succeeded.length} ${succeededLabel}, ${summary.failed.length} לא הושלמו.${detail}`, 'error');
      } else {
        toast(canReview
          ? result.succeeded.length === 1 ? 'הועלה וממתין לעיבוד' : `${result.succeeded.length} קבצים הועלו וממתינים לעיבוד`
          : result.succeeded.length === 1 ? 'הקובץ הועלה בהצלחה' : `${result.succeeded.length} קבצים הועלו בהצלחה`);
      }
    } catch (e) {
      const failure = documentUploadFailure(e);
      setRetryFiles(failure.retryable ? files : []);
      setUploadSummary(mergeDocumentUploadSummary(previousSummary, files, {
        succeeded: [],
        failed: files.map((item) => ({ item, error: e })),
      }));
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  function onPick(files: FileList | null) {
    if (!files?.length) return;
    setUploadSummary(null);
    void uploadFiles(Array.from(files));
  }

  async function open(doc: DocumentRow) {
    const result = await openReservedPopup(async () => {
      const { data, error } = await supabase.storage.from('documents').createSignedUrl(doc.storage_path, 300);
      if (error || !data) throw error ?? new Error('missing signed URL');
      return data.signedUrl;
    });
    if (result === 'blocked') toast('הדפדפן חסם את חלון הצפייה. יש לאפשר חלונות קופצים ולנסות שוב.', 'error');
    if (result === 'error') toast('שגיאה בפתיחת הקובץ', 'error');
  }

  // Soft delete (migration 0010). Was a one-click hard delete of both the row and the stored
  // file, with no confirmation and no error check — the only destructive action in the app
  // without a ConfirmDialog, and the deleted file is the scan of the original document.
  //
  // The stored object is deliberately left in place. Clearing the row while destroying the
  // bytes would keep the record and lose the document, which defeats the purpose of a soft
  // delete on a financial record.
  async function remove(doc: DocumentRow) {
    setDeleting(true);
    try {
      ok(await supabase.from('documents')
        .update({ deleted_at: new Date().toISOString(), deleted_by: profile?.id ?? null })
        .eq('id', doc.id));
      toast('המסמך הוסר');
      setPending(null);
      await refetch();
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <span className="text-sm font-medium text-ink-soft flex items-center gap-1.5"><Paperclip size={15} /> מסמכים מצורפים</span>
        {canUpload && <div className="flex flex-wrap items-center gap-2">
          {entityType === 'goods_receipt' && (
            <label className="flex items-center gap-1.5 text-xs text-ink-soft">
              סוג
              <select className="input w-auto! py-1.5!" value={documentKind}
                onChange={(event) => setDocumentKind(event.target.value as DocumentKind)}>
                <option value="delivery_note">תעודת משלוח</option>
                <option value="invoice">חשבונית</option>
                <option value="other">מסמך נוסף</option>
              </select>
            </label>
          )}
          <button className="btn-secondary py-1.5!" disabled={busy || retryFiles.length > 0} onClick={() => inputRef.current?.click()}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : capture ? <Camera size={15} /> : <Paperclip size={15} />}
              {capture ? 'צילום / העלאה' : 'העלאת קובץ'}
          </button>
        </div>}
        <input ref={inputRef} type="file" hidden multiple accept={DOCUMENT_UPLOAD_ACCEPT} data-document-upload-input
          {...(capture ? { capture: 'environment' as const } : {})}
          onChange={(e) => void onPick(e.target.files)} />
      </div>
      {uploadSummary && (
        <Note tone={uploadSummary.failed.length ? 'alert' : 'done'} className="mb-2">
          <div role="status">
            <div>
              <span className="num">{uploadSummary.succeeded.length}</span> {canReview ? 'הועלו וממתינים לעיבוד' : 'הועלו'} ·{' '}
              <span className="num">{uploadSummary.failed.length}</span> לא הושלמו
            </div>
            {uploadSummary.failed.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs">נכשלו: {uploadSummary.failed.join(', ')}</span>
                {retryFiles.length > 0 && (
                  <button type="button" className="btn-ghost min-h-11" disabled={busy} onClick={() => void uploadFiles(retryFiles, uploadSummary)}>
                    ניסיון חוזר לנכשלים בלבד
                  </button>
                )}
              </div>
            )}
          </div>
        </Note>
      )}
      {error && docs && <ErrorNote message={error} />}
      {processing.error && docs && <ErrorNote message={processing.error} />}
      {fetching && docs && <div className="mb-2 text-xs text-ink-muted" role="status">רשימת המסמכים מתעדכנת…</div>}
      {error && !docs ? (
        <ErrorNote message={error} />
      ) : loading ? (
        // Not cosmetic: `docs` is null while fetching, and the empty branch below claims
        // "no documents". On an invoice that reads as "no scan attached" when there is one.
        <div className="border border-line-soft rounded-lg divide-y divide-line-soft" role="status" aria-busy="true">
          <span className="sr-only">טוען מסמכים</span>
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2.5">
              <Skeleton className="h-3.5 w-3.5 shrink-0" />
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-24 ms-auto shrink-0" />
            </div>
          ))}
        </div>
      ) : docs?.length ? (
        <ul className="divide-y divide-line-soft border border-line-soft rounded-lg">
          {docs.map((d) => {
            const stage = processing.data ? processing.snapshots[d.id]?.stage ?? 'unprocessed' : null;
            return (
              <li key={d.id} className="flex min-h-14 flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <FileText size={15} className="shrink-0 text-ink-faint" />
                <button className="link min-w-32 flex-1 truncate text-start" onClick={() => void open(d)}>{d.file_name}</button>
                <span className="hidden text-xs text-ink-muted sm:inline">{documentKindLabel(d.document_kind)}</span>
                {canReview && (
                  <span data-document-processing-status={stage ?? 'loading'}>
                    {stage
                      ? <StatusBadge meta={DOCUMENT_PROCESSING_STAGE_META[stage]} />
                      : <><Skeleton className="h-6 w-24" /><span className="sr-only">סטטוס העיבוד נטען</span></>}
                  </span>
                )}
                <span className="text-xs text-ink-muted">{fmtDateTime(d.created_at)}</span>
                {canReview && (
                  <Link to={`/documents/${d.id}/review`} className="btn-ghost min-h-11 px-2!" data-document-review-link>
                    בדיקה
                  </Link>
                )}
                {canDelete && (
                  <button className="btn-ghost p-1.5! min-w-11 min-h-11 text-ink-faint hover:text-alert-solid" onClick={() => setPending(d)} aria-label="מחיקה">
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="text-sm text-ink-muted border border-dashed border-line rounded-lg px-3 py-4 text-center">אין מסמכים</div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => { if (pending) void remove(pending); }}
        title="הסרת מסמך"
        message={`המסמך "${pending?.file_name ?? ''}" יוסר מהרשימה. הקובץ עצמו נשמר, וההסרה ניתנת לביטול על ידי מנהל המערכת.`}
        confirmLabel="הסרה"
        danger
        busy={deleting}
      />
    </div>
  );
}

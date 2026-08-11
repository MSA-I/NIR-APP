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
  type UploadBatchResult,
  type UploadBatchSummary,
} from '../lib/uploadBatch';
import { fetchAll } from '../lib/supabasePaging';
import { DOCUMENT_USER_STATE_META, documentUserState, useDocumentProcessing } from '../lib/useDocumentProcessing';
import { TusUploadCancelledError, TusUploadError, tusUploadToDocuments } from '../lib/tusUpload';
import {
  claimPendingPhotos,
  deletePendingPhoto,
  putPendingPhoto,
  receiptPendingServerAcceptance,
  updatePendingPhoto,
} from '../lib/offlineDb';
import { offlineQueue } from '../lib/offlineQueue';
import {
  UploadCenter,
  claimActiveUploadTask,
  enqueueUploadCenterBatch,
  getUploadCenterSnapshot,
  subscribeUploadCenter,
} from './UploadCenter';

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

/**
 * The safe resume point after a partial failure (wave 6b, the money rule).
 * `storagePath` set: the object is already durable — a retry must redo the registration
 * steps against the SAME path and never upload again. `documentId` also set: the registry
 * row exists too, and only the processing enqueue is left to redo.
 */
export interface DocumentUploadResume {
  storagePath: string;
  documentId: string | null;
}

class DocumentUploadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly registered = false,
    readonly resume: DocumentUploadResume | null = null,
  ) {
    super(message);
  }
}

const TRANSIENT_ERROR_PATTERN = /(?:failed to fetch|fetch failed|network|timed? ?out|temporar(?:y|ily)|service unavailable|\b(?:408|429|5\d\d)\b)/i;

export function documentUploadFailure(error: unknown) {
  if (error instanceof DocumentUploadError) {
    return { message: error.message, retryable: error.retryable, registered: error.registered, resume: error.resume };
  }
  if (error instanceof TusUploadCancelledError) {
    return { message: 'ההעלאה בוטלה.', retryable: false, registered: false, resume: null };
  }
  if (error instanceof TusUploadError) {
    return { message: error.message, retryable: error.retryable, registered: false, resume: null };
  }
  const raw = error instanceof Error ? error.message : String(error);
  return { message: toHebrewError(error), retryable: TRANSIENT_ERROR_PATTERN.test(raw), registered: false, resume: null };
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

/**
 * True when the processing queue simply is not installed on this database.
 *
 * The smart-document migrations ship separately from this bundle, so a frontend can legitimately
 * run against a database where `enqueue_document_processing` does not exist yet. That is not an
 * upload failure: the file and its registry row are already durable by the time it is called.
 * Reporting it as a failure made a stored document look lost and invited a duplicate re-upload.
 * Any other error — permission, deleted document, bad state — still surfaces.
 */
function processingQueueUnavailable(error: { code?: string; message?: string }): boolean {
  // PGRST202: PostgREST could not find the function. 42883: Postgres undefined_function.
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? '');
}

function defaultDocumentKind(entityType: string): DocumentKind {
  if (entityType === 'invoice') return 'invoice';
  if (entityType === 'goods_receipt') return 'delivery_note';
  if (entityType === 'payment') return 'payment_confirmation';
  return 'other';
}

/** Hebrew source labels for the Upload Center's "originating entity" column. */
const ENTITY_SOURCE_LABELS: Record<string, string> = {
  invoice: 'חשבונית',
  goods_receipt: 'קבלת סחורה',
  payment: 'תשלום',
  inbox: 'תיבת המסמכים',
};

/**
 * Uploads a file to the private `documents` bucket over tus and registers it on an entity.
 * A null entityId is an inbox capture (migration 0014): the file lands under
 * {org_id}/inbox/ and the row carries entity_type='inbox' with no entity until it is
 * re-filed from /inbox. The stored object never moves on re-filing — the bucket policy
 * reads only the leading org segment.
 *
 * Duplicate protection (wave 6b): the path is minted with Date.now() ONLY for a fresh
 * upload. Once the object is stored, every failure past that point carries a
 * `DocumentUploadResume`, and a retry passed back through `options.resume` redoes only
 * the failed step — insert against the same stored path, or the processing enqueue —
 * mirroring PriceListUpload's pending-registration pattern.
 */
export async function uploadDocument(
  orgId: string,
  entityType: string,
  entityId: string | null,
  file: File,
  metadata: DocumentMetadata = {},
  options: { resume?: DocumentUploadResume | null; objectKey?: string | null } = {},
) {
  // Claimed in the synchronous prologue, before any await — see UploadCenter's ambient
  // context note. Null whenever this runs outside the Center's queue.
  const center = claimActiveUploadTask();
  const mimeType = uploadMimeType(file);
  const { data: user, error: userError } = await supabase.auth.getUser();
  if (userError || !user.user) throw new Error(userError?.message ?? 'unauthenticated');
  const resume = options.resume ?? null;
  let path = resume?.storagePath ?? null;
  let documentId = resume?.documentId ?? null;
  let freshUpload = false;

  if (!path) {
    const safeName = file.name.replace(/[^\w.\-]+/g, '_');
    // org_id must lead the path -- the bucket's RLS policy reads it to enforce tenant isolation.
    const objectKey = options.objectKey ?? Date.now().toString();
    path = entityId
      ? `${orgId}/${entityType}/${entityId}/${objectKey}_${safeName}`
      : `${orgId}/inbox/${objectKey}_${safeName}`;
    // Upload the exact File object (camera captures included — tus takes the File as-is).
    // Canvas/Blob conversion would discard source pixels, orientation and metadata needed
    // by OCR and long-term document evidence.
    const handle = tusUploadToDocuments(file, {
      objectName: path,
      contentType: mimeType,
      onProgress: (percent) => center?.onProgress(percent),
    });
    center?.registerAbort(handle.abort);
    try {
      await handle.done;
    } catch (uploadError) {
      center?.registerAbort(null);
      if (uploadError instanceof TusUploadCancelledError) throw uploadError;
      if (uploadError instanceof TusUploadError) {
        // Nothing durable exists yet — a full retry is safe and mints a fresh path.
        throw new DocumentUploadError(uploadError.message, uploadError.retryable);
      }
      throw uploadError;
    }
    center?.registerAbort(null);
    freshUpload = true;
  }
  center?.markStored(documentId);

  if (!documentId) {
    const ins = await supabase.from('documents').insert({
      org_id: orgId, entity_type: entityType, entity_id: entityId,
      storage_path: path, file_name: file.name, mime_type: mimeType, uploaded_by: user.user.id,
      document_kind: metadata.documentKind ?? defaultDocumentKind(entityType),
      supplier_id: metadata.supplierId ?? null,
      document_date: metadata.documentDate ?? null,
    }).select('id').single();
    if (ins.error || !ins.data) {
      const insertMessage = ins.error?.message ?? 'document registration failed';
      // The row never existed, so this cleanup can only target the object created above.
      // Preserve the insert error: a cleanup failure is secondary and must not hide the cause.
      // On a resumed attempt the object is deliberately kept — it is the thing being resumed.
      let objectRemains = !freshUpload;
      if (freshUpload) {
        try {
          const cleanup = await supabase.storage.from('documents').remove([path]);
          if (cleanup.error) {
            objectRemains = true;
            console.error('[supplyflow] failed to clean up unregistered document', cleanup.error.message);
          }
        } catch (cleanupError) {
          objectRemains = true;
          console.error('[supplyflow] failed to clean up unregistered document', cleanupError);
        }
      }
      if (objectRemains) {
        // The object is durable but the registry row is not. The retry must redo ONLY the
        // insert against the same stored path — re-uploading would duplicate the object.
        throw new DocumentUploadError(
          'הקובץ נשמר באחסון, אך רישום המסמך לא הושלם. ניסיון חוזר ישלים את הרישום בלי להעלות מחדש.',
          true,
          false,
          { storagePath: path, documentId: null },
        );
      }
      throw new Error(insertMessage);
    }
    documentId = ins.data.id;
  }
  center?.markRegistered(documentId);
  if (metadata.enqueueProcessing === false) {
    return { documentId, jobId: null };
  }
  const queued = await supabase.rpc('enqueue_document_processing', { p_document_id: documentId });
  if (queued.error && processingQueueUnavailable(queued.error)) {
    return { documentId, jobId: null };
  }
  if (queued.error || typeof queued.data !== 'string') {
    // The source and registry row are durable now; retrying the whole upload would duplicate
    // them. `retryable` stays false so a caller without resume-awareness never re-uploads;
    // a resume-aware caller retries the enqueue alone through `resume`.
    throw new DocumentUploadError(
      'הקובץ נשמר, אך לא נכנס לתור העיבוד. ניתן לנסות עיבוד מחדש מגלריית המסמכים.',
      false,
      true,
      { storagePath: path, documentId },
    );
  }
  return { documentId, jobId: queued.data };
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

async function queuePendingDocumentPhoto(
  entityType: string,
  entityId: string,
  documentKind: DocumentKind,
  file: File,
  resume: DocumentUploadResume | null = null,
) {
  uploadMimeType(file);
  await putPendingPhoto({
    entityType,
    entityId,
    fileName: file.name,
    blob: file,
    documentKind,
    clientUploadId: crypto.randomUUID(),
    storagePath: resume?.storagePath ?? null,
    documentId: resume?.documentId ?? null,
    attempts: 0,
    state: 'pending',
    lastError: null,
    lastAttemptAt: null,
    createdAt: Date.now(),
  });
}

export function receiptPhotoMustRemainQueued(
  entityType: string,
  online: boolean,
  receiptPending: boolean,
) {
  return entityType === 'goods_receipt' && (!online || receiptPending);
}

async function runPendingDocumentPhotoSync(includeNeedsAttention: boolean) {
  const leaseOwner = crypto.randomUUID();
  const photos = await claimPendingPhotos(leaseOwner, includeNeedsAttention);
  let uploaded = 0;
  let failed = 0;
  for (const photo of photos) {
    if (photo.id == null || photo.syncVersion == null || !photo.orgId || !photo.actorUserId) { failed += 1; continue; }
    if (photo.state === 'needs_attention' && !includeNeedsAttention) { failed += 1; continue; }
    try {
      if (photo.entityType === 'goods_receipt'
        && await receiptPendingServerAcceptance(photo.entityId)) {
        await updatePendingPhoto(photo.id, {
          storagePath: photo.storagePath ?? null,
          documentId: photo.documentId ?? null,
          attempts: photo.attempts ?? 0,
          state: photo.state ?? 'pending',
          lastError: photo.lastError ?? null,
          lastAttemptAt: photo.lastAttemptAt ?? null,
          syncLeaseOwner: null,
          syncLeaseExpiresAt: null,
        }, leaseOwner, photo.syncVersion);
        continue;
      }
      const documentKind = (photo.documentKind ?? defaultDocumentKind(photo.entityType)) as DocumentKind;
      const metadata = await entityMetadata(photo.entityType, photo.entityId, documentKind);
      const file = new File([photo.blob], photo.fileName, {
        type: photo.blob.type,
        lastModified: photo.createdAt,
      });
      await uploadDocument(photo.orgId, photo.entityType, photo.entityId, file, {
        ...metadata,
        enqueueProcessing: true,
      }, {
        objectKey: photo.clientUploadId ?? `legacy-${photo.id}`,
        resume: photo.storagePath ? {
          storagePath: photo.storagePath,
          documentId: photo.documentId ?? null,
        } : null,
      });
      if (await deletePendingPhoto(photo.id, leaseOwner, photo.syncVersion)) uploaded += 1;
      else failed += 1;
    } catch (error) {
      const failure = documentUploadFailure(error);
      await updatePendingPhoto(photo.id, {
        storagePath: failure.resume?.storagePath ?? photo.storagePath ?? null,
        documentId: failure.resume?.documentId ?? photo.documentId ?? null,
        attempts: (photo.attempts ?? 0) + 1,
        state: failure.retryable || failure.resume ? 'failed' : 'needs_attention',
        lastError: failure.message,
        lastAttemptAt: Date.now(),
        syncLeaseOwner: null,
        syncLeaseExpiresAt: null,
      }, leaseOwner, photo.syncVersion);
      failed += 1;
    }
  }
  await offlineQueue.refresh();
  return { uploaded, failed };
}

let pendingDocumentPhotoSync: ReturnType<typeof runPendingDocumentPhotoSync> | null = null;

/** Uploads scoped receipt photos only after the receipt action has had a chance to sync. */
export function syncPendingDocumentPhotos(includeNeedsAttention = false) {
  pendingDocumentPhotoSync ??= runPendingDocumentPhotoSync(includeNeedsAttention).finally(() => {
    pendingDocumentPhotoSync = null;
  });
  return pendingDocumentPhotoSync;
}

export function DocumentList({ entityType, entityId, canUpload = true, capture }: {
  entityType: string; entityId: string; canUpload?: boolean; capture?: boolean;
}) {
  const { profile, organizationAccess } = useAuth();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /**
   * The safe resume point per file (the money rule): once an object is stored, every
   * retry — this screen's button or the Upload Center's — redoes only the failed step
   * against the same stored path instead of minting a new Date.now() path.
   */
  const resumeRef = useRef(new Map<File, DocumentUploadResume>());
  const registeredSeenRef = useRef(new Set<string>());
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [uploadSummary, setUploadSummary] = useState<UploadBatchSummary | null>(null);
  const [locallyQueued, setLocallyQueued] = useState(0);
  const [pending, setPending] = useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [documentKind, setDocumentKind] = useState<DocumentKind>(() => defaultDocumentKind(entityType));
  const canWrite = organizationAccess?.canWrite ?? true;
  const canDelete = canWrite && (profile?.role === 'owner' || profile?.role === 'office');
  const canReview = profile != null && ['owner', 'office', 'kitchen'].includes(profile.role);
  const canMutateDocuments = canWrite && canReview;
  const canUploadNow = canWrite && canUpload;

  useEffect(() => setDocumentKind(defaultDocumentKind(entityType)), [entityType]);

  const { data: docs, loading, fetching, error, refetch } = useQuery<DocumentRow[]>(async () =>
    fetchAll<DocumentRow>((from, to) => supabase.from('documents').select('*').eq('entity_type', entityType).eq('entity_id', entityId)
      .is('deleted_at', null).order('created_at', { ascending: false }).order('id').range(from, to)),
    [entityType, entityId]);
  const processing = useDocumentProcessing(canReview && docs ? docs.map((doc) => doc.id) : []);

  // A Center-driven retry can register a document while this screen sits idle; refresh
  // the list when that happens. Batch runs refetch once at their end (busyRef gate).
  useEffect(() => subscribeUploadCenter(() => {
    const { entries } = getUploadCenterSnapshot();
    let changed = false;
    for (const entry of entries) {
      if (entry.status === 'registered' && entry.documentId && !registeredSeenRef.current.has(entry.documentId)) {
        registeredSeenRef.current.add(entry.documentId);
        changed = true;
      }
    }
    if (changed && !busyRef.current) void refetch();
  }), [refetch]);

  async function uploadFiles(files: File[], previousSummary: UploadBatchSummary | null = null) {
    if (!files.length || !profile) return;
    setBusy(true);
    busyRef.current = true;
    try {
      const receiptPending = entityType === 'goods_receipt'
        ? await receiptPendingServerAcceptance(entityId)
        : false;
      if (receiptPhotoMustRemainQueued(entityType, navigator.onLine !== false, receiptPending)) {
        for (const file of files) await queuePendingDocumentPhoto(entityType, entityId, documentKind, file);
        setLocallyQueued((count) => count + files.length);
        setUploadSummary(null);
        await offlineQueue.refresh();
        toast(files.length === 1
          ? 'התמונה נשמרה במכשיר וממתינה לסנכרון.'
          : `${files.length} תמונות נשמרו במכשיר וממתינות לסנכרון.`);
        return;
      }
      const metadata = await entityMetadata(entityType, entityId, documentKind);
      const result = await enqueueUploadCenterBatch(
        files,
        (file) => uploadDocument(profile.org_id, entityType, entityId, file, {
          ...metadata,
          enqueueProcessing: canMutateDocuments,
        }, { resume: resumeRef.current.get(file) ?? null }),
        {
          source: ENTITY_SOURCE_LABELS[entityType] ?? 'מסמך מצורף',
          retry: true,
          classifyFailure: (file, error) => {
            const failure = documentUploadFailure(error);
            // Record the resume point the moment the failure happens, so any retry —
            // the Center's or this screen's — redoes only the failed step.
            if (failure.resume) resumeRef.current.set(file, failure.resume);
            else resumeRef.current.delete(file);
            return {
              message: failure.message,
              retryable: failure.retryable || failure.resume !== null,
              registered: failure.registered,
              storedSafely: failure.resume !== null || failure.registered,
              documentId: failure.resume?.documentId ?? null,
            };
          },
        },
      );
      for (const file of result.succeeded) resumeRef.current.delete(file);
      const failures = result.failed.map(({ item, error }) => ({ item, ...documentUploadFailure(error) }));
      const locallyStored = new Set<File>();
      if (entityType === 'goods_receipt') {
        for (const failure of failures) {
          if (!failure.retryable && failure.resume === null) continue;
          await queuePendingDocumentPhoto(entityType, entityId, documentKind, failure.item, failure.resume);
          locallyStored.add(failure.item);
        }
      }
      if (locallyStored.size) {
        setLocallyQueued((count) => count + locallyStored.size);
        await offlineQueue.refresh();
      }
      const failed = failures
        .filter(({ item, retryable, resume }) => !locallyStored.has(item) && (retryable || resume !== null))
        .map(({ item }) => item);
      const registered = failures.filter(({ registered: isRegistered }) => isRegistered).length;
      setRetryFiles(failed);
      const summary = mergeDocumentUploadSummary(previousSummary, files, {
        succeeded: result.succeeded,
        failed: result.failed.filter(({ item }) => !locallyStored.has(item)),
      });
      setUploadSummary(summary);
      if (result.succeeded.length || registered) await refetch();
      if (summary.failed.length) {
        const succeededLabel = canMutateDocuments ? 'הועלו וממתינים לעיבוד' : 'הועלו';
        const detail = failures[0] ? ` ${failures[0].message}` : '';
        toast(`${summary.succeeded.length} ${succeededLabel}, ${summary.failed.length} לא הושלמו.${detail}`, 'error');
      } else if (locallyStored.size) {
        toast(`${locallyStored.size} קבצים נשמרו במכשיר וממתינים לסנכרון.`);
      } else {
        toast(canMutateDocuments
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
      busyRef.current = false;
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
        {/* The "סוג" select that stood here — delivery note / invoice / other, chosen before the
            camera opened — is gone. This is the receiving screen: the person holding the phone is
            standing at the truck with the paper in the other hand, and the one question they
            should not be asked is which of three accounting categories it belongs to. The subtype
            is read off the document and confirmed on the review screen. `defaultDocumentKind`
            still seeds a value from the entity, and 0084's trigger replaces it with what the
            document says. */}
        {canUploadNow && <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary py-1.5!" disabled={busy || retryFiles.length > 0} onClick={() => inputRef.current?.click()}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : capture ? <Camera size={15} /> : <Paperclip size={15} />}
              {capture ? 'צילום / העלאה' : 'העלאת קובץ'}
          </button>
        </div>}
        <input ref={inputRef} type="file" hidden multiple accept={DOCUMENT_UPLOAD_ACCEPT} data-document-upload-input
          {...(capture ? { capture: 'environment' as const } : {})}
          onChange={(e) => void onPick(e.target.files)} />
      </div>
      <UploadCenter />
      {locallyQueued > 0 && (
        <Note tone="await" className="mb-2">
          <span className="num">{locallyQueued}</span> קבצים שמורים במכשיר וממתינים לסנכרון.
        </Note>
      )}
      {uploadSummary && (
        <Note tone={uploadSummary.failed.length ? 'alert' : 'done'} className="mb-2">
          <div role="status">
            <div>
              <span className="num">{uploadSummary.succeeded.length}</span> {canMutateDocuments ? 'הועלו וממתינים לעיבוד' : 'הועלו'} ·{' '}
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
                {/* G1, finding 20 — same badge, same four human states as the documents folder.
                    The raw stage stays on `data-document-processing-status`. */}
                {canReview && (
                  <span data-document-processing-status={stage ?? 'loading'}>
                    {stage
                      ? <StatusBadge meta={DOCUMENT_USER_STATE_META[documentUserState(stage)]} />
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

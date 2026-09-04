import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useRef, useState } from 'react';
import { Camera, FileText, Loader2, Paperclip, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { supabase } from '../lib/supabase';
import { signedDocumentSourceUrl } from '../lib/documentSource';
import { useAuth } from '../auth/AuthContext';
import { useToast, Skeleton, ConfirmDialog, ErrorNote, ICON, Modal, Note } from './ui';
import { ActionMenu } from './ActionMenu';
import {
  WEAK_CAPTURE_LABEL_KEY,
  WEAK_CAPTURE_PROCEED_LABEL_KEY,
  screenImageQuality,
  weakCaptureHintKey,
  weakCaptureRetryLabelKey,
  weakCaptureTitleKey,
  type CaptureSource,
  type WeakCapture,
} from '../lib/imageQuality';
import { DocumentStatusBadge } from './DocumentStatusBadge';
import { documentUiStatus } from '../lib/documentStatus';
import { ok, toErrorKey } from '../lib/errors';
import type { TKey } from '../lib/i18n/t.ts';
import { useQuery, unwrap } from '../lib/useQuery';
import type { DocumentKind, DocumentRow } from '../lib/types';
import { bidiIsolate, fmtDateTime } from '../lib/format';
import { openReservedPopup } from '../lib/popup';
import {
  mergeUploadBatchSummary,
  type UploadBatchResult,
  type UploadBatchSummary,
} from '../lib/uploadBatch';
import { fetchAll } from '../lib/supabasePaging';
import { useDocumentProcessing } from '../lib/useDocumentProcessing';
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

/**
 * HTML IS NOT A DOCUMENT TYPE (owner ruling, OPEN-DECISIONS #346, 02.09.2026).
 * `.html`/`.htm` and `text/html` were accepted here until 0288. An uploaded page is a program:
 * opened from the storage origin by a colleague it executes there, against that origin's session.
 * A supplier who exports a price table from a mail client converts it to PDF or XLSX; the type is
 * gone from the client, the storage bucket and `public.smart_document_mime_allowed`, so a rejection
 * is now the same answer at every layer instead of only the innermost one.
 */
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
  'text/plain',
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
  clientUploadKey: string;
}

interface DocumentRetryEntry {
  file: File;
  resume: DocumentUploadResume | null;
  retryable: boolean;
  storedSafely: boolean;
}

interface DocumentRetryBatch {
  id: number;
  entries: DocumentRetryEntry[];
  summary: UploadBatchSummary;
}

// A retry from QuickCapture, the inbox modal, an attachment panel or the global Upload Center
// receives the same File object. Keep its safe resume point here, at the upload boundary, so every
// caller resumes registration/enqueue and none of them has to remember how storage was reached.
// WeakMap deliberately does not retain files after the browser releases them.
const documentUploadResumeByFile = new WeakMap<File, DocumentUploadResume>();

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

type RegistrationFailureInput = {
  error: unknown;
  status?: number;
  statusText?: string;
  malformedResponse?: boolean;
};

function documentRegistrationFailure(input: RegistrationFailureInput) {
  const error = (input.error ?? {}) as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
    status?: unknown;
  };
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
  const status = typeof input.status === 'number'
    ? input.status
    : typeof error.status === 'number' ? error.status : null;
  const raw = [error.message, error.details, error.hint, input.statusText]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');

  if (input.malformedResponse) {
    return { retryable: false, code: 'document_registration_malformed_response' };
  }

  if (code === 'PGRST202' || code === '42883' || /could not find the function|function .* does not exist/i.test(raw)) {
    return { retryable: false, code: 'document_registration_unavailable' };
  }

  if (code === 'PGRST300') {
    return { retryable: false, code: 'document_registration_misconfigured' };
  }

  if (code === '42501' || code === 'PGRST301' || code === 'PGRST302'
      || /not_authorized|permission|row-level security|\brls\b|jwt/i.test(raw)) {
    return { retryable: false, code: 'document_registration_not_authorized' };
  }

  if (code === '23505' || /document_upload_key_(?:conflict|retired)/i.test(raw)) {
    return { retryable: false, code: 'document_registration_key_taken' };
  }

  if (code === '22023' || code === '22P02' || code === '23502' || code === '23503' || code === '23514'
      || /document_upload_key_invalid/i.test(raw)) {
    return { retryable: false, code: 'document_registration_invalid' };
  }

  const retryable = status === 0
    || status === 408
    || status === 429
    || status === 502
    || status === 503
    || status === 504
    || /^PGRST00[0-3]$/.test(code)
    || /^08[A-Z0-9]{3}$/.test(code)
    || /^(?:40001|40P01|55P03|57014|57P0[1-3])$/.test(code)
    || /^53[A-Z0-9]{3}$/.test(code)
    || /failed to fetch|fetch failed|network(?:error)?|connection (?:closed|reset)|timed? ?out/i.test(raw);

  if (retryable) {
    return { retryable: true, code: 'document_registration_transient' };
  }

  return { retryable: false, code: 'document_registration_failed' };
}

/**
 * What a failed upload MEANS: whether a retry can help, whether the row already exists, and where
 * to resume. It no longer answers in words.
 *
 * It used to return `message` — a finished Hebrew sentence — and three things went wrong with
 * that, all of them invisible. A `TusUploadError` carries a synthetic CODE rather than prose
 * (`tus_upload_forbidden`), so that branch was putting a token in front of a person. The sentence
 * was also written into IndexedDB as `lastError`, where `OfflineQueueStatus` reads it back
 * through `errorText()` — which maps CODES, so a stored sentence always fell through to the
 * generic one. And an English reader got Hebrew regardless.
 *
 * `code` goes to all three places instead, resolved at the moment of rendering. Every code here
 * is registered in `src/lib/errors.ts`, which is the one error vocabulary in the product.
 */
export function documentUploadFailure(error: unknown) {
  if (error instanceof DocumentUploadError) {
    return { code: error.message, retryable: error.retryable, registered: error.registered, resume: error.resume };
  }
  if (error instanceof TusUploadCancelledError) {
    return { code: 'document_upload_cancelled', retryable: false, registered: false, resume: null };
  }
  if (error instanceof TusUploadError) {
    return { code: error.message, retryable: error.retryable, registered: false, resume: null };
  }
  const raw = error instanceof Error ? error.message : String(error);
  return { code: toErrorKey(error), retryable: TRANSIENT_ERROR_PATTERN.test(raw), registered: false, resume: null };
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
    throw new DocumentUploadError('document_upload_too_large', false);
  }
  const suppliedMime = file.type.trim().toLowerCase();
  if (DOCUMENT_MIME_TYPES.has(suppliedMime)) return suppliedMime;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const extensionMime = DOCUMENT_MIME_BY_EXTENSION[extension];
  if (extensionMime) return extensionMime;
  throw new DocumentUploadError('document_upload_type_unsupported', false);
}

/** Shared validation for document flows that register through a dedicated intake RPC. */
export function documentUploadMimeType(file: File): string {
  return uploadMimeType(file);
}

export const DOCUMENT_KIND_OPTIONS: { value: DocumentKind; labelKey: TKey }[] = [
  { value: 'invoice', labelKey: 'fileUpload.kindInvoice' },
  { value: 'delivery_note', labelKey: 'fileUpload.kindDeliveryNote' },
  { value: 'credit', labelKey: 'fileUpload.kindCredit' },
  { value: 'quote', labelKey: 'fileUpload.kindQuote' },
  { value: 'payment_confirmation', labelKey: 'fileUpload.kindPaymentConfirmation' },
  { value: 'other', labelKey: 'fileUpload.kindOther' },
];

export function documentKindKey(kind: DocumentKind): TKey {
  return DOCUMENT_KIND_OPTIONS.find((option) => option.value === kind)?.labelKey ?? 'fileUpload.kindOther';
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
 * run against a database where the current intake RPC does not exist yet. That is not an
 * upload failure: the file and its registry row are already durable by the time it is called.
 * Reporting it as a failure made a stored document look lost and invited a duplicate re-upload.
 * Any other error — permission, deleted document, bad state — still surfaces.
 */
function processingQueueUnavailable(error: { code?: string; message?: string }): boolean {
  // PGRST202: PostgREST could not find the function. 42883: Postgres undefined_function.
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? '');
}

type DocumentIntakeResponse = {
  data: unknown;
  error: { code?: string; message: string } | null;
  status?: number;
  statusText?: string;
};

export async function beginDocumentIntake(documentId: string): Promise<DocumentIntakeResponse> {
  let response: DocumentIntakeResponse;
  try {
    response = await supabase.rpc('begin_document_intake', { p_document_id: documentId });
  } catch (error) {
    response = {
      data: null,
      error: { message: error instanceof Error ? error.message : 'unknown_document_intake_error' },
    };
  }
  if (!response.error || !processingQueueUnavailable(response.error)) return response;

  // Forward-only deployment compatibility: before 0136 the established enqueue RPC is still
  // authoritative. Fall back only when the new RPC is undefined. A transport failure could have
  // committed intake and must stay on the ordinary idempotent retry path.
  try {
    return await supabase.rpc('enqueue_document_processing', { p_document_id: documentId });
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : 'unknown_document_intake_error' },
    };
  }
}

function defaultDocumentKind(entityType: string): DocumentKind {
  if (entityType === 'invoice') return 'invoice';
  if (entityType === 'goods_receipt') return 'delivery_note';
  if (entityType === 'payment') return 'payment_confirmation';
  return 'other';
}

/** Source labels for the Upload Center's "originating entity" column, as keys. */
const ENTITY_SOURCE_KEYS: Record<string, TKey> = {
  invoice: 'fileUpload.sourceInvoice',
  goods_receipt: 'fileUpload.sourceGoodsReceipt',
  payment: 'fileUpload.sourcePayment',
  inbox: 'fileUpload.sourceInbox',
};

/**
 * Uploads a file to the private `documents` bucket over tus and registers it on an entity.
 * A null entityId is an inbox capture (migration 0014): the file lands under
 * {org_id}/inbox/ and the row carries entity_type='inbox' with no entity until it is
 * re-filed from /inbox. The stored object never moves on re-filing — the bucket policy
 * reads only the leading org segment.
 *
 * Duplicate protection (0131): one stable client upload key is minted before TUS starts and
 * names both the object path and the idempotent registration RPC. Once the object is stored,
 * every failure past that point carries a `DocumentUploadResume`; retry redoes only the failed
 * registration/enqueue step against the same key and path.
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
  const resume = options.resume ?? documentUploadResumeByFile.get(file) ?? null;
  const clientUploadKey = resume?.clientUploadKey ?? options.objectKey ?? crypto.randomUUID();
  let path = resume?.storagePath ?? null;
  let documentId = resume?.documentId ?? null;

  if (!path) {
    const safeName = file.name.replace(/[^\w.\-]+/g, '_');
    // org_id must lead the path -- the bucket's RLS policy reads it to enforce tenant isolation.
    const objectKey = clientUploadKey;
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
  }
  if (!documentId) {
    let registered: {
      data: unknown;
      error: unknown;
      status?: number;
      statusText?: string;
    };
    try {
      registered = await supabase.rpc('register_uploaded_document', {
        p_client_upload_key: clientUploadKey,
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_storage_path: path,
        p_file_name: file.name,
        p_mime_type: mimeType,
        p_document_kind: metadata.documentKind ?? defaultDocumentKind(entityType),
        p_supplier_id: metadata.supplierId ?? null,
        p_document_date: metadata.documentDate ?? null,
      });
    } catch (error) {
      registered = { data: null, error };
    }
    const registeredData = registered.data as { document_id?: unknown } | null;
    if (registered.error || typeof registeredData?.document_id !== 'string') {
      // The object is already durable, and an error response cannot prove whether the RPC
      // committed before the response was lost. Never delete here. The stable key makes the
      // next call return the committed row or create exactly one row if no commit occurred.
      const nextResume = { storagePath: path, documentId: null, clientUploadKey };
      documentUploadResumeByFile.set(file, nextResume);
      center?.markStored(null);
      const failure = documentRegistrationFailure({
        error: registered.error,
        status: registered.status,
        statusText: registered.statusText,
        malformedResponse: !registered.error && typeof registeredData?.document_id !== 'string',
      });
      throw new DocumentUploadError(
        failure.code,
        failure.retryable,
        false,
        nextResume,
      );
    }
    documentId = registeredData.document_id;
  }
  documentUploadResumeByFile.set(file, { storagePath: path, documentId, clientUploadKey });
  center?.markRegistered(documentId);
  if (metadata.enqueueProcessing === false) {
    documentUploadResumeByFile.delete(file);
    return { documentId, jobId: null };
  }
  const queued = await beginDocumentIntake(documentId);
  if (queued.error && processingQueueUnavailable(queued.error)) {
    documentUploadResumeByFile.delete(file);
    return { documentId, jobId: null };
  }
  const intake = queued.data as { processing_job_id?: unknown } | null;
  const processingJobId = typeof queued.data === 'string'
    ? queued.data
    : typeof intake?.processing_job_id === 'string' ? intake.processing_job_id : null;
  if (queued.error || !processingJobId) {
    // The source and registry row are durable now. A transport failure may have committed the
    // enqueue before losing its response, so every retry resumes at this exact document and lets
    // the intake RPC's current-job contract settle the ambiguity. Never re-upload or
    // re-register here, including when the promise itself rejected instead of returning an error.
    const nextResume = { storagePath: path, documentId, clientUploadKey };
    documentUploadResumeByFile.set(file, nextResume);
    const failure = documentRegistrationFailure({
      error: queued.error,
      status: queued.status,
      statusText: queued.statusText,
      malformedResponse: !queued.error && !processingJobId,
    });
    throw new DocumentUploadError(
      failure.retryable
        ? 'document_enqueue_transient'
        : 'document_enqueue_failed',
      failure.retryable,
      true,
      nextResume,
    );
  }
  documentUploadResumeByFile.delete(file);
  return { documentId, jobId: processingJobId };
}

async function entityMetadata(entityType: string, entityId: string, documentKind: DocumentKind): Promise<DocumentMetadata> {
  if (entityType === 'invoice') {
    const row = unwrap(await supabase.from('invoices').select('supplier_id, invoice_date')
      .eq('id', entityId).eq('financial_role', 'payable').single()) as {
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
  failure: { code: string; retryable: boolean } | null = null,
) {
  uploadMimeType(file);
  await putPendingPhoto({
    entityType,
    entityId,
    fileName: file.name,
    blob: file,
    documentKind,
    clientUploadId: resume?.clientUploadKey ?? crypto.randomUUID(),
    storagePath: resume?.storagePath ?? null,
    documentId: resume?.documentId ?? null,
    attempts: failure ? 1 : 0,
    state: failure ? (failure.retryable ? 'failed' : 'needs_attention') : 'pending',
    lastError: failure?.code ?? null,
    lastAttemptAt: failure ? Date.now() : null,
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

async function runPendingDocumentPhotoSync() {
  const leaseOwner = crypto.randomUUID();
  const photos = await claimPendingPhotos(leaseOwner, false);
  let uploaded = 0;
  let failed = 0;
  for (const photo of photos) {
    if (photo.id == null || photo.syncVersion == null || !photo.orgId || !photo.actorUserId) { failed += 1; continue; }
    if (photo.state === 'needs_attention') { failed += 1; continue; }
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
      const clientUploadKey = photo.clientUploadId ?? `legacy-${photo.id}`;
      await uploadDocument(photo.orgId, photo.entityType, photo.entityId, file, {
        ...metadata,
        enqueueProcessing: true,
      }, {
        objectKey: photo.clientUploadId ?? clientUploadKey,
        resume: photo.storagePath ? {
          storagePath: photo.storagePath,
          documentId: photo.documentId ?? null,
          clientUploadKey,
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
        state: failure.retryable ? 'failed' : 'needs_attention',
        lastError: failure.code,
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
export function syncPendingDocumentPhotos() {
  pendingDocumentPhotoSync ??= runPendingDocumentPhotoSync().finally(() => {
    pendingDocumentPhotoSync = null;
  });
  return pendingDocumentPhotoSync;
}

/**
 * The picked batch, screened before a single byte is uploaded (owner's ruling: WARN, never block).
 *
 * `weak` names measured captures that need attention; `serverRequired` names HEIC/HEIF the browser
 * cannot decode. `files` remains the batch exactly as picked. Neither path rewrites source bytes.
 */
export interface ScreenedPick {
  files: File[];
  weak: WeakCapture[];
  serverRequired: File[];
}

export async function screenPickedFiles(files: File[]): Promise<ScreenedPick> {
  try {
    const screening = await screenImageQuality(files);
    return { files, weak: screening.weak, serverRequired: screening.serverRequired };
  } catch {
    // A quality check must never be the reason an upload fails.
    return { files, weak: [], serverRequired: [] };
  }
}

/**
 * The picked batch minus the captures the person was asked to take again.
 *
 * **`serverRequired` stays in, deliberately.** A weak capture is a photograph of a document that
 * will not read well — dropping it and reopening the camera is the whole point of the warning.
 * A HEIC is not that: the original is intact and it is only this browser that cannot read the
 * container, which is exactly the case the server derivative lane exists for (#246: no rejection
 * and no silent upload without a check). Omitting it here would make Escape, the backdrop and
 * the X throw away an intact document with no toast and no row in the Upload Center — a
 * rejection, and the one outcome the decision rules out.
 */
export function pickWithoutWeak(pick: ScreenedPick): File[] {
  const weak = new Set(pick.weak.map((item) => item.file));
  return pick.files.filter((file) => !weak.has(file));
}

/**
 * "This one will not read well" — said while the person is still standing in front of the
 * document, which is the only moment the information is worth anything.
 *
 * Three outcomes, and none of them loses or routes a file silently:
 *  - re-take     → the weak captures are dropped and the picker reopens; everything else uploads
 *  - upload anyway → everything uploads, exactly as it was picked
 *  - dismiss (Escape/backdrop/X) → same as re-take without reopening the picker
 *
 * In `serverOnly` mode — nothing weak, only a container this browser cannot read — there is no
 * re-take at all. On an iPhone another capture is another HEIC, so the button would be a loop
 * that never terminates in a readable file. The single action keeps the original and continues.
 */
export function WeakCaptureDialog({ pick, source, onRetake, onUploadAnyway, onDismiss }: {
  pick: ScreenedPick;
  source: CaptureSource;
  onRetake: () => void;
  onUploadAnyway: () => void;
  onDismiss: () => void;
}) {
  const { t } = useT();
  const goodCount = pick.files.length - pick.weak.length - pick.serverRequired.length;
  const serverOnly = pick.weak.length === 0 && pick.serverRequired.length > 0;
  return (
    <Modal
      open={pick.weak.length > 0 || pick.serverRequired.length > 0}
      onClose={onDismiss}
      title={serverOnly ? t('fileUpload.weakCaptureTitle') : t(weakCaptureTitleKey(pick.weak))}
      description={serverOnly
        ? t('fileUpload.formatUnreadable')
        : t(weakCaptureHintKey(pick.weak, source))}
    >
      {pick.files.length > 1 && (
        <ul className="mb-3 divide-y divide-line-soft rounded-lg border border-line-soft text-sm">
          {pick.weak.map((item, index) => (
            <li key={`${item.file.name}-${index}`} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-ink-body"><bdi>{item.file.name}</bdi></span>
              <span className="badge-await shrink-0">{t(WEAK_CAPTURE_LABEL_KEY[item.verdict])}</span>
            </li>
          ))}
        </ul>
      )}
      {pick.serverRequired.length > 0 && (
        <Note tone="info" className="mb-3">
          <span className="min-w-0 flex-1">
            {pick.serverRequired.length === 1
              ? t('fileUpload.text_2')
              : <><span className="num">{pick.serverRequired.length}</span> {t('fileUpload.text_3')}</>}
          </span>
        </Note>
      )}
      {goodCount > 0 && (
        <Note tone="idle" className="mb-3">
          {goodCount === 1
            ? t('fileUpload.text_4')
            : <><span className="num">{goodCount}</span> {t('fileUpload.text_5')}</>}
        </Note>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={serverOnly ? 'btn-primary' : 'btn-secondary'} onClick={onUploadAnyway}>
          {serverOnly ? t('fileUpload.text_6') : t(WEAK_CAPTURE_PROCEED_LABEL_KEY)}
        </button>
        {!serverOnly && (
          <button type="button" className="btn-primary" onClick={onRetake}>
            {t(weakCaptureRetryLabelKey(source))}
          </button>
        )}
      </div>
    </Modal>
  );
}

export function DocumentList({ entityType, entityId, canUpload = true, capture }: {
  entityType: string; entityId: string; canUpload?: boolean; capture?: boolean;
}) {
  const { errorText, t } = useT();
  const { profile, organizationAccess } = useAuth();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /**
   * The Upload Center can retry while this component is mounted, so it still needs the fast
   * per-File lookup. The visible retry queue below also stores the same resume value in its own
   * batch record: starting a new batch cannot overwrite the key of an older failed one.
   */
  const resumeRef = useRef(new Map<File, DocumentUploadResume>());
  const registeredSeenRef = useRef(new Set<string>());
  const retryBatchIdRef = useRef(0);
  const [retryBatches, setRetryBatches] = useState<DocumentRetryBatch[]>([]);
  const [screening, setScreening] = useState(false);
  const [weakPick, setWeakPick] = useState<ScreenedPick | null>(null);
  const [locallyQueued, setLocallyQueued] = useState(0);
  const [pending, setPending] = useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [documentKind, setDocumentKind] = useState<DocumentKind>(() => defaultDocumentKind(entityType));
  const canWrite = organizationAccess?.canWrite ?? true;
  const canDelete = canWrite && (profile?.role === 'owner' || profile?.role === 'office');
  const canReview = profile != null && ['owner', 'office'].includes(profile.role);
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

  function retainFailureBatch(
    source: DocumentRetryBatch | null,
    attempted: readonly File[],
    summary: UploadBatchSummary,
    failedEntries: DocumentRetryEntry[],
  ) {
    const attemptedSet = new Set(attempted);
    const retainedEntries = source
      ? source.entries.filter((entry) => !attemptedSet.has(entry.file))
      : [];
    const entries = [...retainedEntries, ...failedEntries];
    setRetryBatches((current) => {
      if (source) {
        if (summary.failed.length === 0) return current.filter((batch) => batch.id !== source.id);
        return current.map((batch) => batch.id === source.id ? { ...batch, entries, summary } : batch);
      }
      if (summary.failed.length === 0) return current;
      retryBatchIdRef.current += 1;
      return [...current, { id: retryBatchIdRef.current, entries, summary }];
    });
  }

  function discardRetryBatch(batch: DocumentRetryBatch) {
    // Discarding means "stop offering this browser retry". It never deletes an object or a
    // registered document; stored originals retain exactly the server-side state they reached.
    for (const entry of batch.entries) resumeRef.current.delete(entry.file);
    setRetryBatches((current) => current.filter((candidate) => candidate.id !== batch.id));
  }

  async function uploadFiles(
    files: File[],
    previousSummary: UploadBatchSummary | null = null,
    retryBatch: DocumentRetryBatch | null = null,
  ) {
    if (!files.length || !profile) return;
    const explicitResumes = new Map(
      retryBatch?.entries.map((entry) => [entry.file, entry.resume] as const) ?? [],
    );
    setBusy(true);
    busyRef.current = true;
    try {
      const receiptPending = entityType === 'goods_receipt'
        ? await receiptPendingServerAcceptance(entityId)
        : false;
      if (receiptPhotoMustRemainQueued(entityType, navigator.onLine !== false, receiptPending)) {
        for (const file of files) await queuePendingDocumentPhoto(entityType, entityId, documentKind, file);
        setLocallyQueued((count) => count + files.length);
        await offlineQueue.refresh();
        toast(files.length === 1
          ? t('fileUpload.text_7')
          : t('fileUpload.photosQueuedLocally', { count: files.length }));
        return;
      }
      const metadata = await entityMetadata(entityType, entityId, documentKind);
      const result = await enqueueUploadCenterBatch(
        files,
        (file) => uploadDocument(profile.org_id, entityType, entityId, file, {
          ...metadata,
          enqueueProcessing: canMutateDocuments,
        }, { resume: explicitResumes.get(file) ?? resumeRef.current.get(file) ?? null }),
        {
          t,
          errorText,
          source: t(ENTITY_SOURCE_KEYS[entityType] ?? 'fileUpload.text_8'),
          retry: true,
          classifyFailure: (file, error) => {
            const failure = documentUploadFailure(error);
            // Record the resume point the moment the failure happens, so any retry —
            // the Center's or this screen's — redoes only the failed step.
            if (failure.resume) resumeRef.current.set(file, failure.resume);
            else resumeRef.current.delete(file);
            return {
              // The Center renders this as prose, so the code is resolved HERE — inside a
              // component, in the reader's language — rather than travelling as a token.
              message: errorText(new Error(failure.code)),
              retryable: failure.retryable,
              registered: failure.registered,
              storedSafely: failure.resume !== null || failure.registered,
              documentId: failure.resume?.documentId ?? null,
            };
          },
        },
      );
      for (const file of result.succeeded) resumeRef.current.delete(file);
      const failures = result.failed.map(({ item, error }) => ({ item, ...documentUploadFailure(error) }));
      const locallyQueuedForSync = new Set<File>();
      const locallyNeedsAttention = new Set<File>();
      if (entityType === 'goods_receipt') {
        for (const failure of failures) {
          if (!failure.retryable && failure.resume === null) continue;
          await queuePendingDocumentPhoto(
            entityType,
            entityId,
            documentKind,
            failure.item,
            failure.resume,
            { code: failure.code, retryable: failure.retryable },
          );
          if (failure.retryable) locallyQueuedForSync.add(failure.item);
          else locallyNeedsAttention.add(failure.item);
        }
      }
      if (locallyQueuedForSync.size || locallyNeedsAttention.size) {
        setLocallyQueued((count) => count + locallyQueuedForSync.size);
        await offlineQueue.refresh();
      }
      const visibleFailures = failures
        .filter(({ item }) => !locallyQueuedForSync.has(item) && !locallyNeedsAttention.has(item));
      const failedEntries = visibleFailures.map((failure) => ({
        file: failure.item,
        resume: failure.resume ?? explicitResumes.get(failure.item) ?? null,
        retryable: failure.retryable,
        storedSafely: failure.resume !== null || failure.registered,
      }));
      const registered = failures.filter(({ registered: isRegistered }) => isRegistered).length;
      const summary = mergeDocumentUploadSummary(previousSummary, files, {
        succeeded: result.succeeded,
        failed: result.failed.filter(({ item }) => !locallyQueuedForSync.has(item)),
      });
      retainFailureBatch(retryBatch, files, summary, failedEntries);
      if (result.succeeded.length || registered) await refetch();
      if (summary.failed.length) {
        const succeededLabel = canMutateDocuments ? t('fileUpload.text_9') : t('fileUpload.text_10');
        const detail = failures[0] ? ` ${errorText(new Error(failures[0].code))}` : '';
        toast(t('fileUpload.batchPartial', { succeeded: summary.succeeded.length, label: succeededLabel, failed: summary.failed.length }) + detail, 'error');
      } else if (locallyQueuedForSync.size) {
        toast(t('fileUpload.filesQueuedLocally', { count: locallyQueuedForSync.size }));
      } else {
        toast(canMutateDocuments
          ? result.succeeded.length === 1 ? t('fileUpload.uploadedOnePending') : t('fileUpload.uploadedManyPending', { count: result.succeeded.length })
          : result.succeeded.length === 1 ? t('fileUpload.uploadedOne') : t('fileUpload.uploadedMany', { count: result.succeeded.length }));
      }
    } catch (e) {
      const failure = documentUploadFailure(e);
      const summary = mergeDocumentUploadSummary(previousSummary, files, {
        succeeded: [],
        failed: files.map((item) => ({ item, error: e })),
      });
      retainFailureBatch(retryBatch, files, summary, files.map((file) => ({
        file,
        resume: failure.resume ?? explicitResumes.get(file) ?? null,
        retryable: failure.retryable,
        storedSafely: failure.resume !== null || failure.registered,
      })));
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
      busyRef.current = false;
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  /**
   * Screening happens here, between the picker and `uploadFiles`, so the 10MB/MIME gate in
   * `uploadMimeType` and the whole resume contract below it are untouched: by the time anything
   * reaches `uploadDocument` this batch is an ordinary batch of the same File objects.
   */
  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    setScreening(true);
    let pick: ScreenedPick;
    try {
      pick = await screenPickedFiles(Array.from(files));
    } finally {
      setScreening(false);
    }
    if (!pick.weak.length && !pick.serverRequired.length) { void uploadFiles(pick.files); return; }
    setWeakPick(pick);
  }

  function resolveWeakPick(files: File[], reopenPicker: boolean) {
    setWeakPick(null);
    // Cleared before the picker reopens: an unchanged value fires no `change` event, so a user
    // re-taking the same file name would otherwise get silence.
    if (inputRef.current) inputRef.current.value = '';
    if (files.length) void uploadFiles(files);
    if (reopenPicker) inputRef.current?.click();
  }

  async function open(doc: DocumentRow) {
    const result = await openReservedPopup(async () => {
      return signedDocumentSourceUrl(doc.storage_path, 300, doc.mime_type);
    });
    if (result === 'blocked') toast(t('fileUpload.toast'), 'error');
    if (result === 'error') toast(t('fileUpload.toast_2'), 'error');
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
      toast(t('fileUpload.toast_3'));
      setPending(null);
      await refetch();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div>
          <span className="text-sm font-medium text-ink-soft flex items-center gap-1.5"><Paperclip size={ICON.sm} /> {t('fileUpload.text_11')}</span>
          <p className="mt-1 text-xs text-ink-muted">{t('fileUpload.uploadLimitHint')}</p>
        </div>
        {/* The "סוג" select that stood here — delivery note / invoice / other, chosen before the
            camera opened — is gone. This is the receiving screen: the person holding the phone is
            standing at the truck with the paper in the other hand, and the one question they
            should not be asked is which of three accounting categories it belongs to. The subtype
            is read off the document and confirmed on the review screen. `defaultDocumentKind`
            still seeds a value from the entity, and 0084's trigger replaces it with what the
            document says. */}
        {canUploadNow && <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary btn-sm" disabled={busy || screening} onClick={() => inputRef.current?.click()}>
            {busy || screening ? <Loader2 size={ICON.sm} className="animate-spin" /> : capture ? <Camera size={ICON.sm} /> : <Paperclip size={ICON.sm} />}
              {capture ? t('fileUpload.text_12') : t('fileUpload.text_13')}
          </button>
        </div>}
        <input ref={inputRef} type="file" hidden multiple accept={DOCUMENT_UPLOAD_ACCEPT} data-document-upload-input
          {...(capture ? { capture: 'environment' as const } : {})}
          onChange={(e) => void onPick(e.target.files)} />
      </div>
      {weakPick && (
        <WeakCaptureDialog
          pick={weakPick}
          source={capture ? 'camera' : 'picker'}
          onRetake={() => resolveWeakPick(pickWithoutWeak(weakPick), true)}
          onUploadAnyway={() => resolveWeakPick(weakPick.files, false)}
          onDismiss={() => resolveWeakPick(pickWithoutWeak(weakPick), false)}
        />
      )}
      <UploadCenter />
      {locallyQueued > 0 && (
        <Note tone="await" className="mb-2">
          <span className="min-w-0 flex-1">
            <span className="num">{locallyQueued}</span> {t('fileUpload.filesStoredOnDevice')}
          </span>
        </Note>
      )}
      {retryBatches.map((batch) => {
        const retryableEntries = batch.entries.filter((entry) => entry.retryable);
        return (
          <Note key={batch.id} tone="alert" className="mb-2">
            <div role="status" className="min-w-0 flex-1">
              <div>
                <span className="num">{batch.summary.succeeded.length}</span> {canMutateDocuments ? t('fileUpload.text_14') : t('fileUpload.text_15')} ·{' '}
                <span className="num">{batch.summary.failed.length}</span> {t('fileUpload.notCompleted')}
              </div>
              <div className="mt-1 text-xs">{t('fileUpload.failedList', { files: batch.summary.failed.join(', ') })}</div>
              {batch.entries.some((entry) => entry.storedSafely) && (
                <div className="mt-1 text-xs">{t('fileUpload.retrySourceRetained')}</div>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {retryableEntries.length > 0 && (
                  <button type="button" className="btn-ghost btn-sm" disabled={busy}
                    onClick={() => void uploadFiles(retryableEntries.map((entry) => entry.file), batch.summary, batch)}>
                    {t('fileUpload.text_16')}
                  </button>
                )}
                <button type="button" className="btn-ghost btn-sm" disabled={busy}
                  onClick={() => discardRetryBatch(batch)}>
                  {t('fileUpload.discardRetry')}
                </button>
              </div>
            </div>
          </Note>
        );
      })}
      {error && docs && <ErrorNote message={error} />}
      {processing.error && docs && <ErrorNote message={processing.error} />}
      {fetching && docs && <div className="mb-2 text-xs text-ink-muted" role="status">{t('fileUpload.text_17')}</div>}
      {error && !docs ? (
        <ErrorNote message={error} />
      ) : loading ? (
        // Not cosmetic: `docs` is null while fetching, and the empty branch below claims
        // "no documents". On an invoice that reads as "no scan attached" when there is one.
        <div className="border border-line-soft rounded-lg divide-y divide-line-soft" role="status" aria-busy="true">
          <span className="sr-only">{t('fileUpload.text_18')}</span>
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
                <FileText size={ICON.sm} className="shrink-0 text-ink-faint" />
                <button className="link min-w-32 flex-1 truncate text-start" onClick={() => void open(d)}><bdi>{d.file_name}</bdi></button>
                <span className="hidden text-xs text-ink-muted sm:inline">{t(documentKindKey(d.document_kind))}</span>
                {/* G1, finding 20 — same badge, same four human states as the documents folder.
                    The raw stage stays on `data-document-processing-status`. */}
                {canReview && (
                  <span data-document-processing-status={stage ?? 'loading'}>
                    {stage
                      ? <DocumentStatusBadge status={documentUiStatus({
                        status: stage, job: processing.snapshots[d.id]?.job, document: d,
                      })} />
                      : <><Skeleton className="h-6 w-24" /><span className="sr-only">{t('fileUpload.text_19')}</span></>}
                  </span>
                )}
                <span className="text-xs text-ink-muted">{fmtDateTime(d.created_at)}</span>
                {/* Converged on AttachmentsPanel's shape, which is the one the design system
                    describes: navigation stays a real `<Link>` (an ActionMenuItem is
                    `onSelect: () => void`, so moving it into the menu would trade an `href` —
                    middle-click, open-in-new-tab, `data-document-review-link` — for a
                    programmatic navigate), and the loose row BUTTON goes into the one menu.
                    That button was the real defect: `btn-ghost p-1.5! min-w-11 min-h-11` for a
                    size the base had no name for, and `hover:text-alert-fg` — a destructive
                    action that only admitted what it was once the pointer was already on it
                    (DESIGN.md:586). In the menu it is `tone="danger"`: alert-coloured, always. */}
                {canReview && (
                  <Link to={`/documents/${d.id}/review`} className="btn-ghost btn-sm" data-document-review-link>
                    {t('fileUpload.text_20')}
                  </Link>
                )}
                <ActionMenu label={t('fileUpload.actionsFor', { file: d.file_name })} items={[
                  {
                    key: 'delete',
                    label: t('fileUpload.text_21'),
                    icon: Trash2,
                    tone: 'danger',
                    hidden: !canDelete,
                    onSelect: () => setPending(d),
                  },
                ]} />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="text-sm text-ink-muted border border-dashed border-line rounded-lg px-3 py-4 text-center">{t('fileUpload.text_22')}</div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => { if (pending) void remove(pending); }}
        title={t('fileUpload.title')}
        message={t('fileUpload.removeConfirm', { file: bidiIsolate(pending?.file_name ?? '') })}
        confirmLabel={t('fileUpload.confirmLabel')}
        danger
        busy={deleting}
      />
    </div>
  );
}

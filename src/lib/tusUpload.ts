// Resumable uploads to the private `documents` bucket (PLAN-07, wave 6b).
//
// One wrapper for both document flows — entity documents (FileUpload) and reserved
// price-list documents (PriceListUpload). tus against Supabase Storage's resumable
// endpoint gives the Upload Center its resume criterion (ENTERPRISE-UI-PLAN.md:170):
// a network cut mid-upload continues from the last accepted offset instead of
// starting over. HEAD offset-discovery is permission-skipped on the server, so it
// always succeeds — real failures surface around the creation POST and the PATCH,
// which is where this wrapper watches.

import * as tus from 'tus-js-client';
import { supabase } from './supabase';
import { toHebrewError } from './errors';

export const DOCUMENTS_BUCKET = 'documents';

/**
 * 6MB always (PLAN-07 §1.6). Cloud storage rides S3 multipart, which requires every
 * non-final part to be ≥5MB; the local FileStore backend has no minimum. One size for
 * both keeps local proof runs honest about cloud behaviour.
 */
export const TUS_CHUNK_SIZE = 6 * 1024 * 1024;

/** Renew the reservation once it has less than this long to live (PLAN-07 §1.5). */
export const RESERVATION_RENEWAL_WINDOW_MS = 5 * 60 * 1000;

/**
 * The exact TS equivalent of the server's MIME normalization,
 * `lower(split_part(trim(m), ';', 1))` — all three storage MIME gates compare against
 * this form, so the tus `contentType` metadata must be normalized the same way or an
 * upload with a `; charset=` suffix fails closed at the policy.
 */
export function normalizeUploadMime(mime: string): string {
  return mime.trim().split(';')[0].toLowerCase();
}

/** Thrown when the caller aborts; never shown to the user as a failure. */
export class TusUploadCancelledError extends Error {
  constructor() {
    super('upload cancelled');
  }
}

/**
 * A tus failure with a user-ready Hebrew message. `retryable` follows the transport:
 * no response / 5xx can be retried; a 4xx verdict (policy, conflict, size) cannot.
 */
export class TusUploadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

/**
 * Price-document flow only: the reservation row that authorizes the storage path
 * expires, and a slow upload must extend it. Entity documents have no reservation
 * and pass no renewal.
 */
export interface TusReservationRenewal {
  documentId: string;
  /** ISO expiry from the reserve RPC; drives the proactive renewal timing. */
  expiresAt: string;
}

export interface TusDocumentUploadOptions {
  /** Reserved storage_path (price flow) or entity path — must start with {org_id}/. */
  objectName: string;
  /** Raw MIME; normalized to the server's form before it enters the metadata. */
  contentType: string;
  onProgress?: (percent: number) => void;
  renewal?: TusReservationRenewal;
}

export interface TusUploadHandle {
  /** Resolves on success; rejects with TusUploadError or TusUploadCancelledError. */
  done: Promise<void>;
  abort: () => Promise<void>;
}

/**
 * PLAN-07 fallback contract (handoff/6b-upload-contract.md not yet published):
 * `renew_supplier_price_document_upload(p_document_id)` extends `expires_at` only —
 * no re-bind, actor only, `reserved` only, hard 45-minute cap from `created_at`.
 * The return shape is read defensively: a bare timestamp or an object carrying
 * `expires_at` updates the local clock; anything else leaves it unchanged.
 */
async function renewReservation(documentId: string): Promise<string | null> {
  const renewed = await supabase.rpc('renew_supplier_price_document_upload', {
    p_document_id: documentId,
  });
  if (renewed.error) throw new Error(renewed.error.message);
  const data: unknown = renewed.data;
  if (typeof data === 'string' && Number.isFinite(Date.parse(data))) return data;
  if (data && typeof data === 'object') {
    const expires = (data as Record<string, unknown>).expires_at;
    if (typeof expires === 'string' && Number.isFinite(Date.parse(expires))) return expires;
  }
  return null;
}

function responseStatus(error: Error): number | null {
  const detailed = error as Partial<tus.DetailedError>;
  return detailed.originalResponse?.getStatus() ?? null;
}

function requestMethod(error: Error): string | null {
  const detailed = error as Partial<tus.DetailedError>;
  return detailed.originalRequest?.getMethod() ?? null;
}

function translateTusError(error: Error): TusUploadError {
  const status = responseStatus(error);
  if (status === 403) {
    // The MIME gates fail closed (e.g. octet-stream), the bucket policy rejects a foreign
    // path, and an expired reservation dies at the same status — one calm sentence for all.
    return new TusUploadError(
      'השרת דחה את ההעלאה: סוג הקובץ אינו מורשה, הנתיב אינו זמין או שהקצאת ההעלאה פגה. יש לנסות שוב.',
      false,
    );
  }
  if (status === 409) {
    return new TusUploadError('קובץ כבר קיים בנתיב הזה באחסון. יש לרענן את המסך ולנסות שוב.', false);
  }
  if (status === 413) {
    return new TusUploadError('הקובץ גדול מדי להעלאה.', false);
  }
  const detailed = error as Partial<tus.DetailedError>;
  const cause = detailed.causingError ?? error;
  // toHebrewError logs the original for the developer and maps network/5xx wording.
  return new TusUploadError(toHebrewError(cause), status === null || status >= 500);
}

/**
 * Uploads one file to the `documents` bucket over tus.
 *
 * Renewal behaviour (price-document flow only):
 * - `onChunkComplete`: when the reservation expires within 5 minutes, the renew RPC is
 *   called proactively; a failure here is advisory only — the 403 backstop below still runs.
 * - A 403 on the data PATCH triggers exactly ONE renew-then-resume; if the renewed attempt
 *   fails again the translated Hebrew error surfaces.
 */
export function tusUploadToDocuments(file: File | Blob, options: TusDocumentUploadOptions): TusUploadHandle {
  let upload: tus.Upload | null = null;
  let cancelled = false;
  let settleCancelled: (() => void) | null = null;

  const done = new Promise<void>((resolve, reject) => {
    settleCancelled = () => reject(new TusUploadCancelledError());
    void (async () => {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (sessionError || !accessToken) {
        reject(new TusUploadError(toHebrewError(sessionError?.message ?? 'JWT expired'), false));
        return;
      }
      if (cancelled) {
        reject(new TusUploadCancelledError());
        return;
      }

      let expiresAtMs = options.renewal ? Date.parse(options.renewal.expiresAt) : null;
      let renewing: Promise<void> | null = null;
      let renewedAfterForbidden = false;

      upload = new tus.Upload(file, {
        endpoint: `${import.meta.env.VITE_SUPABASE_URL as string}/storage/v1/upload/resumable`,
        headers: { authorization: `Bearer ${accessToken}`, 'x-upsert': 'false' },
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        chunkSize: TUS_CHUNK_SIZE,
        metadata: {
          bucketName: DOCUMENTS_BUCKET,
          objectName: options.objectName,
          contentType: normalizeUploadMime(options.contentType),
          cacheControl: '3600',
        },
        onProgress: (bytesSent, bytesTotal) => {
          if (bytesTotal > 0) {
            options.onProgress?.(Math.min(100, Math.round((bytesSent / bytesTotal) * 100)));
          }
        },
        onChunkComplete: () => {
          const renewal = options.renewal;
          if (!renewal || expiresAtMs === null || renewing) return;
          if (expiresAtMs - Date.now() > RESERVATION_RENEWAL_WINDOW_MS) return;
          renewing = renewReservation(renewal.documentId)
            .then((nextExpiresAt) => {
              if (nextExpiresAt) expiresAtMs = Date.parse(nextExpiresAt);
            })
            .catch((renewError: unknown) => {
              // Advisory only: if the reservation really died, the PATCH 403 path below
              // gets one more renew attempt before the failure surfaces.
              console.error(
                '[supplyflow] proactive reservation renewal failed',
                renewError instanceof Error ? renewError.message : String(renewError),
              );
            })
            .finally(() => {
              renewing = null;
            });
        },
        onSuccess: () => resolve(),
        onError: (error) => {
          if (cancelled) {
            reject(new TusUploadCancelledError());
            return;
          }
          if (
            responseStatus(error) === 403 &&
            requestMethod(error) === 'PATCH' &&
            options.renewal &&
            !renewedAfterForbidden
          ) {
            // Exactly one renew-then-resume before the failure surfaces (PLAN-07 §1.5).
            renewedAfterForbidden = true;
            renewReservation(options.renewal.documentId)
              .then((nextExpiresAt) => {
                if (nextExpiresAt) expiresAtMs = Date.parse(nextExpiresAt);
                if (!cancelled) upload?.start();
              })
              .catch(() => reject(translateTusError(error)));
            return;
          }
          reject(translateTusError(error));
        },
      });
      upload.start();
    })();
  });
  // A cancelled upload is not an unhandled rejection even when nobody awaits it anymore.
  done.catch(() => {});

  return {
    done,
    abort: async () => {
      cancelled = true;
      try {
        // shouldTerminate: the partial upload is deleted server-side, freeing the path.
        await upload?.abort(true);
      } catch {
        // Termination is best-effort; the server's expiry sweep is the backstop.
      }
      settleCancelled?.();
    },
  };
}

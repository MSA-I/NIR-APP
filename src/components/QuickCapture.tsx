import { useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useToast } from './ui';
import { toHebrewError } from '../lib/errors';
import {
  DOCUMENT_UPLOAD_ACCEPT,
  WeakCaptureDialog,
  documentUploadFailure,
  mergeDocumentUploadSummary,
  pickWithoutWeak,
  screenPickedFiles,
  uploadDocument,
  type ScreenedPick,
} from './FileUpload';
import { runUploadBatch, type UploadBatchSummary } from '../lib/uploadBatch';

/**
 * Capture-first upload into the documents inbox (migration 0014): openCapture() opens the
 * camera/file picker, every picked file is pushed to {org_id}/inbox/... with no entity, and
 * the user re-files it from /inbox when the invoice/receipt exists. Deliberately
 * dependency-light — Dashboard mounts it in the first-screen command strip and Layout mounts
 * the same capture contract as the single global camera FAB elsewhere. One successful upload
 * opens review unless the current route can contain unsaved form work.
 *
 * `element` must be rendered somewhere in the caller's tree (it is the hidden file input).
 */

/** Fired on window after every successful upload batch. The FAB's capture has no line to the
 *  inbox surfaces mounted elsewhere in the tree (nav count pill, the /inbox list) — this event
 *  is how they learn the inbox changed and refetch (adversarial review round). */
export const INBOX_CHANGED_EVENT = 'sf:inbox-changed';

const UNSAVED_FORM_ROUTES = [
  /^\/orders\/new$/,
  /^\/invoices\/new$/,
  /^\/receiving\/[^/]+$/,
];

export function quickCaptureReviewTarget(
  pathname: string,
  pickedCount: number,
  succeededCount: number,
  documentId: string | null,
): string | null {
  if (pickedCount !== 1 || succeededCount !== 1 || !documentId
      || UNSAVED_FORM_ROUTES.some((route) => route.test(pathname))) return null;
  return `/documents/${encodeURIComponent(documentId)}/review`;
}

export function useQuickCapture(onUploaded?: () => void | Promise<unknown>): {
  openCapture: () => void; element: ReactNode; busy: boolean; retryCount: number;
} {
  const { profile } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [screening, setScreening] = useState(false);
  const [weakPick, setWeakPick] = useState<ScreenedPick | null>(null);
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [uploadSummary, setUploadSummary] = useState<UploadBatchSummary | null>(null);

  async function uploadFiles(files: File[], previousSummary: UploadBatchSummary | null = null) {
    if (!files.length || !profile) return;
    setBusy(true);
    try {
      const uploadedDocumentIds: string[] = [];
      const result = await runUploadBatch(files, async (file) => {
        const uploaded = await uploadDocument(profile.org_id, 'inbox', null, file);
        uploadedDocumentIds.push(uploaded.documentId);
      });
      const failures = result.failed.map(({ item, error }) => ({ item, ...documentUploadFailure(error) }));
      const failed = failures.filter(({ retryable }) => retryable).map(({ item }) => item);
      const registered = failures.filter(({ registered: isRegistered }) => isRegistered).length;
      setRetryFiles(failed);
      const summary = mergeDocumentUploadSummary(previousSummary, files, result);
      setUploadSummary(summary.failed.length ? summary : null);
      /**
       * G1, finding 16. "צילמתי את החשבונית וזהו" — and "וזהו" was wrong, silently.
       *
       * The camera drops the file into the inbox with no entity (`uploadDocument(..., 'inbox',
       * null, ...)`). A single safe-route capture opens review below; multi-file batches and form
       * routes remain in place so navigation cannot discard work or hide partial failures.
       */
      if (summary.failed.length) {
        const detail = failures[0] ? ` ${failures[0].message}` : '';
        const retryHint = failed.length ? ' לחיצה נוספת תנסה רק את הכשלים הזמניים.' : '';
        toast(`${summary.succeeded.length} הועלו וממתינים לבדיקה בתיקיית המסמכים, ${summary.failed.length} לא הושלמו.${detail}${retryHint}`, 'error');
      } else {
        toast(summary.succeeded.length > 1
          ? `${summary.succeeded.length} קבצים הועלו וממתינים לבדיקה בתיקיית המסמכים`
          : 'המסמך הועלה וממתין לבדיקה בתיקיית המסמכים');
      }
      if (result.succeeded.length + registered > 0) {
        window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
        await onUploaded?.();
      }
      const reviewTarget = quickCaptureReviewTarget(
        location.pathname,
        files.length,
        result.succeeded.length,
        uploadedDocumentIds[0] ?? null,
      );
      if (reviewTarget) navigate(reviewTarget);
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
      setBusy(false);
    }
  }

  /**
   * The capture is measured here, before `uploadFiles` — the whole value of the warning is that
   * it arrives while the person is still holding the phone in front of the document, and before
   * the file costs a paid OCR call. Screening cannot reject or rewrite. Unsupported HEIC/HEIF is
   * named before the same File enters the bounded server scan path; ordinary uncertainty stays no verdict.
   */
  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    setUploadSummary(null);
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

  function resolveWeakPick(files: File[], reopenCamera: boolean) {
    setWeakPick(null);
    // Cleared before the camera reopens: an unchanged input value fires no `change` event.
    if (inputRef.current) inputRef.current.value = '';
    if (files.length) void uploadFiles(files);
    if (reopenCamera) inputRef.current?.click();
  }

  const element = (
    <>
      <input ref={inputRef} type="file" multiple accept={DOCUMENT_UPLOAD_ACCEPT}
        capture="environment" className="hidden" data-document-upload-input
        onChange={(e) => void onPick(e.target.files)} />
      {weakPick && (
        <WeakCaptureDialog
          pick={weakPick}
          source="camera"
          onRetake={() => resolveWeakPick(pickWithoutWeak(weakPick), true)}
          onUploadAnyway={() => resolveWeakPick(weakPick.files, false)}
          onDismiss={() => resolveWeakPick(pickWithoutWeak(weakPick), false)}
        />
      )}
    </>
  );

  return {
    openCapture: () => { if (retryFiles.length) void uploadFiles(retryFiles, uploadSummary); else inputRef.current?.click(); },
    element,
    busy: busy || screening,
    retryCount: retryFiles.length,
  };
}

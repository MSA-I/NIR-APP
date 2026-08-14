import { useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useToast } from './ui';
import { toHebrewError } from '../lib/errors';
import {
  DOCUMENT_UPLOAD_ACCEPT,
  documentUploadFailure,
  mergeDocumentUploadSummary,
  uploadDocument,
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

  function onPick(files: FileList | null) {
    if (files?.length) {
      setUploadSummary(null);
      void uploadFiles(Array.from(files));
    }
  }

  const element = (
    <input ref={inputRef} type="file" multiple accept={DOCUMENT_UPLOAD_ACCEPT}
      capture="environment" className="hidden" data-document-upload-input
      onChange={(e) => void onPick(e.target.files)} />
  );

  return {
    openCapture: () => { if (retryFiles.length) void uploadFiles(retryFiles, uploadSummary); else inputRef.current?.click(); },
    element,
    busy,
    retryCount: retryFiles.length,
  };
}

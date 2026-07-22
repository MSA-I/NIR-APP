import { useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useToast } from './ui';
import { toHebrewError } from '../lib/errors';
import { uploadDocument } from './FileUpload';
import { mergeUploadBatchSummary, runUploadBatch, type UploadBatchSummary } from '../lib/uploadBatch';

/**
 * Capture-first upload into the documents inbox (migration 0014): openCapture() opens the
 * camera/file picker, every picked file is pushed to {org_id}/inbox/... with no entity, and
 * the user re-files it from /inbox when the invoice/receipt exists. Deliberately
 * dependency-light — Dashboard mounts it in the first-screen command strip and Layout mounts
 * the same capture contract as the single global camera FAB elsewhere; busy feedback is the
 * button spinner + a toast, no extra UI.
 *
 * `element` must be rendered somewhere in the caller's tree (it is the hidden file input).
 */

/** Fired on window after every successful upload batch. The FAB's capture has no line to the
 *  inbox surfaces mounted elsewhere in the tree (nav count pill, the /inbox list) — this event
 *  is how they learn the inbox changed and refetch (adversarial review round). */
export const INBOX_CHANGED_EVENT = 'sf:inbox-changed';
export function useQuickCapture(onUploaded?: () => void | Promise<unknown>): {
  openCapture: () => void; element: ReactNode; busy: boolean; retryCount: number;
} {
  const { profile } = useAuth();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [uploadSummary, setUploadSummary] = useState<UploadBatchSummary | null>(null);

  async function uploadFiles(files: File[], previousSummary: UploadBatchSummary | null = null) {
    if (!files.length || !profile) return;
    setBusy(true);
    try {
      const result = await runUploadBatch(files, (file) => uploadDocument(profile.org_id, 'inbox', null, file));
      const failed = result.failed.map(({ item }) => item);
      setRetryFiles(failed);
      const summary = mergeUploadBatchSummary(previousSummary, result, (file) => file.name);
      setUploadSummary(failed.length ? summary : null);
      if (failed.length) {
        const cause = result.failed[0]?.error ? ` — ${toHebrewError(result.failed[0].error)}` : '';
        toast(`${summary.succeeded.length} נשמרו, ${failed.length} נכשלו (${failed.map((file) => file.name).join(', ')}). לחיצה נוספת תנסה רק אותם${cause}`, 'error');
      } else {
        toast(summary.succeeded.length > 1 ? `${summary.succeeded.length} מסמכים נשמרו במסמכים לא משויכים` : 'המסמך נשמר במסמכים לא משויכים');
      }
      if (result.succeeded.length > 0) {
        window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
        await onUploaded?.();
      }
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
    <input ref={inputRef} type="file" multiple accept="image/*,application/pdf"
      capture="environment" className="hidden"
      onChange={(e) => void onPick(e.target.files)} />
  );

  return {
    openCapture: () => { if (retryFiles.length) void uploadFiles(retryFiles, uploadSummary); else inputRef.current?.click(); },
    element,
    busy,
    retryCount: retryFiles.length,
  };
}

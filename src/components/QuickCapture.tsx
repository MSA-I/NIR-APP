import { useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useToast } from './ui';
import { toHebrewError } from '../lib/errors';
import { uploadDocument } from './FileUpload';

/**
 * Capture-first upload into the documents inbox (migration 0014): openCapture() opens the
 * camera/file picker, every picked file is pushed to {org_id}/inbox/... with no entity, and
 * the user re-files it from /inbox when the invoice/receipt exists. Deliberately
 * dependency-light — a later phase mounts this in the global Layout so capture is one tap
 * from anywhere; busy feedback is the button spinner + a toast, no extra UI.
 *
 * `element` must be rendered somewhere in the caller's tree (it is the hidden file input).
 */

/** Fired on window after every successful upload batch. The FAB's capture has no line to the
 *  inbox surfaces mounted elsewhere in the tree (nav count pill, the /inbox list) — this event
 *  is how they learn the inbox changed and refetch (adversarial review round). */
export const INBOX_CHANGED_EVENT = 'sf:inbox-changed';
export function useQuickCapture(onUploaded?: () => void | Promise<unknown>): {
  openCapture: () => void; element: ReactNode; busy: boolean;
} {
  const { profile } = useAuth();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function onPick(files: FileList | null) {
    if (!files?.length || !profile) return;
    setBusy(true);
    let uploaded = 0;
    try {
      for (const f of Array.from(files)) {
        await uploadDocument(profile.org_id, 'inbox', null, f);
        uploaded++;
      }
      toast(uploaded > 1 ? `${uploaded} מסמכים נשמרו במסמכים לא משויכים` : 'המסמך נשמר במסמכים לא משויכים');
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
      setBusy(false);
      // Even a partial batch changed the inbox — notify every inbox surface (event) AND
      // the direct caller (prop), which may want its own follow-up.
      if (uploaded > 0) {
        window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
        await onUploaded?.();
      }
    }
  }

  const element = (
    <input ref={inputRef} type="file" multiple accept="image/*,application/pdf"
      capture="environment" className="hidden"
      onChange={(e) => void onPick(e.target.files)} />
  );

  return { openCapture: () => inputRef.current?.click(), element, busy };
}

import type { DocumentStatusState } from './documentStatus';

export type DocumentStateAction = 'wait' | 'retry' | 'review' | 'file' | 'none';

/** One answer for every canonical list state. `none` is explicit: no invented affordance. */
export const DOCUMENT_STATE_ACTIONS: Readonly<Record<DocumentStatusState, DocumentStateAction>> = {
  stuck: 'none',
  failed: 'retry',
  processing: 'wait',
  review: 'review',
  supplier_unresolved: 'review',
  // MERGE, 05.09.2026. `awaiting_scan` arrived with this sweep after this map was written.
  // 'review' and not 'wait': nothing is running, so nobody is coming -- a person has to look.
  awaiting_scan: 'review',
  unassigned: 'file',
  assigned: 'none',
  completed: 'none',
  historical: 'none',
  unavailable: 'none',
};

export function documentStateAction(state: DocumentStatusState): DocumentStateAction {
  return DOCUMENT_STATE_ACTIONS[state];
}

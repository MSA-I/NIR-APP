import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

const rpc = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn(async () => true));
/** Mutable so a test can move the pipeline forward between renders, which is the whole subject of
 *  the second describe: a message that belongs to a state has to disappear when that state does. */
const processing = vi.hoisted(() => ({
  snapshots: {} as Record<string, unknown>,
}));
const failedSnapshots = {
  'document-1': {
    documentId: 'document-1', stage: 'failed',
    document: { id: 'document-1', file_name: 'failed.pdf', storage_path: 'org/failed.pdf' },
    job: { id: 'job-1', status: 'failed', last_error_message: 'provider failed' },
    interpretation: null,
  },
};
vi.mock('../lib/supabase', () => ({
  supabase: { rpc, functions: { invoke } },
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'owner-1', role: 'owner' },
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));
vi.mock('../lib/useDocumentProcessing', () => ({
  DOCUMENT_PROCESSING_CHANGED_EVENT: 'supplyflow:document-processing-changed',
  useDocumentProcessing: () => ({
    loading: false, fetching: false, error: null, refetch,
    snapshots: processing.snapshots,
  }),
}));
vi.mock('../lib/useDocumentScanning', () => ({
  useDocumentScanning: () => ({ loading: false, error: null, states: {}, refetch: vi.fn() }),
}));
vi.mock('../components/document-review/DocumentReviewWorkspace', () => ({
  DocumentReviewWorkspace: ({ onReprocess }: { onReprocess?: () => void }) => (
    <button type="button" onClick={onReprocess}>עיבוד מחדש</button>
  ),
}));

import DocumentReview from './DocumentReview';

const renderReview = () => render(
  <MemoryRouter initialEntries={['/documents/document-1/review']}>
    <Routes><Route path="/documents/:documentId/review" element={<DocumentReview />} /></Routes>
  </MemoryRouter>,
);

describe('מסך בדיקת מסמך שנכשל', () => {
  beforeEach(() => {
    rpc.mockReset();
    invoke.mockReset();
    refetch.mockClear();
    processing.snapshots = failedSnapshots;
  });

  it('קורא ל-reprocess_document עם הסיבה הקבועה ומרענן את המסמך', async () => {
    rpc.mockResolvedValueOnce({ data: { job_id: 'job-2' }, error: null });
    renderReview();

    await userEvent.click(screen.getByRole('button', { name: 'עיבוד מחדש' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('reprocess_document', {
      p_document_id: 'document-1',
      p_reason: 'עיבוד מחדש ממסך בדיקת המסמך לאחר כשל',
    }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});

/**
 * The alert and the state it describes, tied together.
 *
 * `interpretError` was a bare string cleared only when someone pressed a button. Its own comment
 * conceded the consequence: the retry beside it is gated on the job still sitting at 'extracted',
 * so the moment a refetch moved the job on, the button vanished and the sentence stayed — an alert
 * about a document that had already been read, with nothing left on screen to act on.
 */
const waitingSnapshots = (jobStatus: string, interpretation: unknown = null) => ({
  'document-1': {
    documentId: 'document-1', stage: jobStatus === 'extracted' ? 'extracted' : 'review',
    document: { id: 'document-1', file_name: 'invoice.pdf', storage_path: 'org/invoice.pdf' },
    job: { id: 'job-9', status: jobStatus, last_error_message: null },
    interpretation,
  },
});

describe('התראת פענוח שנכשל', () => {
  beforeEach(() => {
    rpc.mockReset();
    invoke.mockReset();
    refetch.mockClear();
    processing.snapshots = waitingSnapshots('extracted');
    // interpret-document maps its own failures to Hebrew, so the body IS the message.
    invoke.mockResolvedValue({
      error: { context: { json: async () => ({ error: { message: 'שירות הפענוח לא זמין כרגע.' } }) } },
    });
  });

  it('נעלמת כשהשרת מדווח שהמסמך כבר עבר את השלב שנכשל', async () => {
    const { rerender } = renderReview();

    // The auto-trigger fires once for a job waiting at 'extracted', fails, and reports why.
    expect(await screen.findByText('שירות הפענוח לא זמין כרגע.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ניסיון נוסף' })).toBeInTheDocument();

    // A refetch that moves the job on — a retry landed elsewhere, or the inbox interpreted it.
    processing.snapshots = waitingSnapshots('review', { id: 'interpretation-1' });
    rerender(
      <MemoryRouter initialEntries={['/documents/document-1/review']}>
        <Routes><Route path="/documents/:documentId/review" element={<DocumentReview />} /></Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.queryByText('שירות הפענוח לא זמין כרגע.')).toBeNull());
    expect(screen.queryByRole('button', { name: 'ניסיון נוסף' })).toBeNull();
  });

  it('נשארת כל עוד המסמך עדיין ממתין לפענוח', async () => {
    renderReview();
    expect(await screen.findByText('שירות הפענוח לא זמין כרגע.')).toBeInTheDocument();
    // Nothing changed on the server, so nothing is withdrawn: the alert and its retry stay.
    expect(screen.getByRole('button', { name: 'ניסיון נוסף' })).toBeInTheDocument();
  });
});

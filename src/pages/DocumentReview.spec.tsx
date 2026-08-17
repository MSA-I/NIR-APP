import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

const rpc = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../lib/supabase', () => ({
  supabase: { rpc, functions: { invoke: vi.fn() } },
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
    snapshots: {
      'document-1': {
        documentId: 'document-1', stage: 'failed',
        document: { id: 'document-1', file_name: 'failed.pdf', storage_path: 'org/failed.pdf' },
        job: { id: 'job-1', status: 'failed', last_error_message: 'provider failed' },
        interpretation: null,
      },
    },
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

describe('מסך בדיקת מסמך שנכשל', () => {
  beforeEach(() => {
    rpc.mockReset();
    refetch.mockClear();
  });

  it('קורא ל-reprocess_document עם הסיבה הקבועה ומרענן את המסמך', async () => {
    rpc.mockResolvedValueOnce({ data: { job_id: 'job-2' }, error: null });
    render(
      <MemoryRouter initialEntries={['/documents/document-1/review']}>
        <Routes><Route path="/documents/:documentId/review" element={<DocumentReview />} /></Routes>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'עיבוד מחדש' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('reprocess_document', {
      p_document_id: 'document-1',
      p_reason: 'עיבוד מחדש ממסך בדיקת המסמך לאחר כשל',
    }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});

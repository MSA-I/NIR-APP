import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

const rpc = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn(async () => true));
const scanningRefetch = vi.hoisted(() => vi.fn(async () => true));
const createSignedUrl = vi.hoisted(() => vi.fn());
const uploadDocument = vi.hoisted(() => vi.fn());
/** Mutable so a test can move the pipeline forward between renders, which is the whole subject of
 *  the second describe: a message that belongs to a state has to disappear when that state does. */
const processing = vi.hoisted(() => ({
  snapshots: {} as Record<string, unknown>,
}));
const scanning = vi.hoisted(() => ({
  states: {} as Record<string, unknown>,
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
  supabase: {
    rpc,
    functions: { invoke },
    storage: { from: () => ({ createSignedUrl }) },
  },
}));
vi.mock('../components/FileUpload', () => ({
  DOCUMENT_UPLOAD_ACCEPT: 'application/pdf,image/jpeg',
  uploadDocument,
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'owner-1', org_id: 'org-1', role: 'owner' },
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
  useDocumentScanning: () => ({
    loading: false, error: null, states: scanning.states, refetch: scanningRefetch,
  }),
}));
vi.mock('../components/document-review/DocumentReviewWorkspace', () => ({
  DocumentReviewWorkspace: ({ onReprocess }: { onReprocess?: () => void }) => (
    <button type="button" onClick={onReprocess}>עיבוד מחדש</button>
  ),
}));

import DocumentReview from './DocumentReview';

const reviewSource = readFileSync(join(process.cwd(), 'src', 'pages', 'DocumentReview.tsx'), 'utf8');
const edgeSource = readFileSync(join(process.cwd(), 'supabase', 'functions', 'interpret-document', 'index.ts'), 'utf8');

function LocationProbe() {
  return <output data-testid="location-probe">{useLocation().pathname}</output>;
}

const renderReview = (locale: 'he' | 'en' = 'he') => render(
  <LocaleProvider initialLocale={locale}>
    <MemoryRouter initialEntries={['/documents/document-1/review']}>
      <LocationProbe />
      <Routes><Route path="/documents/:documentId/review" element={<DocumentReview />} /></Routes>
    </MemoryRouter>
  </LocaleProvider>,
);

describe('מסך בדיקת מסמך שנכשל', () => {
  beforeEach(() => {
    rpc.mockReset();
    invoke.mockReset();
    refetch.mockClear();
    scanningRefetch.mockClear();
    createSignedUrl.mockReset();
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://example.test/source' }, error: null });
    uploadDocument.mockReset();
    scanning.states = {};
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

describe('החלפת מסמך אחרי כשל סריקה', () => {
  beforeEach(() => {
    rpc.mockReset();
    invoke.mockReset();
    refetch.mockClear();
    scanningRefetch.mockClear();
    createSignedUrl.mockReset();
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://example.test/source' }, error: null });
    uploadDocument.mockReset();
    uploadDocument.mockResolvedValue({ documentId: 'document-2', jobId: 'job-2' });
    processing.snapshots = {
      'document-1': {
        documentId: 'document-1', stage: 'failed',
        document: {
          id: 'document-1', file_name: 'failed.pdf', storage_path: 'org-1/failed.pdf',
          document_kind: 'invoice',
        },
        job: { id: 'job-1', status: 'failed', last_error_message: 'scan failed' },
        interpretation: null,
      },
    };
    scanning.states = {
      'document-1': {
        document_id: 'document-1', scan_job_id: 'scan-1', processing_job_id: 'job-1',
        status: 'failed', requested_mode: 'auto', manual_corners: null,
        last_error_code: 'corrupt_document', last_error_message: null,
        output_id: null, output_storage_path: null, output_mode: null,
        detected_corners: null, corners_source: null, rotation_degrees: null,
        accepted: false, updated_at: '2026-09-05T00:00:00Z',
      },
    };
  });

  it('retries only the supersede command with the same key after the upload already succeeded', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'supersede response lost' } })
      .mockResolvedValueOnce({
        data: { replacement_document_id: 'document-2', idempotent: true }, error: null,
      });
    const { container } = renderReview();
    const input = await waitFor(() => {
      const found = container.querySelector('input[type="file"]');
      expect(found).not.toBeNull();
      return found!;
    });
    const replacement = new File(['replacement'], 'replacement.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [replacement] } });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('supersede_failed_document', expect.objectContaining({
      p_failed_document_id: 'document-1',
      p_replacement_document_id: 'document-2',
    })));
    const firstKey = (rpc.mock.calls[0]![1] as { p_idempotency_key: string }).p_idempotency_key;

    await userEvent.click(await screen.findByRole('button', { name: 'ניסיון נוסף' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    expect((rpc.mock.calls[1]![1] as { p_idempotency_key: string }).p_idempotency_key).toBe(firstKey);
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/documents/document-2/review');
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
    // Legacy/unknown responses without a code remain raw instead of being guessed into our vocabulary.
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

  it('מעדיפה קוד Edge מוכר ומפענחת אותו בשפת הקורא', async () => {
    invoke.mockResolvedValue({
      error: {
        context: {
          json: async () => ({
            error: { code: 'provider_unavailable', message: 'שירות הפירוש אינו זמין כרגע.' },
          }),
        },
      },
    });

    renderReview('en');
    expect(await screen.findByText('The data check is currently unavailable. Try again later.'))
      .toBeInTheDocument();
    expect(screen.queryByText('שירות הפירוש אינו זמין כרגע.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('ממפה כל קוד שגיאה קנוני של interpret-document', () => {
    const edgeBlock = edgeSource.match(/type EdgeErrorCode =([\s\S]*?);/)?.[1] ?? '';
    const edgeCodes = [...edgeBlock.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]).sort();
    const clientBlock = reviewSource.match(/const INTERPRET_ERROR_KEY = \{([\s\S]*?)\} as const/)?.[1] ?? '';
    const clientCodes = [...clientBlock.matchAll(/^\s*([a-z_]+):/gm)].map((match) => match[1]).sort();

    expect(edgeCodes).not.toHaveLength(0);
    expect(clientCodes).toEqual(edgeCodes);
  });
});

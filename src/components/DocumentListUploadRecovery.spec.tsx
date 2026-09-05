import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';
import { ToastProvider } from './ui';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  tusUpload: vi.fn(),
  enqueue: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'owner-1', role: 'owner', org_id: 'org-1' },
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getUser: mocks.getUser },
    rpc: (...args: unknown[]) => mocks.rpc(...args),
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({
              data: { supplier_id: 'supplier-1', invoice_date: '2026-09-04' },
              error: null,
            }),
          }),
        }),
      }),
    })),
  },
}));

vi.mock('../lib/tusUpload', () => ({
  TusUploadCancelledError: class TusUploadCancelledError extends Error {},
  TusUploadError: class TusUploadError extends Error {},
  tusUploadToDocuments: (...args: unknown[]) => mocks.tusUpload(...args),
}));

vi.mock('../lib/useQuery', () => ({
  useQuery: () => ({
    data: [], loading: false, fetching: false, error: null, refetch: mocks.refetch,
  }),
  unwrap: (value: { data: unknown; error: unknown }) => {
    if (value.error) throw value.error;
    return value.data;
  },
}));

vi.mock('../lib/useDocumentProcessing', () => ({
  useDocumentProcessing: () => ({
    data: {}, snapshots: {}, loading: false, fetching: false, error: null, refetch: mocks.refetch,
  }),
}));

vi.mock('../lib/offlineQueue', () => ({
  offlineQueue: { refresh: vi.fn(), subscribe: () => () => {}, getSnapshot: () => ({ entries: [] }) },
}));

vi.mock('../lib/offlineDb', () => ({
  claimPendingPhotos: vi.fn(), deletePendingPhoto: vi.fn(), putPendingPhoto: vi.fn(),
  receiptPendingServerAcceptance: vi.fn(async () => false), updatePendingPhoto: vi.fn(),
}));

vi.mock('./UploadCenter', () => ({
  UploadCenter: () => null,
  claimActiveUploadTask: () => null,
  getUploadCenterSnapshot: () => ({ entries: [] }),
  subscribeUploadCenter: () => () => {},
  enqueueUploadCenterBatch: (...args: unknown[]) => mocks.enqueue(...args),
}));

import { DocumentList } from './FileUpload';

function Harness() {
  return (
    <MemoryRouter>
      <LocaleProvider initialLocale="he">
        <ToastProvider>
          <DocumentList entityType="invoice" entityId="invoice-1" />
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  );
}

const pdf = (name: string) => new File(['document'], name, { type: 'application/pdf' });

function picker(container: HTMLElement) {
  return container.querySelector('[data-document-upload-input]') as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
  mocks.tusUpload.mockReturnValue({ done: Promise.resolve(), abort: vi.fn() });
  mocks.refetch.mockResolvedValue(true);
  mocks.enqueue.mockImplementation(async (
    items: File[],
    worker: (item: File) => Promise<unknown>,
    options: { classifyFailure: (item: File, error: unknown) => unknown },
  ) => {
    const succeeded: File[] = [];
    const failed: Array<{ item: File; error: unknown }> = [];
    for (const item of items) {
      try {
        await worker(item);
        succeeded.push(item);
      } catch (error) {
        options.classifyFailure(item, error);
        failed.push({ item, error });
      }
    }
    return { succeeded, failed };
  });
});

describe('DocumentList upload recovery', () => {
  it('keeps the failed batch retryable while a new batch can start', async () => {
    let registrationCalls = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'register_uploaded_document') {
        registrationCalls += 1;
        if (registrationCalls === 1) return { data: null, error: { message: 'Failed to fetch' }, status: 503 };
        return { data: { document_id: `doc-${registrationCalls}` }, error: null };
      }
      return { data: { processing_job_id: `job-${registrationCalls}` }, error: null };
    });
    const { container } = render(<Harness />);
    const first = pdf('first.pdf');
    await userEvent.upload(picker(container), first);

    const attach = await screen.findByRole('button', { name: 'העלאת קובץ' });
    expect(attach).toBeEnabled();
    expect(screen.getByRole('button', { name: 'ניסיון חוזר לנכשלים בלבד' })).toBeInTheDocument();

    await userEvent.upload(picker(container), pdf('second.pdf'));
    await waitFor(() => expect(mocks.tusUpload).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'ניסיון חוזר לנכשלים בלבד' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'ניסיון חוזר לנכשלים בלבד' }));
    await waitFor(() => expect(registrationCalls).toBe(3));
    expect(mocks.tusUpload).toHaveBeenCalledTimes(2);
  });

  it('discards a retry record without deleting a source already stored safely', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' }, status: 503 });
    const { container } = render(<Harness />);
    await userEvent.upload(picker(container), pdf('stored.pdf'));

    expect(await screen.findByText(/הקובץ המקורי כבר נשמר/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'ויתור על ניסיון חוזר' }));
    expect(screen.queryByRole('button', { name: 'ניסיון חוזר לנכשלים בלבד' })).toBeNull();
    expect(mocks.tusUpload).toHaveBeenCalledTimes(1);
  });

  it('shows the Hebrew failure sentence without appending its internal code', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' }, status: 503 });
    const { container } = render(<Harness />);
    await userEvent.upload(picker(container), pdf('error.pdf'));

    expect(await screen.findByText(/תקלה זמנית/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('document_registration_transient');
  });

  it('does not leave a green zero-failure summary after a clean upload', async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === 'register_uploaded_document'
      ? { data: { document_id: 'doc-clean' }, error: null }
      : { data: { processing_job_id: 'job-clean' }, error: null });
    const { container } = render(<Harness />);
    await userEvent.upload(picker(container), pdf('clean.pdf'));

    await waitFor(() => expect(mocks.tusUpload).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/0 לא הושלמו/)).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  insertSingle: vi.fn(),
  remove: vi.fn(),
  rpc: vi.fn(),
  tusUpload: vi.fn(),
  markStored: vi.fn(),
  markRegistered: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getUser: mocks.getUser },
    from: vi.fn(() => ({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({ single: mocks.insertSingle })),
      })),
    })),
    storage: { from: vi.fn(() => ({ remove: mocks.remove })) },
    rpc: mocks.rpc,
  },
}));

vi.mock('../lib/tusUpload', () => ({
  TusUploadCancelledError: class TusUploadCancelledError extends Error {},
  TusUploadError: class TusUploadError extends Error {},
  tusUploadToDocuments: mocks.tusUpload,
}));

vi.mock('./UploadCenter', () => ({
  UploadCenter: () => null,
  claimActiveUploadTask: () => ({
    onProgress: vi.fn(),
    markStored: mocks.markStored,
    markRegistered: mocks.markRegistered,
    registerAbort: vi.fn(),
    isCanceled: () => false,
  }),
  enqueueUploadCenterBatch: vi.fn(),
  getUploadCenterSnapshot: () => ({ entries: [] }),
  subscribeUploadCenter: () => () => {},
}));

import { documentUploadFailure, uploadDocument } from './FileUpload';

const file = (name: string) => new File(['document'], name, { type: 'application/pdf' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mocks.tusUpload.mockReturnValue({ done: Promise.resolve(), abort: vi.fn() });
  mocks.rpc.mockResolvedValue({ data: 'job-1', error: null });
});

describe('uploadDocument registration recovery', () => {
  it('reuses the stored object when another upload surface retries the same File', async () => {
    const current = file('invoice.pdf');
    mocks.insertSingle
      .mockResolvedValueOnce({ data: null, error: { message: 'registration timeout' } })
      .mockResolvedValueOnce({ data: { id: 'doc-1' }, error: null });
    mocks.remove.mockResolvedValueOnce({ error: { message: 'storage unavailable' } });

    const firstError = await uploadDocument('org-1', 'inbox', null, current).catch((error) => error);
    const failure = documentUploadFailure(firstError);
    expect(failure.resume).toMatchObject({ documentId: null });
    expect(failure.retryable).toBe(true);

    await expect(uploadDocument('org-1', 'inbox', null, current))
      .resolves.toEqual({ documentId: 'doc-1', jobId: 'job-1' });

    expect(mocks.tusUpload).toHaveBeenCalledTimes(1);
    expect(mocks.insertSingle).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('does not leave the Upload Center in stored state after cleanup removed the object', async () => {
    const current = file('cleaned-up.pdf');
    mocks.insertSingle.mockResolvedValueOnce({ data: null, error: { message: 'registration rejected' } });
    mocks.remove.mockResolvedValueOnce({ error: null });

    const error = await uploadDocument('org-1', 'inbox', null, current).catch((reason) => reason);
    expect(documentUploadFailure(error).resume).toBeNull();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.markStored).not.toHaveBeenCalled();
    expect(mocks.markRegistered).not.toHaveBeenCalled();
  });
});

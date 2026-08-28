import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  remove: vi.fn(),
  rpc: vi.fn(),
  tusUpload: vi.fn(),
  markStored: vi.fn(),
  markRegistered: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getUser: mocks.getUser },
    from: vi.fn(),
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

import { he } from '../lib/i18n/dictionaries/he';
import type { Dictionary } from '../lib/i18n/dictionaries/he';
import { translate, type TKey } from '../lib/i18n/t';
import { documentUploadFailure, uploadDocument } from './FileUpload';

/**
 * The failure carries a CODE now, so each expectation below resolves it through the HEBREW
 * `errors` namespace and keeps the exact phrase it always asserted. That is deliberately not
 * `t(key)` against `t(key)`: these sentences are the difference between "the file is safe, only
 * the row is missing" and "upload it again", and a dictionary that lost one would still pass.
 */
const say = (code: string): string => translate(he as unknown as Dictionary, `errors.${code}` as TKey);

const file = (name: string) => new File(['document'], name, { type: 'application/pdf' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mocks.tusUpload.mockReturnValue({ done: Promise.resolve(), abort: vi.fn() });
});

describe('uploadDocument registration recovery', () => {
  it('recovers a committed registration whose response was lost without deleting or re-uploading', async () => {
    const current = file('invoice.pdf');
    let registrationCalls = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'register_uploaded_document') {
        registrationCalls += 1;
        if (registrationCalls === 1) {
          // The database committed doc-1, but the transport lost its response.
          return { data: null, error: { message: 'Failed to fetch' } };
        }
        return { data: { document_id: 'doc-1', idempotent: true }, error: null };
      }
      return { data: { processing_job_id: 'job-1' }, error: null };
    });

    const firstError = await uploadDocument(
      'org-1', 'inbox', null, current, {}, { objectKey: 'upload-key-0001' },
    ).catch((error) => error);
    const failure = documentUploadFailure(firstError);
    expect(failure.resume).toEqual({
      storagePath: 'org-1/inbox/upload-key-0001_invoice.pdf',
      documentId: null,
      clientUploadKey: 'upload-key-0001',
    });
    expect(failure.retryable).toBe(true);

    await expect(uploadDocument('org-1', 'inbox', null, current))
      .resolves.toEqual({ documentId: 'doc-1', jobId: 'job-1' });

    expect(mocks.tusUpload).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'register_uploaded_document')).toHaveLength(2);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'begin_document_intake')).toHaveLength(1);
    expect(mocks.rpc.mock.calls[0][1]).toEqual({
      p_client_upload_key: 'upload-key-0001',
      p_entity_type: 'inbox',
      p_entity_id: null,
      p_storage_path: 'org-1/inbox/upload-key-0001_invoice.pdf',
      p_file_name: 'invoice.pdf',
      p_mime_type: 'application/pdf',
      p_document_kind: 'other',
      p_supplier_id: null,
      p_document_date: null,
    });
    expect(mocks.rpc.mock.calls[1][1]).toEqual(mocks.rpc.mock.calls[0][1]);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('carries the stable key in an explicit resume across a reconstructed File', async () => {
    const firstFile = file('receipt.pdf');
    let registrationCalls = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'register_uploaded_document') {
        registrationCalls += 1;
        if (registrationCalls === 1) return { data: null, error: { message: 'gateway timeout' } };
        return { data: { document_id: 'doc-2', idempotent: false }, error: null };
      }
      return { data: { processing_job_id: 'job-2' }, error: null };
    });

    const error = await uploadDocument(
      'org-1', 'inbox', null, firstFile, {}, { objectKey: 'offline-key-0002' },
    ).catch((reason) => reason);
    const resume = documentUploadFailure(error).resume;
    expect(resume?.clientUploadKey).toBe('offline-key-0002');

    const reconstructedFile = file('receipt.pdf');
    await expect(uploadDocument(
      'org-1', 'inbox', null, reconstructedFile, {}, { resume },
    )).resolves.toEqual({ documentId: 'doc-2', jobId: 'job-2' });

    expect(mocks.tusUpload).toHaveBeenCalledTimes(1);
    const registrationArgs = mocks.rpc.mock.calls
      .filter(([name]) => name === 'register_uploaded_document')
      .map(([, args]) => args);
    expect(registrationArgs[1]).toEqual(registrationArgs[0]);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['network status zero', { data: null, error: { message: 'Network request failed' }, status: 0 }],
    ['PostgREST connection', { data: null, error: { code: 'PGRST001', message: 'database unavailable' }, status: 503 }],
    ['serialization', { data: null, error: { code: '40001', message: 'serialization failure' }, status: 500 }],
    ['deadlock', { data: null, error: { code: '40P01', message: 'deadlock detected' }, status: 500 }],
    ['gateway timeout', { data: null, error: { message: 'upstream unavailable' }, status: 503 }],
  ])('marks a transient %s registration failure retryable while preserving the stored object', async (_label, response) => {
    mocks.rpc.mockResolvedValueOnce(response);
    const current = file('transient.pdf');

    const error = await uploadDocument(
      'org-1', 'inbox', null, current, {}, { objectKey: 'transient-key-0003' },
    ).catch((reason) => reason);
    const failure = documentUploadFailure(error);

    expect(failure.retryable).toBe(true);
    expect(failure.resume).toMatchObject({
      storagePath: 'org-1/inbox/transient-key-0003_transient.pdf',
      clientUploadKey: 'transient-key-0003',
      documentId: null,
    });
    expect(say(failure.code)).toContain('תקלה זמנית');
    expect(mocks.tusUpload).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['permission', { data: null, error: { code: '42501', message: 'not_authorized' }, status: 403 }, 'אין הרשאה'],
    ['permission despite 500 transport status', { data: null, error: { code: '42501', message: 'not_authorized' }, status: 500 }, 'אין הרשאה'],
    ['invalid key', { data: null, error: { code: '22023', message: 'document_upload_key_invalid' }, status: 400 }, 'אינם תקינים'],
    ['conflict', { data: null, error: { code: '23505', message: 'document_upload_key_conflict' }, status: 409 }, 'כבר קשור'],
    ['retired key', { data: null, error: { code: '23505', message: 'document_upload_key_retired' }, status: 409 }, 'כבר קשור'],
    ['missing RPC', { data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 503 }, 'גרסת השרת'],
    ['misconfigured PostgREST', { data: null, error: { code: 'PGRST300', message: 'JWT secret missing' }, status: 500 }, 'אינו מוגדר כראוי'],
    ['generic server error', { data: null, error: { message: 'internal server error' }, status: 500 }, 'נדרשת בדיקה'],
    ['unsupported server response', { data: null, error: { message: 'unsupported protocol' }, status: 505 }, 'נדרשת בדיקה'],
    ['invalid target', { data: null, error: { code: '23503', message: 'foreign key violation' }, status: 409 }, 'אינם תקינים'],
  ])('marks a terminal %s registration failure as needs-attention without inviting retry', async (_label, response, message) => {
    mocks.rpc.mockResolvedValueOnce(response);
    const current = file('terminal.pdf');

    const error = await uploadDocument(
      'org-1', 'inbox', null, current, {}, { objectKey: 'terminal-key-0004' },
    ).catch((reason) => reason);
    const failure = documentUploadFailure(error);

    expect(failure.retryable).toBe(false);
    expect(failure.resume).toMatchObject({
      storagePath: 'org-1/inbox/terminal-key-0004_terminal.pdf',
      clientUploadKey: 'terminal-key-0004',
      documentId: null,
    });
    expect(say(failure.code)).toContain(message);
    expect(mocks.tusUpload).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('keeps an unknown registration response as stored needs-attention without blind retry', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'UNCLASSIFIED', message: 'unexpected rejection' },
      status: 409,
    });
    const current = file('unknown.pdf');

    const error = await uploadDocument(
      'org-1', 'inbox', null, current, {}, { objectKey: 'unknown-key-0008' },
    ).catch((reason) => reason);
    const failure = documentUploadFailure(error);

    expect(failure).toMatchObject({ retryable: false, registered: false });
    expect(failure.resume).toMatchObject({
      storagePath: 'org-1/inbox/unknown-key-0008_unknown.pdf',
      documentId: null,
      clientUploadKey: 'unknown-key-0008',
    });
    expect(say(failure.code)).toContain('נדרשת בדיקה');
    expect(mocks.tusUpload).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('treats a successful HTTP response without a document id as a terminal contract violation', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null, status: 200 });

    const error = await uploadDocument(
      'org-1', 'inbox', null, file('malformed.pdf'), {}, { objectKey: 'malformed-key-0005' },
    ).catch((reason) => reason);
    const failure = documentUploadFailure(error);

    expect(failure.retryable).toBe(false);
    expect(failure.resume?.clientUploadKey).toBe('malformed-key-0005');
    expect(say(failure.code)).toContain('תשובת שרת לא תקינה');
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('answers with a registered code, never with words the server chose', async () => {
    // The refusal used to be a finished sentence, which meant a `TusUploadError` put a synthetic
    // token in front of a person and a stored `lastError` never matched `errorText`. What crosses
    // the boundary now is a name this product owns, and it has to resolve to a real sentence.
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'ERROR: permission denied for relation private.x at 10.0.3.7' },
      status: 403,
    });

    const error = await uploadDocument(
      'org-1', 'inbox', null, file('leak.pdf'), {}, { objectKey: 'leak-key-0009' },
    ).catch((reason) => reason);
    const failure = documentUploadFailure(error);

    expect(failure.code).toBe('document_registration_not_authorized');
    expect(failure.code).not.toContain('10.0.3.7');
    expect(say(failure.code)).toMatch(/[֐-׿]/);
  });
  it('keeps a resume point when the registration promise rejects after TUS', async () => {
    mocks.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const error = await uploadDocument(
      'org-1', 'inbox', null, file('network.pdf'), {}, { objectKey: 'network-key-0006' },
    ).catch((reason) => reason);
    const failure = documentUploadFailure(error);

    expect(failure.retryable).toBe(true);
    expect(failure.resume?.clientUploadKey).toBe('network-key-0006');
    expect(mocks.tusUpload).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('retries only the enqueue when its response is lost after durable registration', async () => {
    const current = file('enqueue.pdf');
    let enqueueCalls = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'register_uploaded_document') {
        return { data: { document_id: 'doc-enqueue' }, error: null };
      }
      enqueueCalls += 1;
      if (enqueueCalls === 1) throw new TypeError('Failed to fetch');
      return { data: { processing_job_id: 'job-enqueue' }, error: null };
    });

    const error = await uploadDocument(
      'org-1', 'inbox', null, current, {}, { objectKey: 'enqueue-key-0007' },
    ).catch((reason) => reason);
    const failure = documentUploadFailure(error);

    expect(failure.retryable).toBe(true);
    expect(failure.registered).toBe(true);
    expect(failure.resume).toEqual({
      storagePath: 'org-1/inbox/enqueue-key-0007_enqueue.pdf',
      documentId: 'doc-enqueue',
      clientUploadKey: 'enqueue-key-0007',
    });

    await expect(uploadDocument('org-1', 'inbox', null, current))
      .resolves.toEqual({ documentId: 'doc-enqueue', jobId: 'job-enqueue' });
    expect(mocks.tusUpload).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'register_uploaded_document')).toHaveLength(1);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'begin_document_intake')).toHaveLength(2);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('falls back to the legacy enqueue RPC only when the intake RPC is not installed', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'register_uploaded_document') {
        return { data: { document_id: 'doc-legacy' }, error: null };
      }
      if (name === 'begin_document_intake') {
        return {
          data: null,
          error: { code: 'PGRST202', message: 'Could not find the function public.begin_document_intake' },
          status: 404,
        };
      }
      if (name === 'enqueue_document_processing') return { data: 'job-legacy', error: null };
      throw new Error(`unexpected RPC ${name}`);
    });

    await expect(uploadDocument(
      'org-1', 'inbox', null, file('legacy.pdf'), {}, { objectKey: 'legacy-key-0009' },
    )).resolves.toEqual({ documentId: 'doc-legacy', jobId: 'job-legacy' });

    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      'register_uploaded_document',
      'begin_document_intake',
      'enqueue_document_processing',
    ]);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('does not fall back after an ambiguous intake transport failure', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'register_uploaded_document') {
        return { data: { document_id: 'doc-ambiguous' }, error: null };
      }
      if (name === 'begin_document_intake') throw new TypeError('Failed to fetch');
      throw new Error(`unexpected RPC ${name}`);
    });

    const error = await uploadDocument(
      'org-1', 'inbox', null, file('ambiguous.pdf'), {}, { objectKey: 'ambiguous-key-0010' },
    ).catch((reason) => reason);

    expect(documentUploadFailure(error)).toMatchObject({ retryable: true, registered: true });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      'register_uploaded_document',
      'begin_document_intake',
    ]);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

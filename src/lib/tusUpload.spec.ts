// tus wrapper contract (migration 0065): mime normalization, reservation renewal
// timing, and the exactly-one renew-then-resume on a 403 PATCH. tus-js-client is mocked
// at module level and supabase is a local stub — zero network calls anywhere.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeUploadOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  chunkSize?: number;
  uploadDataDuringCreation?: boolean;
  removeFingerprintOnSuccess?: boolean;
  onProgress?: (bytesSent: number, bytesTotal: number) => void;
  onChunkComplete?: (chunkSize: number, bytesAccepted: number, bytesTotal: number) => void;
  onSuccess?: (payload: unknown) => void;
  onError?: (error: Error) => void;
}

const tusState = vi.hoisted(() => ({
  instances: [] as Array<{ file: unknown; options: FakeUploadOptions; started: number; aborted: number }>,
}));

vi.mock('tus-js-client', () => {
  class Upload {
    file: unknown;
    options: FakeUploadOptions;
    started = 0;
    aborted = 0;
    constructor(file: unknown, options: FakeUploadOptions) {
      this.file = file;
      this.options = options;
      tusState.instances.push(this);
    }
    start() {
      this.started += 1;
    }
    async abort() {
      this.aborted += 1;
    }
  }
  return { Upload };
});

const supabaseState = vi.hoisted(() => ({
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>>(),
  session: { access_token: 'test-access-token' } as { access_token: string } | null,
}));

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: supabaseState.session }, error: null }),
    },
    rpc: (name: string, args: Record<string, unknown>) => supabaseState.rpc(name, args),
  },
}));

vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:55431');

import {
  RESERVATION_RENEWAL_WINDOW_MS,
  TUS_CHUNK_SIZE,
  TusUploadCancelledError,
  TusUploadError,
  normalizeUploadMime,
  tusUploadToDocuments,
} from './tusUpload';

function detailedError(status: number, method: string): Error {
  const error = new Error(`tus: unexpected response while uploading (${status})`) as Error & {
    originalResponse: { getStatus: () => number };
    originalRequest: { getMethod: () => string };
  };
  error.originalResponse = { getStatus: () => status };
  error.originalRequest = { getMethod: () => method };
  return error;
}

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

async function startUpload(overrides: Partial<Parameters<typeof tusUploadToDocuments>[1]> = {}) {
  const file = new File(['payload'], 'doc.pdf', { type: 'application/pdf' });
  const handle = tusUploadToDocuments(file, {
    objectName: 'org-1/supplier/sup-1/doc-1/doc.pdf',
    contentType: 'application/pdf',
    ...overrides,
  });
  await vi.waitFor(() => {
    if (!tusState.instances.length) throw new Error('upload not created yet');
  }, { timeout: 3_000 });
  const upload = tusState.instances[tusState.instances.length - 1];
  return { handle, upload };
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  tusState.instances.length = 0;
  supabaseState.session = { access_token: 'test-access-token' };
  supabaseState.rpc.mockReset();
  supabaseState.rpc.mockResolvedValue({ data: { expires_at: inMinutes(20) }, error: null });
});

describe('normalizeUploadMime — the server-equivalent lower(split_part(trim(m), ";", 1))', () => {
  it('strips a charset parameter', () => {
    expect(normalizeUploadMime('text/csv; charset=utf-8')).toBe('text/csv');
  });

  it('trims and lowercases', () => {
    expect(normalizeUploadMime('  Application/PDF  ')).toBe('application/pdf');
  });

  it('leaves a clean mime unchanged', () => {
    expect(normalizeUploadMime('image/jpeg')).toBe('image/jpeg');
  });
});

describe('tusUploadToDocuments — creation contract', () => {
  it('creates the upload with the mandated endpoint, headers, chunking and normalized metadata', async () => {
    const { upload } = await startUpload({ contentType: 'text/csv; charset=utf-8', objectName: 'org-1/inbox/1_a.csv' });
    expect(upload.options.endpoint).toBe('http://127.0.0.1:55431/storage/v1/upload/resumable');
    expect(upload.options.headers).toEqual({
      authorization: 'Bearer test-access-token',
      'x-upsert': 'false',
    });
    expect(upload.options.chunkSize).toBe(TUS_CHUNK_SIZE);
    expect(upload.options.uploadDataDuringCreation).toBe(true);
    expect(upload.options.removeFingerprintOnSuccess).toBe(true);
    expect(upload.options.metadata).toEqual({
      bucketName: 'documents',
      objectName: 'org-1/inbox/1_a.csv',
      contentType: 'text/csv',
      cacheControl: '3600',
    });
    expect(upload.started).toBe(1);
  });

  it('maps byte progress to a rounded percent', async () => {
    const percents: number[] = [];
    const { upload } = await startUpload({ onProgress: (percent) => percents.push(percent) });
    upload.options.onProgress?.(3_145_728, 6_291_456);
    upload.options.onProgress?.(6_291_456, 6_291_456);
    expect(percents).toEqual([50, 100]);
  });

  it('resolves done on success and rejects with a cancellation error after abort', async () => {
    const success = await startUpload();
    success.upload.options.onSuccess?.({});
    await expect(success.handle.done).resolves.toBeUndefined();

    tusState.instances.length = 0;
    const cancelled = await startUpload();
    await cancelled.handle.abort();
    expect(cancelled.upload.aborted).toBe(1);
    await expect(cancelled.handle.done).rejects.toBeInstanceOf(TusUploadCancelledError);
  });
});

describe('reservation renewal timing (price-document flow)', () => {
  it('renews on chunk completion once the reservation expires within the 5-minute window', async () => {
    const { upload } = await startUpload({
      renewal: { documentId: 'doc-1', expiresAt: inMinutes(3) },
    });
    upload.options.onChunkComplete?.(TUS_CHUNK_SIZE, TUS_CHUNK_SIZE, TUS_CHUNK_SIZE * 2);
    await vi.waitFor(() => expect(supabaseState.rpc).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(supabaseState.rpc).toHaveBeenCalledWith('renew_supplier_price_document_upload', {
      p_document_id: 'doc-1',
    });
    // The renewed expiry pushed the clock out — the next chunk does not renew again.
    await flushMicrotasks();
    upload.options.onChunkComplete?.(TUS_CHUNK_SIZE, TUS_CHUNK_SIZE * 2, TUS_CHUNK_SIZE * 2);
    await flushMicrotasks();
    expect(supabaseState.rpc).toHaveBeenCalledTimes(1);
  });

  it('does not renew while the reservation still has more than the window left', async () => {
    const { upload } = await startUpload({
      renewal: { documentId: 'doc-1', expiresAt: new Date(Date.now() + RESERVATION_RENEWAL_WINDOW_MS + 60_000).toISOString() },
    });
    upload.options.onChunkComplete?.(TUS_CHUNK_SIZE, TUS_CHUNK_SIZE, TUS_CHUNK_SIZE * 2);
    await flushMicrotasks();
    expect(supabaseState.rpc).not.toHaveBeenCalled();
  });

  it('never calls the renew RPC without a renewal option (entity-document flow)', async () => {
    const { upload } = await startUpload();
    upload.options.onChunkComplete?.(TUS_CHUNK_SIZE, TUS_CHUNK_SIZE, TUS_CHUNK_SIZE * 2);
    await flushMicrotasks();
    expect(supabaseState.rpc).not.toHaveBeenCalled();
  });
});

describe('403 during PATCH — exactly one renew-then-resume', () => {
  it('renews once, resumes, and surfaces a translated Hebrew error on the second 403', async () => {
    const { handle, upload } = await startUpload({
      renewal: { documentId: 'doc-1', expiresAt: inMinutes(10) },
    });
    upload.options.onError?.(detailedError(403, 'PATCH'));
    await vi.waitFor(() => expect(upload.started).toBe(2), { timeout: 3_000 }); // initial start + one resume
    expect(supabaseState.rpc).toHaveBeenCalledTimes(1);
    expect(supabaseState.rpc).toHaveBeenCalledWith('renew_supplier_price_document_upload', {
      p_document_id: 'doc-1',
    });

    upload.options.onError?.(detailedError(403, 'PATCH'));
    await expect(handle.done).rejects.toBeInstanceOf(TusUploadError);
    await expect(handle.done).rejects.toThrow(/השרת דחה את ההעלאה/);
    // Still exactly one renewal — the second 403 surfaces instead of looping.
    expect(supabaseState.rpc).toHaveBeenCalledTimes(1);
    expect(upload.started).toBe(2);
  });

  it('surfaces the Hebrew error without resuming when the renew RPC itself fails', async () => {
    supabaseState.rpc.mockResolvedValue({ data: null, error: { message: 'reservation_expired' } });
    const { handle, upload } = await startUpload({
      renewal: { documentId: 'doc-1', expiresAt: inMinutes(10) },
    });
    upload.options.onError?.(detailedError(403, 'PATCH'));
    await expect(handle.done).rejects.toThrow(/השרת דחה את ההעלאה/);
    expect(upload.started).toBe(1);
  });

  it('applies the money rule when renew says the reservation is already registered', async () => {
    // OPEN-DECISIONS #95: document_upload_reservation_registered means the
    // registered document already exists — the failure text must forbid a re-upload.
    supabaseState.rpc.mockResolvedValue({
      data: null,
      error: { message: 'document_upload_reservation_registered' },
    });
    const { handle, upload } = await startUpload({
      renewal: { documentId: 'doc-1', expiresAt: inMinutes(10) },
    });
    upload.options.onError?.(detailedError(403, 'PATCH'));
    await expect(handle.done).rejects.toThrow(/המסמך כבר נרשם במערכת — אין להעלות אותו שוב/);
    expect(upload.started).toBe(1);
  });

  it('does not renew for a 403 outside PATCH or without a renewal option', async () => {
    const creation = await startUpload({ renewal: { documentId: 'doc-1', expiresAt: inMinutes(10) } });
    creation.upload.options.onError?.(detailedError(403, 'POST'));
    await expect(creation.handle.done).rejects.toThrow(/השרת דחה את ההעלאה/);
    expect(supabaseState.rpc).not.toHaveBeenCalled();

    tusState.instances.length = 0;
    const plain = await startUpload();
    plain.upload.options.onError?.(detailedError(403, 'PATCH'));
    await expect(plain.handle.done).rejects.toBeInstanceOf(TusUploadError);
    expect(supabaseState.rpc).not.toHaveBeenCalled();
  });

  it('classifies a network failure as retryable and a 4xx verdict as final', async () => {
    const network = await startUpload();
    network.upload.options.onError?.(new Error('tus: failed to upload, originated from request'));
    const networkError = await network.handle.done.catch((error: unknown) => error);
    expect(networkError).toBeInstanceOf(TusUploadError);
    expect((networkError as TusUploadError).retryable).toBe(true);

    tusState.instances.length = 0;
    const conflict = await startUpload();
    conflict.upload.options.onError?.(detailedError(409, 'POST'));
    const conflictError = await conflict.handle.done.catch((error: unknown) => error);
    expect(conflictError).toBeInstanceOf(TusUploadError);
    expect((conflictError as TusUploadError).retryable).toBe(false);
  });
});

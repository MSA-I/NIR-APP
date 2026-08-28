import { he } from '../lib/i18n/dictionaries/he';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimPendingPhotos: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../lib/offlineDb', () => ({
  claimPendingPhotos: mocks.claimPendingPhotos,
  deletePendingPhoto: vi.fn(),
  putPendingPhoto: vi.fn(),
  receiptPendingServerAcceptance: vi.fn(async () => false),
  updatePendingPhoto: vi.fn(),
}));
vi.mock('../lib/offlineQueue', () => ({
  offlineQueue: { refresh: mocks.refresh },
}));

import { receiptPhotoMustRemainQueued, syncPendingDocumentPhotos } from './FileUpload';

const read = (name: string) => readFileSync(join(process.cwd(), 'src', 'components', name), 'utf8');
const readPage = (name: string) => readFileSync(join(process.cwd(), 'src', 'pages', name), 'utf8');

describe('offline receipt photo wiring', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists source bytes and the tus resume point, then deletes only after upload', () => {
    const upload = read('FileUpload.tsx');
    const offlineDb = readFileSync(join(process.cwd(), 'src', 'lib', 'offlineDb.ts'), 'utf8');
    expect(upload).toContain('blob: file');
    expect(upload).toContain('storagePath: resume?.storagePath ?? null');
    expect(receiptPhotoMustRemainQueued('goods_receipt', true, true)).toBe(true);
    expect(receiptPhotoMustRemainQueued('goods_receipt', true, false)).toBe(false);
    expect(upload).toContain('await receiptPendingServerAcceptance(entityId)');
    expect(upload).toContain("photo.entityType === 'goods_receipt'");
    expect(upload.indexOf('await receiptPendingServerAcceptance(photo.entityId)')).toBeLessThan(
      upload.indexOf('await uploadDocument(photo.orgId'),
    );
    expect(upload.indexOf('await uploadDocument(photo.orgId')).toBeLessThan(
      upload.indexOf('await deletePendingPhoto(photo.id, leaseOwner, photo.syncVersion)'),
    );
    expect(upload).toContain('await updatePendingPhoto(photo.id, {');
    expect(upload).toContain("state: failure.retryable ? 'failed' : 'needs_attention'");
    expect(upload).toContain("state: failure ? (failure.retryable ? 'failed' : 'needs_attention') : 'pending'");
    // The queue stores the CODE, not a sentence, and the claim splits with it: the source
    // writes the code, and `OfflineQueueStatus` reads that column back through `errorText()`,
    // which maps codes. A stored sentence always fell through to the generic message — which
    // is why this assertion had to move rather than be deleted.
    expect(upload).toContain('lastError: failure.code');
    expect(offlineDb).toContain("db.transaction(OFFLINE_STORES.pendingPhotos, 'readwrite')");
    expect(offlineDb).toContain('await tx.store.put({ ...row, ...patch })');
    expect(offlineDb).toContain('await tx.done');
  });

  it('coalesces automatic and manual photo sync into one in-flight run', async () => {
    let release!: (photos: []) => void;
    mocks.claimPendingPhotos.mockImplementationOnce(() => new Promise<[]>(
      (resolve) => { release = resolve; },
    ));

    const automatic = syncPendingDocumentPhotos();
    const manual = syncPendingDocumentPhotos();

    expect(manual).toBe(automatic);
    expect(mocks.claimPendingPhotos).toHaveBeenCalledTimes(1);
    release([]);
    await Promise.all([automatic, manual]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('claims photos across tabs and keeps one stable object path for every retry', () => {
    const upload = read('FileUpload.tsx');
    const offlineDb = readFileSync(join(process.cwd(), 'src', 'lib', 'offlineDb.ts'), 'utf8');
    expect(upload).toContain('const photos = await claimPendingPhotos(leaseOwner, false)');
    expect(upload).toContain("if (photo.state === 'needs_attention')");
    expect(upload).toContain('objectKey: photo.clientUploadId');
    expect(upload).toContain('await deletePendingPhoto(photo.id, leaseOwner, photo.syncVersion)');
    expect(offlineDb).toContain("db.transaction(OFFLINE_STORES.pendingPhotos, 'readwrite')");
    expect(offlineDb).toContain('syncLeaseExpiresAt: now + PENDING_PHOTO_SYNC_LEASE_MS');
    expect(offlineDb).toContain('pendingPhotoLeaseMatches(row, leaseOwner, syncVersion, now)');
  });

  it('syncs the receipt action before its pending photos', () => {
    const status = read('OfflineQueueStatus.tsx');
    expect(status).toContain('offlineQueue.sync().then(() => syncPhotos())');
    expect(status.indexOf('await offlineQueue.sync()')).toBeLessThan(
      status.indexOf('await syncPhotos()'),
    );
    expect(status).not.toContain('syncPhotos(true)');
    // The counter's label moved into the dictionary, so the claim moves with it: the source
    // renders the key, and the key still carries the wording this test is about.
    expect(status).toContain("t('offline.text_5')");
    expect(he.offline.text_5).toBe('העלאות דורשות טיפול:');
    expect(status).toContain('!hasSyncableWork');
    expect(status).toContain('queue.pendingActions === 0 && queue.pendingUploads === 0');
    expect(status).toContain('photo.lastError');
    expect(status).toContain("lastAutoAttempt.current = ''");
    expect(status).toContain('to={`/receiving/${action.orderId}`}');
  });

  it('unblocks the completion screen only after the queued receipt disappears after a successful sync', () => {
    const receiving = readPage('Receiving.tsx');
    expect(receiving).toContain('completed: (existing?.completed ?? false) || complete');
    expect(receiving).toContain('const queueState = await offlineQueue.refresh()');
    expect(receiving).toContain('action.idempotencyKey === local.receiptId && action.complete');
    expect(receiving).toContain('offlineSnapshot.lastSuccessfulSyncAt === null');
    expect(receiving).toContain('action.idempotencyKey === doneReceiptId');
    expect(receiving).toContain('setDonePendingSync(false)');
    expect(receiving).toContain('const queuedConflict = queueState.actions.find');
    expect(receiving).toContain('setConflict(hydratedConflict)');
  });

  it('restricts cached bootstrap to receiving routes for the same unexpired session', () => {
    const auth = readFileSync(join(process.cwd(), 'src', 'auth', 'AuthContext.tsx'), 'utf8');
    const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    expect(auth).toContain('navigator.onLine === false && expiresAt > Date.now()');
    expect(auth).toContain('getRememberedOfflineBootstrap(session.user.id)');
    expect(app).toContain("pathname === '/receiving' || pathname.startsWith('/receiving/')");
    expect(app).toContain('offlineBootstrap && !isOfflineReceivingRoute');
  });
});

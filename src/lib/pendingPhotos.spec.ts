/**
 * §4's writer, proven at the logic layer: the flush uploads everything it can, deletes ONLY
 * what uploaded, and a failure never blocks the photos behind it. The IndexedDB half is the
 * same idb wrapper the receipt queue already trusts; the upload half is uploadDocument,
 * proven by its own path. What could silently rot is the loop's bookkeeping — so that is
 * what gets pinned.
 */
import { describe, expect, it } from 'vitest';
import { flushPendingPhotos } from './pendingPhotos';
import type { OfflinePendingPhoto } from './offlineDb';

const photo = (id: number, name: string): OfflinePendingPhoto => ({
  id,
  entityType: 'goods_receipt',
  entityId: 'rcpt-1',
  fileName: name,
  blob: new Blob(['x'], { type: 'image/jpeg' }),
  createdAt: 1723190400000,
});

describe('flushPendingPhotos', () => {
  it('uploads all, removes exactly the uploaded ones, in order', async () => {
    const removed: number[] = [];
    const uploadedNames: string[] = [];
    const result = await flushPendingPhotos({
      list: async () => [photo(1, 'a.jpg'), photo(2, 'b.jpg')],
      remove: async (id) => { removed.push(id); },
      upload: async (p) => { uploadedNames.push(p.fileName); },
    });
    expect(result).toEqual({ uploaded: 2, remaining: 0 });
    expect(uploadedNames).toEqual(['a.jpg', 'b.jpg']);
    expect(removed).toEqual([1, 2]);
  });

  it('a failed upload keeps ITS row and never blocks the next photo', async () => {
    const removed: number[] = [];
    const result = await flushPendingPhotos({
      list: async () => [photo(1, 'fails.jpg'), photo(2, 'works.jpg')],
      remove: async (id) => { removed.push(id); },
      upload: async (p) => { if (p.fileName === 'fails.jpg') throw new Error('offline again'); },
    });
    expect(result).toEqual({ uploaded: 1, remaining: 1 });
    expect(removed).toEqual([2]); // the failed photo's bytes stay on the device
  });

  it('deletes only after the upload resolved — losing bytes is worse than uploading twice', async () => {
    const order: string[] = [];
    await flushPendingPhotos({
      list: async () => [photo(7, 'a.jpg')],
      remove: async () => { order.push('remove'); },
      upload: async () => { order.push('upload'); },
    });
    expect(order).toEqual(['upload', 'remove']);
  });
});

/**
 * pending_photos finally has a writer (DEBT-REGISTER §4, closed 09.08.2026).
 *
 * The store and its API existed since wave 8 with zero callers — schema prepared, nothing
 * written. The wiring is deliberately the same shape as the receipt queue: stash locally
 * when the network is gone, flush automatically when it returns, never lose the bytes.
 *
 * The flush logic is pure and dependency-injected so it is testable without IndexedDB;
 * the real deps (offlineDb + uploadDocument) are wired in components/FileUpload.tsx,
 * which owns the upload path the flush must reuse.
 */
import { putPendingPhoto, type OfflinePendingPhoto } from './offlineDb';

export interface PendingPhotoFlushDeps {
  list: () => Promise<OfflinePendingPhoto[]>;
  remove: (id: number) => Promise<void>;
  upload: (photo: OfflinePendingPhoto) => Promise<unknown>;
}

export interface PendingPhotoFlushResult {
  uploaded: number;
  remaining: number;
}

/** Stash a captured file for later upload. The queue strip's counter reads the same store. */
export async function stashPendingPhoto(entityType: string, entityId: string, file: File): Promise<void> {
  await putPendingPhoto({
    entityType,
    entityId,
    fileName: file.name,
    blob: file,
    createdAt: Date.now(),
  });
}

/**
 * Upload every stashed photo; a failure keeps ITS row for the next attempt and never blocks
 * the others. A photo is deleted from the device only after its upload call resolved — the
 * order matters: losing bytes is worse than uploading twice (the registration insert is the
 * idempotency-sensitive step and uploadDocument already guards it).
 */
export async function flushPendingPhotos(deps: PendingPhotoFlushDeps): Promise<PendingPhotoFlushResult> {
  const photos = await deps.list();
  let uploaded = 0;
  let remaining = 0;
  for (const photo of photos) {
    try {
      await deps.upload(photo);
      if (photo.id !== undefined) await deps.remove(photo.id);
      uploaded += 1;
    } catch {
      remaining += 1;
    }
  }
  return { uploaded, remaining };
}

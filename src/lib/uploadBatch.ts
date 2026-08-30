import type { TKey } from './i18n/t';

export interface UploadBatchResult<T> {
  succeeded: T[];
  failed: { item: T; error: unknown }[];
}

export interface UploadBatchSummary {
  succeeded: string[];
  failed: string[];
}

export interface UploadBatchI18n {
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  errorText: (error: unknown) => string;
}

export type UploadBatchDelegate = <T>(
  items: readonly T[],
  upload: (item: T) => Promise<unknown>,
  i18n: UploadBatchI18n,
) => Promise<UploadBatchResult<T>>;

/**
 * The Upload Center's queue (wave 6b) registers itself here at module load.
 *
 * Registration instead of a static import for one reason: this module is executed by
 * Vitest in `p2Reliability.spec.ts` without loading the Upload Center's .tsx module.
 * In the browser every `runUploadBatch` consumer imports
 * `FileUpload`, which imports `UploadCenter`, so the delegate is always registered
 * before the first call and every batch runs through the Center's queue.
 */
let uploadBatchDelegate: UploadBatchDelegate | null = null;

export function setUploadBatchDelegate(delegate: UploadBatchDelegate | null) {
  uploadBatchDelegate = delegate;
}

/**
 * Runs every item even after a failure so a retry can contain only the failed subset.
 *
 * The item and upload arguments are load-bearing. The third argument carries the current
 * locale resolvers so the global Upload Center never guesses a language outside React. The
 * implementation delegates to the Upload Center's global queue, which preserves the
 * sequential per-batch order the server contracts assume and surfaces each file's
 * upload state in the Center. The resolved result contract is identical either way:
 * one attempt per item, failures collected, order kept.
 */
export async function runUploadBatch<T>(
  items: readonly T[],
  upload: (item: T) => Promise<unknown>,
  i18n: UploadBatchI18n,
): Promise<UploadBatchResult<T>> {
  if (uploadBatchDelegate) return uploadBatchDelegate(items, upload, i18n);
  const succeeded: T[] = [];
  const failed: { item: T; error: unknown }[] = [];
  for (const item of items) {
    try {
      await upload(item);
      succeeded.push(item);
    } catch (error) {
      failed.push({ item, error });
    }
  }
  return { succeeded, failed };
}

/** Keeps the original batch totals truthful while retries contain only the failed subset. */
export function mergeUploadBatchSummary<T>(
  previous: UploadBatchSummary | null,
  result: UploadBatchResult<T>,
  label: (item: T) => string,
): UploadBatchSummary {
  return {
    succeeded: [...(previous?.succeeded ?? []), ...result.succeeded.map(label)],
    failed: result.failed.map(({ item }) => label(item)),
  };
}

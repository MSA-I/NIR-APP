export interface UploadBatchResult<T> {
  succeeded: T[];
  failed: { item: T; error: unknown }[];
}

export interface UploadBatchSummary {
  succeeded: string[];
  failed: string[];
}

/** Runs every item even after a failure so a retry can contain only the failed subset. */
export async function runUploadBatch<T>(items: readonly T[], upload: (item: T) => Promise<unknown>): Promise<UploadBatchResult<T>> {
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

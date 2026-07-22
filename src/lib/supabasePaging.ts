type PageResponse<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

/** Fetches every PostgREST page. Callers must add a deterministic order with an id tie-breaker. */
export async function fetchAll<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResponse<T>>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const result = await fetchPage(from, from + pageSize - 1);
    if (result.error) throw new Error(result.error.message);
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/** Keeps PostgREST `.in()` URLs bounded while preserving each chunk's fully paged result. */
export async function fetchInChunks<T>(
  ids: readonly string[],
  fetchChunk: (ids: string[]) => Promise<T[]>,
  chunkSize = 150,
): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < ids.length; index += chunkSize) {
    rows.push(...await fetchChunk(ids.slice(index, index + chunkSize)));
  }
  return rows;
}

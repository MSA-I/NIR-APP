/**
 * Reading everything, in bounded requests.
 *
 * **This file and `serverList.ts` are both correct, for different questions.**
 *
 * `fetchAll` answers "give me all of it": a full export (`Reports.tsx`), a check that has to look at
 * every row (`checks.ts`), an aggregate. There the whole set genuinely is the answer, and paging
 * would only be a way of losing part of it.
 *
 * `serverList.ts` answers "give me the page the user is looking at, and how many rows match": one
 * request, `count: 'exact'` for the real total, the `id` tie-breaker, and HTTP 416 turned into a
 * valid page rather than an error. Reach for it on a list screen where the table is large and the
 * user reads fifteen rows.
 *
 * Using `fetchAll` for a list screen downloads the whole table to filter it in memory; using
 * `serverList` for an export returns one page and calls it the export. Neither substitutes for the
 * other, so neither is going away.
 */

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

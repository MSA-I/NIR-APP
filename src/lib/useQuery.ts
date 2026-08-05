import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery as useCachedQuery } from '@tanstack/react-query';
import { toHebrewError } from './errors';
import { createRequestGate } from './requestGate';
import { orgRoot } from './query/keys';
import { useOrgScope } from './query/orgScope';

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  fetching: boolean;
  error: string | null;
  refetch: () => Promise<boolean>;
}

export interface QueryOptions {
  /**
   * Turn off TanStack's structural sharing. It returns the *same reference* when new data is
   * deeply equal, which silently stops `useMemo(..., [data])` from recomputing, and it costs an
   * O(n) deep compare on every fetch. Set this on large lists.
   */
  structuralSharing?: boolean;
}

/**
 * The app's read hook.
 *
 * **Two modes, and the difference is not cosmetic.**
 *
 * Without `key` this is the original per-instance fetch hook, unchanged: no shared cache, no
 * deduplication, no cross-component invalidation. It exists so the ~34 existing call sites keep
 * working untouched while they are converted one at a time.
 *
 * With `key` the call joins the real cache under `['org', <tenant>, ...key]` and gets
 * deduplication, invalidation and retry.
 *
 * **Pass the un-rooted suffix — `[DOMAIN.invoices, 'detail', id]`, not `key(org, ...)`.** The
 * tenant root is prepended here, in exactly one place, so a caller cannot forget it and cannot
 * double it. `key(org, ...)` from `./query/keys` builds the same full key for the cache APIs
 * (`getQueryData`, `invalidateQueries`) where no hook is available to do the rooting.
 *
 * A key cannot be derived for the callers that do not pass one, and the alternatives were
 * rejected on purpose: `useId()` produces a per-component-instance key, which is a cache of one;
 * hashing `fn.toString()` is unsafe, because a closure captures variables that are absent from
 * `deps`, minification collapses distinct bodies, and a collision would serve one tenant's rows
 * to another. So the third argument is additive and explicit. **Do not claim deduplication for a
 * call site that has not been converted.**
 */
export function useQuery<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
  key?: readonly unknown[],
  options: QueryOptions = {},
): QueryState<T> {
  const org = useOrgScope();
  const cached = useCachedQueryMode<T>(fn, key, org, options);
  const legacy = useLegacyQueryMode<T>(fn, deps, key === undefined);
  return key === undefined ? legacy : cached;
}

/**
 * Cached mode.
 *
 * `enabled` is what keeps both hooks callable unconditionally — React requires a stable hook
 * order, so the unused branch runs but does nothing.
 */
function useCachedQueryMode<T>(
  fn: () => Promise<T>,
  key: readonly unknown[] | undefined,
  org: string | null,
  options: QueryOptions,
): QueryState<T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const query = useCachedQuery({
    queryKey: key ? [...orgRoot(org), ...key] : ['__disabled__'],
    queryFn: () => fnRef.current(),
    enabled: key !== undefined,
    structuralSharing: options.structuralSharing,
  });

  const refetch = useCallback(
    () => query.refetch().then((result) => !result.isError),
    [query],
  );

  return {
    data: query.data === undefined ? null : query.data,
    // `isLoading` is `isPending && isFetching` -- "nothing to show yet", which is what drives the
    // skeletons. Deliberately not `isPending`: a cached-but-refetching screen already has data.
    loading: query.isLoading,
    fetching: query.isFetching,
    error: query.error ? toHebrewError(query.error) : null,
    refetch,
  };
}

/** The original implementation, preserved byte-for-byte in behaviour. */
function useLegacyQueryMode<T>(fn: () => Promise<T>, deps: unknown[], active: boolean): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  const activeRef = useRef(active);
  const gateRef = useRef<ReturnType<typeof createRequestGate> | null>(null);
  if (!gateRef.current) gateRef.current = createRequestGate();
  const gate = gateRef.current;
  fnRef.current = fn;
  activeRef.current = active;

  const run = useCallback(async (clearData: boolean) => {
    if (!activeRef.current) return false;
    const request = gate.begin();
    if (clearData) setData(null);
    setFetching(true);
    setError(null);
    try {
      const next = await fnRef.current();
      if (!gate.isCurrent(request)) return false;
      setData(next);
      return true;
    } catch (e) {
      // Every page renders this through ErrorNote, so a raw Postgres string here reaches
      // a Hebrew-speaking user on any screen that fails to load.
      if (gate.isCurrent(request)) setError(toHebrewError(e));
      return false;
    } finally {
      if (gate.isCurrent(request)) setFetching(false);
    }
  }, [gate]);

  const refetch = useCallback(() => run(false), [run]);

  useEffect(() => {
    gate.mount();
    return () => gate.unmount();
  }, [gate]);

  // Dropping data on a deps change is what separates the two states below: a new key
  // (different :id, different month) invalidates what we hold, a manual refetch after a
  // mutation does not. Without this, switching records would show the previous record's
  // data as if it were the new one.
  useEffect(() => {
    void run(true);
    return () => gate.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // `loading` means "nothing to show yet" — it drives the skeletons. `fetching` means
  // "a request is in flight" and stays false-negative-free for refetch-after-mutation,
  // where blanking the page the user is reading is worse than showing nothing new.
  return { data, loading: fetching && data === null, fetching, error, refetch };
}

// returns `any` on purpose: without generated DB types, supabase-js infers awkward
// structural types from select strings; call sites cast to their local row shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrap(res: { data: unknown; error: { message: string } | null }): any {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

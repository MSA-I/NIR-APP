import { useCallback, useEffect, useRef, useState } from 'react';
import { toHebrewError } from './errors';
import { createRequestGate } from './requestGate';

// ponytail: tiny fetch hook instead of react-query — add react-query only if caching/invalidation outgrows this
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  const gateRef = useRef<ReturnType<typeof createRequestGate> | null>(null);
  if (!gateRef.current) gateRef.current = createRequestGate();
  const gate = gateRef.current;
  fnRef.current = fn;

  const run = useCallback(async (clearData: boolean) => {
    const request = gate.begin();
    if (clearData) setData(null);
    setFetching(true);
    setError(null);
    try {
      const next = await fnRef.current();
      if (gate.isCurrent(request)) setData(next);
    } catch (e) {
      // Every page renders this through ErrorNote, so a raw Postgres string here reaches
      // a Hebrew-speaking user on any screen that fails to load.
      if (gate.isCurrent(request)) setError(toHebrewError(e));
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

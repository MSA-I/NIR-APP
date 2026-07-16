import { useCallback, useEffect, useRef, useState } from 'react';

// ponytail: tiny fetch hook instead of react-query — add react-query only if caching/invalidation outgrows this
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fnRef.current());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refetch(); }, deps);

  return { data, loading, error, refetch };
}

// returns `any` on purpose: without generated DB types, supabase-js infers awkward
// structural types from select strings; call sites cast to their local row shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrap(res: { data: unknown; error: { message: string } | null }): any {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

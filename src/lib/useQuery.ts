import { useT } from './i18n/LocaleProvider';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery as useCachedQuery, keepPreviousData as keepPreviousDataFn } from '@tanstack/react-query';
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
  /**
   * Keep the previous key's data on screen while the next key loads, instead of a skeleton.
   *
   * This is the paging contract of ADR-0007: a page change is a new query key, which is
   * `isPending` in TanStack v5 and would blank the table the user is reading. Mapped to
   * `placeholderData: keepPreviousData`; while the previous data is shown, `loading` stays
   * `false` and `fetching` is `true`. The very first fetch (nothing to show yet) still reports
   * `loading: true` and drives the skeleton. Opt-in only — a consumer that does not pass it
   * keeps the exact current semantics.
   */
  keepPreviousData?: boolean;
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
  /**
   * THE READING LANGUAGE IS PART OF A READ (31.08.2026).
   *
   * A query function is allowed to resolve translated text, and several do — `Dashboard.tsx:850-854`
   * builds the whole attention strip as `{ label: t('dashboard.text_20'), … }` inside the fetch. So
   * a cached result is a result *in a language*, and a locale change without this line leaves the
   * old language on screen until something else happens to refetch.
   *
   * How it was found, because the symptom is nastier than the cause: switching to Hebrew on
   * /dashboard turned the page Hebrew and left six attention rows in English. Reloading fixed them.
   * That is the signature of text baked into cached data, and it was reachable before today (the
   * `<select>` on /settings), just rarely — the language row in the account menu makes it one click
   * from any screen, so it became this package's problem to fix rather than to inherit.
   *
   * IT REFETCHES WITHOUT BLANKING, which is the second half of getting this right. The first
   * version appended the locale to `deps`, and the deps effect calls `run(true)` — the branch that
   * sets `data` to `null` before fetching, because a new record id must not show the previous
   * record's rows. A language is not a new record: nothing on screen became wrong, only its
   * wording. Sending it down that path made every un-keyed screen collapse to a skeleton on a
   * language change, and again immediately after sign-in whenever the saved locale differed from
   * browser detection. The locale now drives its own effect through `run(false)` — the same path
   * `refetch` uses after a mutation — so the words change under the reader instead of the page
   * emptying and refilling.
   *
   * LEGACY MODE ONLY, and the boundary is deliberate. Every observed instance of the bug is in a
   * call site with no `key` — the un-keyed mode re-runs on `deps`, so appending the locale there
   * fixes them at the hook instead of once per screen. The CACHED mode was left alone: appending
   * the locale to its query key would have made `key(org, DOMAIN.x)` from `./query/keys` stop
   * describing a whole cache entry, which is a contract `src/lib/query/useQuery.spec.tsx` asserts
   * on purpose (ADR-0007) — and it would have bought protection against a pattern that no keyed
   * call site was measured to have. **If a KEYED query ever resolves `t()` inside its own fetch, it
   * must put the locale in its own key.** That is the rule this comment exists to hand forward.
   *
   * The cost is one refetch per language change, which is a deliberate and rare act.
   */
  const { locale } = useT();
  const cached = useCachedQueryMode<T>(fn, key, org, options);
  const legacy = useLegacyQueryMode<T>(fn, deps, key === undefined, locale);
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
  const { errorText } = useT();
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const query = useCachedQuery({
    queryKey: key ? [...orgRoot(org), ...key] : ['__disabled__'],
    queryFn: () => fnRef.current(),
    enabled: key !== undefined,
    structuralSharing: options.structuralSharing,
    placeholderData: options.keepPreviousData ? keepPreviousDataFn : undefined,
  });

  const refetch = useCallback(
    () => query.refetch().then((result) => !result.isError),
    [query],
  );

  return {
    data: query.data === undefined ? null : query.data,
    // `isLoading` is `isPending && isFetching` -- "nothing to show yet", which is what drives the
    // skeletons. Deliberately not `isPending`: a cached-but-refetching screen already has data.
    // The `data === undefined` guard is for `keepPreviousData`: a new key is `isPending` even
    // while the previous key's rows are shown as placeholder, and a skeleton over rows the user
    // is reading is exactly what that option exists to prevent. Without a placeholder, pending
    // implies undefined data, so untouched consumers get an identical value either way.
    loading: query.isLoading && query.data === undefined,
    fetching: query.isFetching,
    error: query.error ? errorText(query.error) : null,
    refetch,
  };
}

/** The original implementation, preserved byte-for-byte in behaviour. */
function useLegacyQueryMode<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  active: boolean,
  locale: string,
): QueryState<T> {
  const { errorText } = useT();
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
      if (gate.isCurrent(request)) setError(errorText(e));
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

  /**
   * A language change refetches WITHOUT dropping what is on screen.
   *
   * `run(false)` and not `run(true)`: the rows are still the right rows, only their wording is
   * stale, so blanking the page would be a downgrade the reader can see. Skipped on mount — the
   * deps effect below is already fetching then, and firing both would double every first load.
   */
  const localeAtMount = useRef(locale);
  useEffect(() => {
    if (localeAtMount.current === locale) return;
    localeAtMount.current = locale;
    void run(false);
  }, [locale, run]);

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

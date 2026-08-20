import { useCallback } from 'react';
import { useQuery as useTanstackQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import { unwrap } from './useQuery';
import { DOMAIN, key, type OrgScope } from './query/keys';
import { useOrgScope } from './query/orgScope';
import { toHebrewError } from './errors';

/**
 * Feature-flag reads (migration 0059).
 *
 * `resolve_feature_flags()` is the single stable definer that returns the evaluated set for
 * `(uid, org, scopes)`. The flag law (SECURITY-MODEL §8) holds on both sides of the wire: a flag
 * can only turn a capability off, never grant one — so every lookup here is fail-closed. A flag
 * that is unknown, still loading, or failed to load reads as **off**.
 *
 * No consumer is wired this wave (the SSO UI is a later wave); the hook + spec ship ready.
 */

/** Five minutes: flags change by operator action, not by user activity. */
export const FLAGS_STALE_TIME_MS = 5 * 60_000;

/**
 * Full cache key for the cache APIs (`getQueryData`, `invalidateQueries`). Rooted at the tenant
 * like every other key, so `invalidateOrg`/`clearOrg` cover flags with no extra wiring and an
 * org switch can never serve one tenant's flag set to another.
 */
export const flagsKey = (org: OrgScope) => key(org, DOMAIN.organization, 'flags');

export interface FeatureFlagsState {
  /** The resolved set, or `null` before the first successful load. */
  flags: ReadonlyMap<string, boolean> | null;
  /** Fail-closed lookup: unknown / unloaded / errored flags are off. */
  isEnabled: (flagKey: string) => boolean;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<boolean>;
}

function toEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  // Tolerated non-contract spellings; anything unrecognised is off.
  if (typeof value === 'string') return value === 'on' || value === 'enabled' || value === 'true';
  return false;
}

/**
 * Normalises the RPC result. The contract (ENTERPRISE-SECURITY-MODEL §8) is
 * `returns table (flag_key text, state boolean)`; `{ key }` / `{ enabled }` spellings and a plain
 * `{ [key]: value }` object are tolerated defensively. Unrecognised rows are dropped, which reads
 * as "off" — the fail-closed direction.
 */
function normalizeResolvedFlags(data: unknown): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  if (Array.isArray(data)) {
    for (const row of data) {
      if (!row || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const flagKey = record.flag_key ?? record.key;
      if (typeof flagKey !== 'string' || !flagKey) continue;
      flags.set(flagKey, toEnabled('state' in record ? record.state : record.enabled));
    }
  } else if (data && typeof data === 'object') {
    for (const [flagKey, value] of Object.entries(data)) flags.set(flagKey, toEnabled(value));
  }
  return flags;
}

/**
 * TanStack is used directly (not through `src/lib/useQuery.ts`) for one reason only: the app
 * wrapper deliberately exposes no `staleTime`, and it is frozen this wave. The key still follows
 * the migration 0059 contract to the letter — rooted at the tenant via `flagsKey`, built from
 * `DOMAIN`, invalidated by the same `invalidateOrg`/`clearOrg` as everything else.
 */
export function useFeatureFlags(): FeatureFlagsState {
  const org = useOrgScope();
  const query = useTanstackQuery({
    queryKey: flagsKey(org),
    queryFn: async () => normalizeResolvedFlags(unwrap(await supabase.rpc('resolve_feature_flags'))),
    staleTime: FLAGS_STALE_TIME_MS,
  });

  // TanStack deliberately retains the last successful `data` when a background refetch fails.
  // That is useful for ordinary reads, but a capability cache is a deny-by-default boundary:
  // once freshness was explicitly checked and failed, the old grant is no longer renderable.
  // A later successful fetch clears `query.error` and makes its newly resolved set visible again.
  const flags = query.error ? null : query.data ?? null;
  const isEnabled = useCallback((flagKey: string) => flags?.get(flagKey) ?? false, [flags]);
  const refetch = useCallback(
    () => query.refetch().then((result) => !result.isError),
    [query],
  );

  return {
    flags,
    isEnabled,
    loading: query.isLoading,
    error: query.error ? toHebrewError(query.error) : null,
    refetch,
  };
}

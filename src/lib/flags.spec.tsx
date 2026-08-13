import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient, clearOrg } from './query/client';
import { OrgScopeProvider } from './query/orgScope';

/** Real supabase-js against the MSW base URL — the wire behaviour stays real. */
vi.mock('./supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

import { useFeatureFlags, flagsKey, FLAGS_STALE_TIME_MS } from './flags';

const wrap = (org: string | null, client: QueryClient = createAppQueryClient()) => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <OrgScopeProvider org={org}>{children}</OrgScopeProvider>
    </QueryClientProvider>
  );
  return { Wrapper, client };
};

/** Registers the RPC handler and returns a live call counter. */
function useResolveFlags(body: unknown, status = 200) {
  const counter = { calls: 0 };
  server.use(
    http.post(`${SUPABASE_URL}/rest/v1/rpc/resolve_feature_flags`, () => {
      counter.calls += 1;
      return HttpResponse.json(body as JsonBodyType, { status });
    }),
  );
  return counter;
}

describe('useFeatureFlags', () => {
  it('resolves the set and answers lookups fail-closed', async () => {
    // The contract shape, migration 0059: `returns table (flag_key text, state boolean)`.
    useResolveFlags([
      { flag_key: 'sso.enabled', state: true },
      { flag_key: 'receiving.barcode', state: false },
    ]);
    const { Wrapper } = wrap('org-1');
    const { result } = renderHook(() => useFeatureFlags(), { wrapper: Wrapper });

    // Before the first resolution everything is off — a flag can only disable, never grant.
    expect(result.current.isEnabled('sso.enabled')).toBe(false);
    expect(result.current.flags).toBeNull();

    await waitFor(() => expect(result.current.isEnabled('sso.enabled')).toBe(true));
    expect(result.current.isEnabled('receiving.barcode')).toBe(false);
    // Unknown flags are off, not undefined-ish.
    expect(result.current.isEnabled('no.such.flag')).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('tolerates non-contract spellings defensively', async () => {
    useResolveFlags([
      { key: 'sso.enabled', state: 'on' },
      { flag_key: 'receiving.barcode', enabled: true },
    ]);
    const { Wrapper } = wrap('org-1');
    const { result } = renderHook(() => useFeatureFlags(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isEnabled('sso.enabled')).toBe(true));
    expect(result.current.isEnabled('receiving.barcode')).toBe(true);
  });

  it('tolerates a plain object map', async () => {
    useResolveFlags({ 'sso.enabled': true, 'receiving.barcode': 'off' });
    const { Wrapper } = wrap('org-1');
    const { result } = renderHook(() => useFeatureFlags(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isEnabled('sso.enabled')).toBe(true));
    expect(result.current.isEnabled('receiving.barcode')).toBe(false);
  });

  it('caches under the org root and deduplicates consumers', async () => {
    const counter = useResolveFlags([{ flag_key: 'sso.enabled', state: true }]);
    const { Wrapper, client } = wrap('org-1');
    const a = renderHook(() => useFeatureFlags(), { wrapper: Wrapper });
    const b = renderHook(() => useFeatureFlags(), { wrapper: Wrapper });
    await waitFor(() => expect(a.result.current.isEnabled('sso.enabled')).toBe(true));
    await waitFor(() => expect(b.result.current.isEnabled('sso.enabled')).toBe(true));

    // One request, two consumers — and the entry lives under ['org', <tenant>, ...].
    expect(counter.calls).toBe(1);
    expect(client.getQueryData(flagsKey('org-1'))).toBeInstanceOf(Map);
    expect(flagsKey('org-1')).toEqual(['org', 'org-1', 'organization', 'flags']);
  });

  it('refetches for a different tenant and clears with the org subtree', async () => {
    const counter = useResolveFlags([{ flag_key: 'sso.enabled', state: true }]);
    const client = createAppQueryClient();
    const first = renderHook(() => useFeatureFlags(), { wrapper: wrap('org-1', client).Wrapper });
    await waitFor(() => expect(first.result.current.isEnabled('sso.enabled')).toBe(true));

    const second = renderHook(() => useFeatureFlags(), { wrapper: wrap('org-2', client).Wrapper });
    await waitFor(() => expect(second.result.current.isEnabled('sso.enabled')).toBe(true));
    // A different tenant is a different key, never a cache hit.
    expect(counter.calls).toBe(2);

    // An org switch drops the old tenant's flags with the rest of its subtree — no extra wiring.
    act(() => clearOrg(client, 'org-1'));
    expect(client.getQueryData(flagsKey('org-1'))).toBeUndefined();
    expect(client.getQueryData(flagsKey('org-2'))).toBeInstanceOf(Map);
  });

  it('holds flags far longer than the default staleTime', () => {
    // Not a behavioural probe (fake timers and TanStack do not mix well here) — the constant is
    // the contract: five minutes, an operator action, not user activity.
    expect(FLAGS_STALE_TIME_MS).toBe(5 * 60_000);
  });

  it('reports a Hebrew error, never the raw server string', async () => {
    useResolveFlags({ message: 'fresh_authentication_required', code: '42501' }, 401);
    // retry:false so the failure surfaces immediately instead of after the read-retry backoff.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { Wrapper } = wrap('org-1', client);
    const { result } = renderHook(() => useFeatureFlags(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).not.toContain('fresh_authentication_required');
    expect(result.current.error).toMatch(/[֐-׿]/);
    // Errored = everything off.
    expect(result.current.isEnabled('sso.enabled')).toBe(false);
  });
});

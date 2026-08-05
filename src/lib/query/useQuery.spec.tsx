import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createAppQueryClient, clearOrg, invalidateOrg } from './client';
import { key, orgRoot, DOMAIN } from './keys';
import { OrgScopeProvider } from './orgScope';
import { useQuery } from '../useQuery';

const wrap = (org: string | null, client = createAppQueryClient()) => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <OrgScopeProvider org={org}>{children}</OrgScopeProvider>
    </QueryClientProvider>
  );
  return { Wrapper, client };
};

describe('query keys', () => {
  it('roots every key at the tenant', () => {
    expect(key('org-1', DOMAIN.suppliers)).toEqual(['org', 'org-1', 'suppliers']);
    expect(key('org-1', DOMAIN.invoices, 'detail', 'inv-9'))
      .toEqual(['org', 'org-1', 'invoices', 'detail', 'inv-9']);
  });

  it('treats a null tenant as its own root, not as a missing value', () => {
    // auth_org() returns null for a suspended organisation. Those results must never share a
    // cache entry with a live tenant's.
    expect(orgRoot(null)).not.toEqual(orgRoot('org-1'));
    expect(key(null, DOMAIN.invoices)).toEqual(['org', null, 'invoices']);
  });
});

describe('useQuery — cached mode (explicit key)', () => {
  it('deduplicates two components asking for the same key', async () => {
    const fn = vi.fn().mockResolvedValue(['a']);
    const { Wrapper } = wrap('org-1');
    const a = renderHook(() => useQuery(fn, [], [DOMAIN.suppliers]), { wrapper: Wrapper });
    const b = renderHook(() => useQuery(fn, [], [DOMAIN.suppliers]), { wrapper: Wrapper });
    await waitFor(() => expect(a.result.current.data).toEqual(['a']));
    await waitFor(() => expect(b.result.current.data).toEqual(['a']));
    // The whole point of wave 1: one request, two consumers.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps one tenant out of another tenant cache entry', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce(['tenant-1 row'])
      .mockResolvedValueOnce(['tenant-2 row']);
    const client = createAppQueryClient();
    const first = renderHook(() => useQuery(fn, [], [DOMAIN.invoices]), {
      wrapper: wrap('org-1', client).Wrapper,
    });
    await waitFor(() => expect(first.result.current.data).toEqual(['tenant-1 row']));

    const second = renderHook(() => useQuery(fn, [], [DOMAIN.invoices]), {
      wrapper: wrap('org-2', client).Wrapper,
    });
    await waitFor(() => expect(second.result.current.data).toEqual(['tenant-2 row']));
    // Two fetches, not one: a different tenant is a different key, never a cache hit.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('drops a tenant subtree on clearOrg', async () => {
    const fn = vi.fn().mockResolvedValue(['x']);
    const { Wrapper, client } = wrap('org-1');
    const { result } = renderHook(() => useQuery(fn, [], [DOMAIN.products]), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual(['x']));
    expect(client.getQueryData(key('org-1', DOMAIN.products))).toEqual(['x']);

    act(() => clearOrg(client, 'org-1'));
    // Removed, not invalidated: on sign-out the rows must leave memory rather than refetch.
    expect(client.getQueryData(key('org-1', DOMAIN.products))).toBeUndefined();
  });

  it('refetches after invalidation', async () => {
    const fn = vi.fn().mockResolvedValueOnce(['v1']).mockResolvedValueOnce(['v2']);
    const { Wrapper, client } = wrap('org-1');
    const { result } = renderHook(() => useQuery(fn, [], [DOMAIN.priceLists]), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual(['v1']));

    await act(async () => { await invalidateOrg(client, 'org-1'); });
    await waitFor(() => expect(result.current.data).toEqual(['v2']));
  });

  it('renders a Hebrew error, never the raw server string', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('new row violates row-level security policy'));
    const { Wrapper } = wrap('org-1');
    const { result } = renderHook(
      () => useQuery(fn, [], [DOMAIN.documents]),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.error).toBeTruthy(), { timeout: 5000 });
    expect(result.current.error).not.toContain('row-level security');
    expect(result.current.error).toMatch(/[֐-׿]/);
  });

  it('keeps loading and fetching distinct so a refetch never blanks the screen', async () => {
    const fn = vi.fn().mockResolvedValue(['row']);
    const { Wrapper } = wrap('org-1');
    const { result } = renderHook(() => useQuery(fn, [], [DOMAIN.purchaseOrders]), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual(['row']));

    expect(result.current.loading).toBe(false);
    void act(() => { void result.current.refetch(); });
    // Data stays on screen while the request is in flight; only `fetching` moves.
    expect(result.current.data).toEqual(['row']);
    expect(result.current.loading).toBe(false);
  });
});

describe('useQuery — keepPreviousData (PLAN-02 §2.3)', () => {
  const pageFetcher = () => {
    const resolvers: Array<(rows: string[]) => void> = [];
    const fn = vi.fn(() => new Promise<string[]>((resolve) => { resolvers.push(resolve); }));
    return { fn, resolve: (i: number, rows: string[]) => resolvers[i](rows) };
  };

  it('first page shows the skeleton; a page change shows the old rows and only `fetching`', async () => {
    const { fn, resolve } = pageFetcher();
    const { Wrapper } = wrap('org-1');
    const { result, rerender } = renderHook(
      ({ page }: { page: number }) => useQuery(
        () => fn(),
        [],
        [DOMAIN.invoices, 'list', { page }],
        { keepPreviousData: true },
      ),
      { wrapper: Wrapper, initialProps: { page: 0 } },
    );

    // First fetch: nothing to show yet — this is the one skeleton the screen renders.
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    await act(async () => { resolve(0, ['page-0 row']); });
    await waitFor(() => expect(result.current.data).toEqual(['page-0 row']));
    expect(result.current.loading).toBe(false);

    // Page change = new key. The previous page stays on screen; only `fetching` moves.
    rerender({ page: 1 });
    expect(result.current.data).toEqual(['page-0 row']);
    expect(result.current.loading).toBe(false);
    expect(result.current.fetching).toBe(true);

    await act(async () => { resolve(1, ['page-1 row']); });
    await waitFor(() => expect(result.current.data).toEqual(['page-1 row']));
    expect(result.current.fetching).toBe(false);
  });

  it('does not change the semantics of a consumer that did not opt in', async () => {
    const { fn, resolve } = pageFetcher();
    const { Wrapper } = wrap('org-1');
    const { result, rerender } = renderHook(
      ({ page }: { page: number }) => useQuery(() => fn(), [], [DOMAIN.invoices, 'list', { page }]),
      { wrapper: Wrapper, initialProps: { page: 0 } },
    );
    await act(async () => { resolve(0, ['page-0 row']); });
    await waitFor(() => expect(result.current.data).toEqual(['page-0 row']));

    // Without the flag a new key has nothing to show: loading drives the skeleton again.
    rerender({ page: 1 });
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.data).toBeNull();
    await act(async () => { resolve(1, ['page-1 row']); });
    await waitFor(() => expect(result.current.data).toEqual(['page-1 row']));
  });
});

describe('useQuery — compatibility mode (no key)', () => {
  it('does not share a cache: two consumers fetch twice', async () => {
    const fn = vi.fn().mockResolvedValue(['a']);
    const { Wrapper } = wrap('org-1');
    const a = renderHook(() => useQuery(fn, []), { wrapper: Wrapper });
    const b = renderHook(() => useQuery(fn, []), { wrapper: Wrapper });
    await waitFor(() => expect(a.result.current.data).toEqual(['a']));
    await waitFor(() => expect(b.result.current.data).toEqual(['a']));
    // This is the honest contract of wave 1: without an explicit key there is no deduplication.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clears data on a deps change but not on a manual refetch', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce(['first'])
      .mockResolvedValueOnce(['second'])
      .mockResolvedValueOnce(['third']);
    const { Wrapper } = wrap('org-1');
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useQuery(() => fn(id), [id]),
      { wrapper: Wrapper, initialProps: { id: 'a' } },
    );
    await waitFor(() => expect(result.current.data).toEqual(['first']));

    // A different record must never show the previous record's rows.
    rerender({ id: 'b' });
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data).toEqual(['second']));

    // A refetch after a mutation keeps what the user is reading on screen.
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.data).toEqual(['third']));
  });

  it('reports a Hebrew error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('duplicate key value violates unique constraint'));
    const { Wrapper } = wrap('org-1');
    const { result } = renderHook(() => useQuery(fn, []), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).not.toContain('duplicate key');
    expect(result.current.error).toMatch(/[֐-׿]/);
  });
});

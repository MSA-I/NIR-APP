import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';

/** Real supabase-js against the MSW base URL — the wire behaviour stays real. */
vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

const authState = vi.hoisted(() => ({ role: 'owner' as string }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', role: authState.role, org_id: 'org-test', full_name: 'בודק' },
    org: { id: 'org-test', settings: {} },
    session: {},
    roleLabels: {},
  }),
}));

import GlobalSearch, { canGlobalSearch } from './GlobalSearch';

/** One hit per searchable type, deliberately returned OUT of display order. */
const HITS = [
  { entity: 'credit', id: 'cr-1', title: '#41', subtitle: 'מאפה זהב', status: 'open', amount: 90, occurred_at: '2026-05-04', rank: 1 },
  { entity: 'payment', id: 'pm-1', title: '#7', subtitle: 'מאפה זהב', status: null, amount: 120, occurred_at: '2026-05-03', rank: 1 },
  { entity: 'supplier', id: 'sup-1', title: 'מאפה זהב', subtitle: 'אורי גולן', status: 'active', amount: null, occurred_at: null, rank: 1 },
  { entity: 'order', id: 'po-1', title: '#12', subtitle: 'מאפה זהב', status: 'sent', amount: null, occurred_at: '2026-05-02', rank: 2 },
  { entity: 'product', id: 'prod-1', title: 'לחמניה', subtitle: 'מאפים', status: 'active', amount: null, occurred_at: null, rank: 2 },
  { entity: 'invoice', id: 'inv-1', title: '7702', subtitle: 'מאפה זהב', status: 'unpaid', amount: 340, occurred_at: '2026-05-01', rank: 2 },
];

function useGlobalSearch(rows: unknown[] = HITS) {
  const calls: Array<Record<string, unknown>> = [];
  server.use(
    http.post(`${SUPABASE_URL}/rest/v1/rpc/global_search`, async ({ request }) => {
      calls.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(rows as never);
    }),
  );
  return calls;
}

function renderSearch() {
  return render(<MemoryRouter><GlobalSearch /></MemoryRouter>);
}

const groupNames = () => screen.getAllByRole('group').map((node) => node.getAttribute('aria-label'));

beforeEach(() => { authState.role = 'owner'; });

describe('GlobalSearch — ALLOWED is display order, not the gate (PLAN-10 §3, migration 0069)', () => {
  it('renders every type an owner can reach, in the map order and not the wire order', async () => {
    const user = userEvent.setup();
    const calls = useGlobalSearch();
    renderSearch();

    await user.type(screen.getByRole('combobox', { name: 'חיפוש כללי' }), 'מאפ');
    await waitFor(() => expect(calls).toHaveLength(1), { timeout: 3_000 });
    expect(calls[0]).toEqual({ q: 'מאפ', per_type: 5 });

    // The map's job now: the group set and their order. The server answered scrambled.
    await waitFor(() => expect(groupNames()).toEqual(
      ['ספקים', 'מוצרים', 'חשבוניות', 'הזמנות', 'תשלומים', 'זיכויים'],
    ));
    expect(screen.getAllByRole('option')).toHaveLength(HITS.length);
  });

  it('keeps the client filter as defence in depth for a role the server would now already stop', async () => {
    authState.role = 'accountant';
    const user = userEvent.setup();
    useGlobalSearch();
    renderSearch();

    await user.type(screen.getByRole('combobox', { name: 'חיפוש כללי' }), 'מאפ');
    // The MSW server deliberately leaks all six types, which the real 0069 would not do for an
    // accountant. The retained filter still drops the three unreachable ones — it is no longer what
    // makes the gate true, but it has not been removed either.
    await waitFor(() => expect(groupNames()).toEqual(['חשבוניות', 'תשלומים', 'זיכויים']));
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('still refuses a search box to the roles 0069 answers with an empty set', () => {
    expect(canGlobalSearch('payer')).toBe(false);
    expect(canGlobalSearch('supplier')).toBe(false);
    expect(canGlobalSearch('owner')).toBe(true);
    expect(canGlobalSearch('office')).toBe(true);
    expect(canGlobalSearch('kitchen')).toBe(true);
    expect(canGlobalSearch('accountant')).toBe(true);
    expect(canGlobalSearch(undefined)).toBe(false);
  });

  it('reports a failed search in Hebrew instead of an empty result set', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/rpc/global_search`, () => HttpResponse.json(
        { message: 'permission denied for function global_search', code: '42501', details: null, hint: null },
        { status: 403 },
      )),
    );
    renderSearch();

    await user.type(screen.getByRole('combobox', { name: 'חיפוש כללי' }), 'מאפ');
    expect(await screen.findByRole('alert')).toHaveTextContent('החיפוש נכשל — נסה שוב');
    expect(screen.queryByRole('option')).toBeNull();
  });
});

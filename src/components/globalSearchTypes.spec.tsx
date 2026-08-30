import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

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
  { entity: 'draft', id: 'req-1', title: '#88', subtitle: 'טיוטת הזמנה · להשלים מחר', status: 'draft', amount: null, occurred_at: '2026-05-05', rank: 1 },
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

function renderSearch(locale: 'he' | 'en' = 'he') {
  return render(<LocaleProvider initialLocale={locale}><MemoryRouter><GlobalSearch /></MemoryRouter></LocaleProvider>);
}

/** Where did useNavigate land — MemoryRouter keeps the URL out of jsdom, so read the router. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="probe-location">{location.pathname + location.search}</div>;
}

const groupNames = () => screen.getAllByRole('group').map((node) => node.getAttribute('aria-label'));

beforeEach(() => {
  authState.role = 'owner';
  // jsdom has no scrollIntoView; hovering an option calls it to keep the active row visible.
  Element.prototype.scrollIntoView = () => {};
});

describe('GlobalSearch — ALLOWED is display order, not the gate (migration 0069)', () => {
  it('renders group copy in English while preserving result data from the server', async () => {
    const user = userEvent.setup();
    useGlobalSearch();
    renderSearch('en');

    await user.type(screen.getByRole('combobox', { name: 'Global search' }), 'bak');
    await waitFor(() => expect(groupNames()).toEqual(
      ['Suppliers', 'Products', 'Invoices', 'Orders', 'Order drafts', 'Payments', 'Credits'],
    ));
    expect(screen.getByRole('option', { name: /מאפה זהב אורי גולן/ })).toBeInTheDocument();
    expect(screen.getByText('7 results found')).toBeInTheDocument();
  });

  it('renders every type an owner can reach, in the map order and not the wire order', async () => {
    const user = userEvent.setup();
    const calls = useGlobalSearch();
    renderSearch();

    await user.type(screen.getByRole('combobox', { name: 'חיפוש כללי' }), 'מאפ');
    await waitFor(() => expect(calls).toHaveLength(1), { timeout: 3_000 });
    expect(calls[0]).toEqual({ q: 'מאפ', per_type: 5 });

    // The map's job now: the group set and their order. The server answered scrambled.
    await waitFor(() => expect(groupNames()).toEqual(
      ['ספקים', 'מוצרים', 'חשבוניות', 'הזמנות', 'טיוטות הזמנה', 'תשלומים', 'זיכויים'],
    ));
    expect(screen.getAllByRole('option')).toHaveLength(HITS.length);
  });

  it('routes a draft hit to the resume screen, not to an order page', async () => {
    const user = userEvent.setup();
    useGlobalSearch();
    render(<MemoryRouter><GlobalSearch /><LocationProbe /></MemoryRouter>);

    await user.type(screen.getByRole('combobox', { name: 'חיפוש כללי' }), 'טיוט');
    const draftOption = await screen.findByRole('option', { name: /טיוטת הזמנה/ });
    await user.click(draftOption);
    // The draft resumes only through NewOrder's ?draft= loader — 0145's contract.
    await waitFor(() => expect(screen.getByTestId('probe-location')).toHaveTextContent('/orders/new?draft=req-1'));
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

  it('refuses a search box to every retired role', () => {
    expect(canGlobalSearch('payer')).toBe(false);
    expect(canGlobalSearch('supplier')).toBe(false);
    expect(canGlobalSearch('kitchen')).toBe(false);
    expect(canGlobalSearch('owner')).toBe(true);
    expect(canGlobalSearch('office')).toBe(true);
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

  it('resolves a failed-search code in English', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/rpc/global_search`, () => HttpResponse.json(
        { message: 'permission denied for function global_search', code: '42501', details: null, hint: null },
        { status: 403 },
      )),
    );
    renderSearch('en');

    await user.type(screen.getByRole('combobox', { name: 'Global search' }), 'bak');
    expect(await screen.findByRole('alert')).toHaveTextContent('Search failed — try again');
    expect(screen.queryByRole('option')).toBeNull();
  });
});

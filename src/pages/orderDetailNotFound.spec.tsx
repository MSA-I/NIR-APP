/**
 * PROC-06 — an order id with no record behind it.
 *
 * A stale WhatsApp link, a cancelled order, a half-copied address: `/orders/<uuid>` where the
 * uuid names nothing is an ordinary thing for a person to reach, and it is not a fault. The
 * screen answered it with a red strip reading "הפעולה נכשלה. אם הבעיה חוזרת — פנה לתמיכה." and
 * nothing else — no "order not found", no way back to the list. The cause is one call: the read
 * used `.single()`, PostgREST answers 406 over zero rows, `unwrap` throws that into `error`, and
 * `error` wins over the screen's own `orders.text_14` ("הזמנה לא נמצאה"), which was already
 * written and unreachable.
 *
 * THE SERVER IS MODELLED, NOT THE CLIENT'S CALL SHAPE. The handler below answers exactly as
 * PostgREST does: 406 with PGRST116 to a request that demands a single object, an empty list to
 * one that does not. So the test does not care whether the fix is `maybeSingle()`, an error
 * classifier, or something else — only that the person is told the record does not exist and is
 * given the way back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { he } from '../lib/i18n/dictionaries/he';

vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'office-1', role: 'office', full_name: 'בודקת', org_id: 'org-1' },
    org: { id: 'org-1', name: 'ארגון בדיקה', settings: {}, base_currency: 'ILS', logo_path: null },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import { OrderDetail } from './Orders';

const MISSING = '00000000-0000-0000-0000-000000000000';

/** PostgREST's own two answers for a filter that matches nothing. */
const purchaseOrders = () =>
  http.get(`${SUPABASE_URL}/rest/v1/purchase_orders`, ({ request }) => {
    const accept = request.headers.get('Accept') ?? '';
    if (accept.includes('pgrst.object')) {
      return HttpResponse.json({
        code: 'PGRST116',
        details: 'The result contains 0 rows',
        hint: null,
        message: 'JSON object requested, multiple (or no) rows returned',
      }, { status: 406 });
    }
    return HttpResponse.json([]);
  });

function renderDetail() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter initialEntries={[`/orders/${MISSING}`]}>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(
    <Routes>
      <Route path="/orders/:id" element={<OrderDetail />} />
    </Routes>,
    { wrapper: Wrapper },
  );
}

describe('PROC-06 — /orders/:id with no record behind it', () => {
  beforeEach(() => {
    server.use(purchaseOrders());
  });

  it('says the order does not exist instead of sending the person to support', async () => {
    renderDetail();
    expect(await screen.findByText(he.orders.text_14)).toBeInTheDocument();
    expect(screen.queryByText(he.errors.fallback)).toBeNull();
  });

  it('offers the way back to the orders list', async () => {
    renderDetail();
    await screen.findByText(he.orders.text_14);
    const back = screen.getAllByRole('link').find((link) => link.getAttribute('href') === '/orders');
    expect(back, 'a link back to /orders').toBeDefined();
    expect(back?.textContent?.trim()).toBeTruthy();
  });
});

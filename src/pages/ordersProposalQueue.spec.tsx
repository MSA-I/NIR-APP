/**
 * REQ-04 — a supplier's counter-offer waiting for a decision is announced nowhere.
 *
 * A supplier answers an order through the portal (`0167`). The proposal lands in
 * `supplier_order_proposals` with status `submitted`, the money delta is already computed, and
 * `/orders/proposals/:proposalId` is a working screen whose whole job is "accept or reject it".
 * The only door to that screen is the portal card on the order's OWN detail page — so the person
 * who has to decide learns about the decision by opening the one order out of 272 that happens to
 * carry it. `supplier_order_proposals` is named by no alert builder, no exception type and no
 * dashboard metric, and no migration ever writes a `notifications` row for a proposal.
 *
 * THE ORACLE IS THE ONE THE SWEEP WROTE: "the manager must learn within seconds that one is
 * waiting — a row on the orders list, a queue entry, or an alert." This measures the orders list,
 * because that is the screen a person working orders already has open, and because it costs no
 * new capability: the same table, read under the same RLS, narrowed to `status = submitted`.
 *
 * WHAT IS DELIBERATELY NOT MEASURED HERE. The order's own detail screen still prints a next
 * action ("open in WhatsApp and confirm sending") beside a reply that has already arrived. That
 * is a contradiction and it is real — but it is on the screen that ALREADY announces the
 * proposal, so it is not this finding's discoverability defect, and correcting it means lifting
 * the portal card's own fetch into `OrderDetail`. It is recorded in the ledger instead of being
 * folded into a list fix.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { rest } from '../test/msw/handlers';
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

import { OrdersList } from './Orders';

const WAITING_ORDER = 'c0000000-0000-4000-8000-000000000274';
const QUIET_ORDER = 'c0000000-0000-4000-8000-000000000100';
const PROPOSAL = 'd0000000-0000-4000-8000-0000000000a1';

const order = (id: string, number: number) => ({
  id,
  org_id: 'org-1',
  number,
  supplier_id: 'sup-1',
  status: 'ready',
  currency: 'ILS',
  expected_date: '2026-09-10',
  created_at: '2026-09-01T08:00:00Z',
  sent_at: null,
  confirmed_at: null,
  revision_number: 1,
  revised_from_order_id: null,
  notes: null,
  supplier: { name: 'חוות השדה', phone: null, whatsapp: null },
  items: [{ qty: 2, unit_price: 42, product: { name: 'מלפפון', unit: 'ק"ג', sku: null } }],
});

/** The measured state: order #274 carries a `submitted` proposal, order #100 carries none. */
function useOrders(proposals: typeof submitted) {
  server.use(
    rest('purchase_orders', [order(WAITING_ORDER, 274), order(QUIET_ORDER, 100)]),
    rest('purchase_requests', []),
    rest('supplier_order_proposals', proposals),
  );
}

const submitted = [{
  id: PROPOSAL,
  org_id: 'org-1',
  link_id: 'link-1',
  purchase_order_id: WAITING_ORDER,
  supplier_id: 'sup-1',
  status: 'submitted',
  proposed_delivery_date: '2026-09-12',
  supplier_note: null,
  total_delta: 120,
  submitted_at: '2026-09-04T00:24:00Z',
  decided_at: null,
  decided_by: null,
  decision_reason: null,
  delivery_date_accepted: null,
  revision_order_id: null,
  created_at: '2026-09-04T00:24:00Z',
}];

function renderList() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter initialEntries={['/orders?status=all']}>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(<OrdersList />, { wrapper: Wrapper });
}

/** The table row that carries a given order number, as the DOM has it. */
const tableRow = (number: string) =>
  [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(number)) ?? null;

const hrefs = () => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');

describe('REQ-04 — a waiting counter-offer is announced on the orders list', () => {
  beforeEach(() => { server.resetHandlers(); });

  it('offers a way into the decision from the list, not only from that one order', async () => {
    useOrders(submitted);
    renderList();
    await screen.findAllByText('#274');
    expect(hrefs()).toContain(`/orders/proposals/${PROPOSAL}`);
  });

  /**
   * The link is not enough on its own: a door with no sign on it is still a thing the reader has
   * to open to find out what it is. This asserts the announcement NAMES the order and the
   * supplier, and it does so structurally — from the anchor outwards — so it holds whatever
   * heading the section ends up with.
   */
  it('names the order and the supplier the decision is owed on', async () => {
    useOrders(submitted);
    renderList();
    await screen.findAllByText('#274');
    const door = [...document.querySelectorAll('a[href]')]
      .find((a) => a.getAttribute('href') === `/orders/proposals/${PROPOSAL}`);
    const announcement = door?.closest('section');
    expect(announcement?.textContent).toContain('#274');
    expect(announcement?.textContent).toContain('חוות השדה');
  });

  it('marks the waiting order in the list itself', async () => {
    useOrders(submitted);
    renderList();
    await screen.findAllByText('#274');
    expect(tableRow('#274')?.textContent).toContain(he.status.proposal_submitted);
  });

  /**
   * Control, green in BOTH runs: an order with no proposal gains nothing. A marker on every row
   * would announce a decision nobody owes, which is the same defect pointing the other way.
   */
  it('leaves an order with no counter-offer unmarked', async () => {
    useOrders(submitted);
    renderList();
    await screen.findAllByText('#100');
    expect(tableRow('#100')?.textContent).not.toContain(he.status.proposal_submitted);
  });

  /**
   * Control, green in BOTH runs: with no proposal in the tenant the list is exactly what it was —
   * no empty queue, no href, and both orders still listed. This is what makes the red above about
   * the counter-offer rather than about the harness or the routing.
   */
  it('adds nothing at all when no counter-offer is waiting', async () => {
    useOrders([]);
    renderList();
    await screen.findAllByText('#274');
    expect(hrefs().filter((href) => href.startsWith('/orders/proposals/'))).toEqual([]);
    expect(document.body.textContent).not.toContain(he.status.proposal_submitted);
    expect(screen.getAllByText('#100').length).toBeGreaterThan(0);
  });
});

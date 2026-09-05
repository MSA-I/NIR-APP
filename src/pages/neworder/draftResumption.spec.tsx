/**
 * PROC-08 — what "הזמנה חדשה" opens.
 *
 * `/orders/new` with no query adopts the newest saved draft AND its stored `editor_step`. The
 * sweep pressed the navigation link named "הזמנה חדשה" and landed on "טיוטה #75", last edited two
 * days earlier, rendered directly at step 03 with a live "אשר ושלח הזמנות" — one click from
 * creating real supplier orders nobody had just reviewed. Nothing on the screen distinguished it
 * from a new order but a small "טיוטה #75 · נשמר".
 *
 * The two doors are not the same door. `?draft=<id>` is a draft the person NAMED, from the list
 * of drafts on /orders, and resuming it exactly where it was left is the point of it. The bare
 * `/orders/new` named nothing; the draft is a guess the screen made, and a guess must not land on
 * the irreversible step. That is the split asserted here — the named door keeps its behaviour, the
 * unnamed one lands at the beginning and says what it did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../../test/msw/server';
import { SUPABASE_URL } from '../../test/msw/handlers';
import { createAppQueryClient } from '../../lib/query/client';
import { OrgScopeProvider } from '../../lib/query/orgScope';
import { ToastProvider } from '../../components/ui';
import { he } from '../../lib/i18n/dictionaries/he';

vi.mock('../../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'office-1', role: 'office', full_name: 'בודקת', org_id: 'org-1' },
    org: { id: 'org-1', name: 'ארגון בדיקה', settings: {}, base_currency: 'ILS', logo_path: null },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import NewOrder from './NewOrder';

const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT = {
  id: '22222222-2222-4222-8222-222222222222',
  org_id: 'org-1',
  name: 'קמח לבן 1 ק"ג',
  display_name: null,
  unit: 'kg',
  sku: 'FL-1',
  category_id: null,
  active: true,
};

/** A two-day-old draft parked on its confirm step — the exact shape PROC-08 photographed. */
const DRAFT = {
  id: DRAFT_ID,
  number: 75,
  notes: null,
  expected_date: null,
  editor_step: 3,
  updated_at: '2026-09-02T08:00:00Z',
  items: [{
    product_id: PRODUCT.id,
    qty: 2,
    chosen_supplier_id: null,
    pinned_supplier_id: null,
    product: PRODUCT,
  }],
};

const traffic = () => [
  http.get(`${SUPABASE_URL}/rest/v1/products`, () => HttpResponse.json([PRODUCT])),
  http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/categories`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/next_order_items`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/purchase_requests`, () => HttpResponse.json([DRAFT])),
];

function renderNewOrder(entry: string) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(
    <Routes>
      <Route path="/orders/new" element={<NewOrder />} />
    </Routes>,
    { wrapper: Wrapper },
  );
}

/**
 * The step bar renders twice (phone dots + desktop chips), and jsdom applies no CSS, so both are
 * in the tree. Whichever is read, they must agree — `stepperNames.spec.ts` pins that separately.
 */
const currentSteps = () => Array.from(document.querySelectorAll('[aria-current="step"]'))
  .map((el) => el.textContent ?? '');

describe('PROC-08 — a draft nobody named must not open on its confirm step', () => {
  beforeEach(() => {
    server.use(...traffic());
  });

  it('lands on step 01 when the draft was adopted, not chosen', async () => {
    renderNewOrder('/orders/new');
    // The draft IS resumed — the label proves the screen found it, so a green here cannot come
    // from the draft simply having been dropped.
    expect(await screen.findByText('#75')).toBeInTheDocument();
    const current = currentSteps();
    expect(current.length).toBeGreaterThan(0);
    for (const label of current) expect(label).toContain('01');
  });

  it('does not put the irreversible button on screen', async () => {
    renderNewOrder('/orders/new');
    await screen.findByText('#75');
    expect(screen.queryByRole('button', { name: new RegExp(he.summaryStep.confirmOrders) })).toBeNull();
  });

  it('offers the explicit way to start a new order instead', async () => {
    renderNewOrder('/orders/new');
    await screen.findByText('#75');
    const fresh = screen.getAllByRole('link').find((link) => link.getAttribute('href') === '/orders/new?fresh=1');
    expect(fresh, 'a link that starts a fresh order').toBeDefined();
    expect(fresh?.textContent?.trim()).toBeTruthy();
  });

  /**
   * Control — green before this package and after it. A draft the person opened by name from
   * /orders is theirs to resume where they left it.
   */
  it('still resumes a NAMED draft exactly where it was left', async () => {
    renderNewOrder(`/orders/new?draft=${DRAFT_ID}`);
    await screen.findByText('#75');
    const current = currentSteps();
    expect(current.length).toBeGreaterThan(0);
    for (const label of current) expect(label).toContain('03');
  });
});

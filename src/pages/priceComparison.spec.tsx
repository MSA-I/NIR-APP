import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';

/**
 * With ?product= the price-list screen IS the cross-supplier comparison (18.08.2026): cheapest
 * eligible offer first and named, the gap to the runner-up stated, unavailable rows sunk and
 * excluded from the verdict. Without the param the screen behaves exactly as before.
 */
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
    profile: { id: 'user-1', role: 'owner', org_id: 'org-test', full_name: 'בודק' },
    org: { id: 'org-test', settings: {} },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import PriceLists from './PriceLists';

const row = (id: string, supplierName: string, price: number, opts: { available?: boolean; status?: string; productId?: string } = {}) => ({
  id, org_id: 'org-test', supplier_id: `sup-${id}`, product_id: opts.productId ?? 'p1',
  current_price: price, previous_price: null, price_effective_date: '2026-08-01',
  available: opts.available ?? true, supplier_sku: null, min_qty: null, package_size: null,
  updated_at: '2026-08-01',
  supplier: { id: `sup-${id}`, name: supplierName, status: opts.status ?? 'active' },
  product: { id: opts.productId ?? 'p1', name: 'מטליות מיקרופייבר 30*30', unit: 'יח׳' },
});

function wire() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json([
      row('a', 'ספק יקר', 12),
      row('b', 'ספק זול', 10),
      row('c', 'ספק אזל', 8, { available: false }),
      row('d', 'ספק אחר לגמרי', 3, { productId: 'p2' }),
    ])),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_price_submissions`, () => HttpResponse.json([])),
  );
}

function renderAt(path: string) {
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes><Route path="/prices" element={<PriceLists />} /></Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => { wire(); });

describe('PriceLists — ?product= becomes a real comparison', () => {
  it('names the cheapest eligible offer and the gap to the next one', async () => {
    renderAt('/prices?product=p1');

    const card = await screen.findByRole('region', { name: /השוואת מחירים/ });
    expect(within(card).getByText('ספק זול')).toBeInTheDocument();
    expect(within(card).getByText(/הזול ביותר/)).toBeInTheDocument();
    // The out-of-stock ₪8 offer must not win, and the gap is 12−10.
    expect(within(card).getByText(/מהמחיר הבא/)).toBeInTheDocument();
    expect(within(card).getByText(/20\.0%/)).toBeInTheDocument();
  });

  it('sorts offers cheapest-first with unavailable rows last, and badges the winner', async () => {
    renderAt('/prices?product=p1');

    await screen.findByRole('region', { name: /השוואת מחירים/ });
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent ?? '');
    const supplierOrder = ['ספק זול', 'ספק יקר', 'ספק אזל'].map((name) => cells.findIndex((text) => text === name));
    expect(supplierOrder[0]).toBeLessThan(supplierOrder[1]);
    expect(supplierOrder[1]).toBeLessThan(supplierOrder[2]);
    expect(screen.getByText('הזול ביותר', { selector: 'td *, td' })).toBeInTheDocument();
    // Another product's rows stay out of the comparison entirely (the supplier FILTER dropdown
    // still lists every supplier — only the table is scoped).
    expect(cells).not.toContain('ספק אחר לגמרי');
  });

  it('without ?product= there is no comparison card and no delta column', async () => {
    renderAt('/prices');

    expect((await screen.findAllByText('ספק זול')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: /השוואת מחירים/ })).toBeNull();
    expect(screen.queryByText('הפרש מהזול')).toBeNull();
  });
});

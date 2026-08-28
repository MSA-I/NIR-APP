import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';

/**
 * The honesty half of the supplier card (constitution: אפס הוא גם טענה על המציאות).
 * payments_select (0133) and p0_supplier_balance_rows (0137) stop at owner, so for office the
 * server answers empty 200s — and the card used to render those as "תשלומים (0)" and a green
 * ₪0.00, both false measurements. The card now skips the queries it may not read and says —
 * with the reason; the consolidated count line explains invoices 0137 deliberately hides.
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

const authState = vi.hoisted(() => ({ role: 'owner' as string }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', role: authState.role, org_id: 'org-test', full_name: 'בודק' },
    org: { id: 'org-test', settings: {}, base_currency: 'ILS' },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import { SupplierCard } from './Suppliers';
import { fmtMoneyExact } from '../lib/format';

const SUPPLIER = {
  id: 'sup-1', org_id: 'org-test', name: 'אחים כהן', tax_id: null, contact_name: null,
  phone: '02-5891000', whatsapp: null, email: null, address: null, min_order_amount: 1250,
  payment_terms: null, notes: null, status: 'active', delivery_days: [], cutoff_time: null,
  default_currency: 'ILS', country_code: 'IL',
  deleted_at: null, created_at: '2026-07-01', updated_at: '2026-07-27',
  rating: null, rating_updated_at: null, rating_note: null,
};

const METRICS = {
  supplier_id: 'sup-1', otd_samples: 0, on_time_pct: null, avg_lead_days: null,
  open_exceptions: null, exceptions_lifetime: null, open_credits: null,
  open_credits_amount: null, open_credits_currency: null,
  price_changes_window: null, priced_items: null,
};

/** Wire the card's whole Promise.all; returns per-endpoint call ledgers. */
function wireCard({ consolidatedCount = 0 } = {}) {
  const calls = { payments: 0, balances: 0 };
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json(SUPPLIER)),
    http.get(`${SUPABASE_URL}/rest/v1/purchase_orders`, () => HttpResponse.json([
      { id: 'po-1', number: 12, created_at: '2026-08-01', expected_date: null, status: 'sent' },
    ])),
    http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json([])),
    // The supporting_evidence count is a HEAD probe — the total rides the Content-Range header.
    http.head(`${SUPABASE_URL}/rest/v1/invoices`, () => new HttpResponse(null, {
      headers: { 'Content-Range': `0-0/${consolidatedCount}` },
    })),
    http.get(`${SUPABASE_URL}/rest/v1/payments`, () => {
      calls.payments += 1;
      return HttpResponse.json([{ id: 'pay-1', paid_date: '2026-08-02', amount: 150, currency: 'ILS', method: null, reference: null }]);
    }),
    http.get(`${SUPABASE_URL}/rest/v1/credit_requests`, () => HttpResponse.json([])),
    // 0218: one row per supplier AND currency, so a supplier owed in two currencies returns two.
    http.get(`${SUPABASE_URL}/rest/v1/supplier_balances_by_currency`, () => {
      calls.balances += 1;
      return HttpResponse.json([{ supplier_id: 'sup-1', currency: 'ILS', open_balance_in_currency: 150 }]);
    }),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_metrics`, () => HttpResponse.json(METRICS)),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_price_submissions`, () => HttpResponse.json([])),
  );
  return calls;
}

function renderCard() {
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={['/suppliers/sup-1']}>
            <Routes><Route path="/suppliers/:id" element={<SupplierCard />} /></Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => { authState.role = 'owner'; });

describe('SupplierCard — role-honest financial display', () => {
  it('office: no payments/balance request, — instead of fake zeros, and the reason in words', async () => {
    authState.role = 'office';
    const user = userEvent.setup();
    const calls = wireCard();
    renderCard();

    await screen.findByRole('heading', { name: 'אחים כהן' });
    // The gated queries never left the browser.
    expect(calls.payments).toBe(0);
    expect(calls.balances).toBe(0);
    // The balance tile is a permission message, not a measured zero.
    expect(screen.getByText('זמין לבעלים בלבד')).toBeInTheDocument();
    expect(screen.queryByText(fmtMoneyExact(0, 'ILS'))).toBeNull();
    // The tab refuses to claim a count it cannot know.
    const paymentsTab = screen.getByRole('tab', { name: 'תשלומים (—)' });
    await user.click(paymentsTab);
    expect(await screen.findByText('צפייה בתשלומים וביתרה הפתוחה של ספק זמינה לבעלים בלבד.')).toBeInTheDocument();
  });

  it('owner: real payments and a measured balance, exactly as before', async () => {
    const user = userEvent.setup();
    const calls = wireCard();
    renderCard();

    await screen.findByRole('heading', { name: 'אחים כהן' });
    await waitFor(() => expect(calls.payments).toBe(1));
    expect(calls.balances).toBe(1);
    // The tile shows the measured balance, not the permission message.
    expect(screen.queryByText('זמין לבעלים בלבד')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'תשלומים (1)' }));
    expect(screen.queryByText('צפייה בתשלומים וביתרה הפתוחה של ספק זמינה לבעלים בלבד.')).toBeNull();
    // NBSP/RLM inside the Intl output defeat the string matcher — compare cell content directly.
    await waitFor(() => {
      const cells = screen.getAllByRole('cell').map((cell) => cell.textContent ?? '');
      expect(cells.some((text) => text.includes('150.00'))).toBe(true);
    });
  });

  it('explains invoices the consolidated flow demoted instead of silently hiding them', async () => {
    const user = userEvent.setup();
    wireCard({ consolidatedCount: 3 });
    renderCard();

    await screen.findByRole('heading', { name: 'אחים כהן' });
    await user.click(screen.getByRole('tab', { name: 'חשבוניות (0)' }));
    expect(await screen.findByText(/אוחדו לחשבונית\s*מרכזת/)).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

/**
 * `FIN-02` — the supplier card's headline balance must equal its own activity ledger.
 *
 * THE MECHANISM, READ IN THE TREE. Migration `0173` ("Invoice balance consumes allocated credit,
 * not lifecycle labels") moved every balance reader off `credit_requests.status in
 * ('offset','closed')` and onto the money actually applied — `payment_allocations` rows naming the
 * credit. `FinancialSupplier.tsx` kept a CLIENT TWIN of the rule `0173` deleted: its activity feed
 * subtracts a credit's NOMINAL amount whenever the credit's lifecycle label says `offset`. The
 * headline above it comes from `supplier_balances_by_currency`, which uses the allocation rule.
 * One card, two rules, and the sweep read the difference off the screen: headline `150`, ledger
 * `900 − 750 − 150 = 0`.
 *
 * The fixture is the sweep's own row: credit #4, 150 ILS, status `offset`, and no allocation —
 * a pre-`0173` row whose label says consumed and whose money never moved. The ledger must not
 * claim money that no allocation records.
 *
 * WHY THE ASSERTION IS THE NET AND NOT A ROW COUNT. "One fewer line" would also pass if the wrong
 * line vanished. The arithmetic the reader does by eye is the thing under test, so the spec does
 * the same arithmetic on the rendered figures and compares it with the rendered headline.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';

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
    profile: { role: 'accountant', full_name: 'בודקת' },
    org: { settings: {}, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import FinancialSupplier from './FinancialSupplier';

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

const SUPPLIER = 'aa000000-0000-4000-8000-000000000013';
const INVOICE = 'f4000000-0000-4000-8000-000000000014';
const PAYMENT = 'f7000000-0000-4000-8000-000000000006';
const CREDIT = 'f5000000-0000-4000-8000-000000000004';

/** The headline the balance functions derive, and the figure the ledger below has to reach. */
const OPEN_BALANCE = 150;

function useEndpoints() {
  server.use(
    http.post(`${SUPABASE_URL}/rest/v1/rpc/read_financial_supplier`, () => HttpResponse.json({
      id: SUPPLIER, name: 'אריזות הדרום', tax_id: '515123456',
      payment_terms: 'שוטף+30', status: 'active',
    })),
    http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json([{
      id: INVOICE, invoice_number: '3377', invoice_date: '2026-06-20',
      total_amount: 900, currency: 'ILS', payment_status: 'partially_paid',
    }])),
    http.get(`${SUPABASE_URL}/rest/v1/credit_requests`, () => HttpResponse.json([{
      id: CREDIT, number: 4, amount: 150, currency: 'ILS',
      // The lifecycle label `0173` stopped trusting. No allocation row names this credit.
      status: 'offset', created_at: '2026-06-25T09:00:00+03:00',
    }])),
    http.get(`${SUPABASE_URL}/rest/v1/payments`, () => HttpResponse.json([{
      id: PAYMENT, number: 6, amount: 750, currency: 'ILS',
      paid_date: '2026-06-28', method: 'העברה בנקאית', reference: '901234',
    }])),
    http.get(`${SUPABASE_URL}/rest/v1/payment_requests`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_balances_by_currency`, () => HttpResponse.json([
      { currency: 'ILS', open_balance_in_currency: OPEN_BALANCE },
    ])),
    http.get(`${SUPABASE_URL}/rest/v1/bank_transactions`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/invoice_balances_by_currency`, () => HttpResponse.json([{
      invoice_id: INVOICE, currency: 'ILS',
      balance_in_currency: OPEN_BALANCE, paid_amount: 750, credited_amount: 0,
    }])),
    http.get(`${SUPABASE_URL}/rest/v1/payment_allocations`, () => HttpResponse.json([
      { payment_id: PAYMENT, amount: 750, currency: 'ILS' },
    ])),
    // `0173`'s canonical computed credit balance: 150 issued, NOTHING allocated.
    http.post(`${SUPABASE_URL}/rest/v1/rpc/credit_request_balance_rows`, () => HttpResponse.json([{
      credit_id: CREDIT, supplier_id: SUPPLIER, invoice_id: INVOICE, credit_number: 4,
      currency: 'ILS', amount: 150, allocated_amount: 0, remaining_amount: 150, status: 'offset',
    }])),
  );
}

function renderCard() {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={[`/finance/suppliers/${SUPPLIER}`]}>
            <Routes>
              <Route path="/finance/suppliers/:id" element={<FinancialSupplier />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

/** he-IL money carries bidi marks and a currency sign; the figure underneath is what is compared. */
function amount(text: string | null): number {
  const bare = (text ?? '')
    .replace(/[‎‏؜⁦-⁩]/g, '')
    .replace(/−/g, '-')
    .replace(/[^\d.,-]/g, '')
    .replace(/,/g, '');
  const parsed = Number.parseFloat(bare);
  if (Number.isNaN(parsed)) throw new Error(`not a figure: ${JSON.stringify(text)}`);
  return parsed;
}

describe('/finance/suppliers/:id — one rule for what a credit took off the debt', () => {
  it('nets its activity ledger to the headline it prints above it', async () => {
    useEndpoints();
    const { container } = renderCard();

    const headline = await screen.findByText('יתרה פתוחה');
    const headlineFigure = amount(headline.parentElement?.querySelector('.kpi-value')?.textContent ?? null);
    expect(headlineFigure).toBe(OPEN_BALANCE);

    const activity = await waitFor(() => {
      const section = container.querySelector('section[aria-labelledby="finance-activity"]');
      if (!section) throw new Error('no activity section');
      const list = section.querySelector('div.divide-y');
      if (!list) throw new Error('activity list not rendered yet');
      return list as HTMLElement;
    });

    const lines = [...activity.children].map((row) => ({
      label: (row.children[0]?.textContent ?? '').replace(/\s+/g, ' '),
      value: amount(row.children[1]?.textContent ?? null),
    }));

    // The two movements that really happened, named so a wrong line cannot pass as a right one.
    expect(lines.map((line) => line.value)).toContain(900);
    expect(lines.map((line) => line.value)).toContain(-750);

    // FIN-02: the ledger claims −150 for a credit whose allocated amount is 0, so it nets to 0
    // while the headline says 150. After the fix there is no credit line at all — no money moved.
    expect(lines.some((line) => line.label.includes('#4'))).toBe(false);
    expect(lines.reduce((total, line) => total + line.value, 0)).toBe(headlineFigure);
  });

  it('does show a credit in the ledger for the amount an allocation actually applied', async () => {
    useEndpoints();
    // Same credit, now half consumed: 60 of the 150 was applied, and the headline moves with it.
    // Its lifecycle label is `received`, because `0173` keeps a credit received while money
    // remains — which is precisely the state the old label rule showed as nothing at all.
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/credit_requests`, () => HttpResponse.json([{
        id: CREDIT, number: 4, amount: 150, currency: 'ILS',
        status: 'received', created_at: '2026-06-25T09:00:00+03:00',
      }])),
      http.get(`${SUPABASE_URL}/rest/v1/supplier_balances_by_currency`, () => HttpResponse.json([
        { currency: 'ILS', open_balance_in_currency: 90 },
      ])),
      http.post(`${SUPABASE_URL}/rest/v1/rpc/credit_request_balance_rows`, () => HttpResponse.json([{
        credit_id: CREDIT, supplier_id: SUPPLIER, invoice_id: INVOICE, credit_number: 4,
        currency: 'ILS', amount: 150, allocated_amount: 60, remaining_amount: 90, status: 'received',
      }])),
    );
    const { container } = renderCard();

    const activity = await waitFor(() => {
      const list = container
        .querySelector('section[aria-labelledby="finance-activity"]')?.querySelector('div.divide-y');
      if (!list) throw new Error('activity list not rendered yet');
      return list as HTMLElement;
    });
    const lines = [...activity.children].map((row) => ({
      label: (row.children[0]?.textContent ?? '').replace(/\s+/g, ' '),
      value: amount(row.children[1]?.textContent ?? null),
    }));

    const credit = lines.find((line) => line.label.includes('#4'));
    expect(credit).toBeDefined();
    // Not −150. The lifecycle label is `received` and the money applied is 60.
    expect(credit?.value).toBe(-60);
    expect(lines.reduce((total, line) => total + line.value, 0)).toBe(90);
  });
});

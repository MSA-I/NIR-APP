import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
 * `DASH-02` / ruling #356 — an on-time rate is a verdict, and a verdict needs a sample.
 *
 * Below five receipts BOTH screens print the em dash the constitution mandates, never a
 * percentage: the sweep of 04.09.2026 found nine suppliers carrying a confident figure drawn from
 * one or two deliveries, one of them `0%` on a single late supply — a sentence passed on a sample
 * of one. A threshold existed before this spec and picked a **colour**; `fmtPct` printed
 * regardless, so the rule was enforced nowhere a reader could see it.
 *
 * THE NUMBER FIVE IS WRITTEN HERE AS A LITERAL, ON PURPOSE. An oracle that imported
 * `OTD_MIN_SAMPLES` would agree with whatever the source happens to say — including the `> 0` this
 * finding is about — and would pass on the broken tree while proving nothing. The ruling is the
 * authority here; the constant is the thing under test.
 *
 * Both screens are asserted in one file because the finding is precisely that they disagreed:
 * `/analytics` gated at five, the supplier card at one. A spec per screen could go green on each
 * side while the two rules drifted apart again.
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
    org: { id: 'org-test', settings: {}, base_currency: 'ILS' },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import Analytics from './Analytics';
import { SupplierCard } from './Suppliers';

/** One short of the ruling's five — the case that used to print a confident percentage. */
const BELOW_THRESHOLD = 4;
/** Exactly the ruling's five — the smallest sample that may be reported. */
const AT_THRESHOLD = 5;

/** A `supplier_metrics` row (view 0011), carrying the columns these two screens read. */
const metricsRow = (supplier_id: string, otd_samples: number, on_time_pct: number | null) => ({
  supplier_id,
  otd_samples,
  on_time_pct,
  avg_lead_days: 2.5,
  open_exceptions: 0,
  exceptions_lifetime: 0,
  open_credits: 0,
  open_credits_amount: null,
  open_credits_currency: null,
  price_changes_window: 0,
  priced_items: 0,
});

/**
 * The thin supplier's hidden rate is HIGHER than the reportable one, and that is load-bearing.
 * With the numbers the other way round the broken tree happens to rank the two suppliers in the
 * order the fixed tree does, so the sorting assertion below passed against the bug — an assertion
 * that cannot fail on the unfixed tree is decoration, not an oracle. 95% off four deliveries is
 * also the shape of the real complaint: the flattering figure is as unfounded as the damning one.
 */
const THIN = metricsRow('sup-thin', BELOW_THRESHOLD, 95);
const SOLID = metricsRow('sup-solid', AT_THRESHOLD, 80);

// ---------------------------------------------------------------------------------------------
// /analytics — the leaderboard
// ---------------------------------------------------------------------------------------------

const SUPPLIER_ROWS = [
  { id: 'sup-thin', name: 'ספק דל מדגם', rating: 4, status: 'active' },
  { id: 'sup-solid', name: 'ספק מבוסס', rating: 4, status: 'active' },
];

function renderAnalytics() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json(SUPPLIER_ROWS)),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_metrics`, () => HttpResponse.json([THIN, SOLID])),
  );
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={['/analytics']}>
            <Routes><Route path="/analytics" element={<Analytics />} /></Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

/**
 * The on-time cell of one leaderboard row, addressed by COLUMN POSITION rather than by text: the
 * rating column draws an em dash of its own when a supplier is unrated, so a bare
 * `getByText('—')` would find the wrong cell and report this finding closed while it was open.
 */
const ON_TIME_COLUMN = 3;  // name, rating, lead time, on-time, …

/**
 * `DataTable` renders the phone cards AND the `lg`-only table into the same tree, so a supplier's
 * name matches twice and `findByText` throws on the ambiguity rather than on the finding. Rows
 * exist only in the table, so addressing the row is both unambiguous and the desktop surface the
 * screenshot shows.
 */
const analyticsRow = (name: string) => waitFor(() => {
  const row = screen.getAllByRole('row').find((candidate) => candidate.textContent?.includes(name));
  if (!row) throw new Error(`no /analytics row for ${name}`);
  return row;
});

async function onTimeCellFor(name: string) {
  const row = await analyticsRow(name);
  return (within(row).getAllByRole('cell')[ON_TIME_COLUMN].textContent ?? '').trim();
}

describe('/analytics — on-time rate below the reportable sample size', () => {
  it(`draws the em dash at ${BELOW_THRESHOLD} receipts and the percentage at ${AT_THRESHOLD}`, async () => {
    renderAnalytics();

    // The row this finding is about: four receipts is not a record, and 50% is not a fact.
    expect(await onTimeCellFor('ספק דל מדגם')).toBe('—');
    // …and the fix must not silence the suppliers that do have a sample.
    expect(await onTimeCellFor('ספק מבוסס')).toBe('80%');
  });

  it('does not print the unreportable figure anywhere on the screen', async () => {
    renderAnalytics();

    await analyticsRow('ספק דל מדגם');
    // Not only the cell: the phone card renders the same value, and the sweep read the screen on
    // both. Neither surface may carry a figure the sample cannot support.
    expect(screen.queryByText('95%')).toBeNull();
  });

  it('does not rank a supplier by the figure it refuses to show', async () => {
    const user = userEvent.setup();
    renderAnalytics();
    await analyticsRow('ספק מבוסס');

    // Descending by on-time: two clicks (first ascends). A row with no reportable rate has no
    // place among the ranked ones — it sorts to the bottom rather than to the 50% it is hiding.
    const header = screen.getByRole('button', { name: 'עמידה בזמנים' });
    await user.click(header);
    await user.click(header);

    await waitFor(() => {
      const names = screen.getAllByRole('row')
        .slice(1)  // drop the header row
        .map((row) => (within(row).getAllByRole('cell')[0].textContent ?? '').trim());
      expect(names).toEqual(['ספק מבוסס', 'ספק דל מדגם']);
    });
  });

  it('states the threshold it enforces in its own header', async () => {
    renderAnalytics();

    // The promise was already written here and simply was not kept. It has to go on naming the
    // same number the code gates on, or the header is the next thing to drift away from it.
    expect(await screen.findByText(new RegExp(`${AT_THRESHOLD}\\s*קבלות`))).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------
// /suppliers/:id — the supplier card, which gated the same word at one receipt
// ---------------------------------------------------------------------------------------------

const SUPPLIER = {
  id: 'sup-1', org_id: 'org-test', name: 'אחים כהן', tax_id: null, contact_name: null,
  phone: '02-5891000', whatsapp: null, email: null, address: null, min_order_amount: 1250,
  payment_terms: null, notes: null, status: 'active', delivery_days: [], cutoff_time: null,
  default_currency: 'ILS', country_code: 'IL',
  deleted_at: null, created_at: '2026-07-01', updated_at: '2026-07-27',
  rating: null, rating_updated_at: null, rating_note: null,
};

/** The card fetches its whole tab set in one Promise.all; msw runs with `onUnhandledRequest: error`. */
function renderCard(metrics: ReturnType<typeof metricsRow>) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json(SUPPLIER)),
    http.get(`${SUPABASE_URL}/rest/v1/purchase_orders`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json([])),
    http.head(`${SUPABASE_URL}/rest/v1/invoices`, () => new HttpResponse(null, {
      headers: { 'Content-Range': '0-0/0' },
    })),
    http.get(`${SUPABASE_URL}/rest/v1/payments`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/credit_requests`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_balances_by_currency`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_metrics`, () => HttpResponse.json({ ...metrics, supplier_id: 'sup-1' })),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_price_submissions`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_communication_preferences`, () => HttpResponse.json([])),
  );
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

/** The value sitting under the "עמידה בזמנים" tile label (`suppliers.text_39`). */
async function onTimeTileValue() {
  const label = await screen.findByText('עמידה בזמנים');
  return (label.nextElementSibling?.textContent ?? '').trim();
}

describe('supplier card — the same word, the same threshold', () => {
  it(`draws the em dash at ${BELOW_THRESHOLD} receipts, where it used to print a percentage`, async () => {
    renderCard(THIN);

    await screen.findByRole('heading', { name: 'אחים כהן' });
    expect(await onTimeTileValue()).toBe('—');
    expect(screen.queryByText('95%')).toBeNull();
  });

  it(`prints the percentage at ${AT_THRESHOLD} receipts`, async () => {
    renderCard(SOLID);

    await screen.findByRole('heading', { name: 'אחים כהן' });
    expect(await onTimeTileValue()).toBe('80%');
  });
});

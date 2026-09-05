/**
 * `FIN-01` — one answer to "are there open credits", where this PR can give one.
 *
 * The sweep read three answers off three screens. The accountant's dashboard said `0` open
 * credits; `/credits` — filtered to the same population, in the same session — headed itself
 * `סה״כ זיכויים פתוחים: —`. `—` is the marker this codebase reserves for a figure it could NOT
 * measure, and `Money.tsx` says so in its own words. So the two screens did not merely differ in
 * shape: one said "none" and the other said "unknown" about a population both had fully read.
 *
 * `/credits` HAS measured. `openTotals` is derived from a list that already loaded; an empty
 * result there is the claim "nothing is open", which is exactly what the dashboard's all-clear
 * phrasing says. The header takes that sentence rather than the no-data marker.
 *
 * THE ASSERTION IS TIED TO THE DASHBOARD'S OWN KEY, not to a literal chosen here. If the two
 * screens ever answer this question in different words again, this test goes red — which is the
 * only way a "one answer" oracle can mean anything.
 *
 * What this does NOT close: the `/pay` execution dialog quotes a credit total from a
 * `SECURITY DEFINER` signal while the reader beneath it is a `SECURITY INVOKER` function under
 * the accountant's RLS. That is `MON-06`, a different mechanism in a different function, and it
 * is owned elsewhere in this campaign.
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
import { translateIn } from '../lib/i18n/LocaleProvider';
import { fmtMoneyExact } from '../lib/format';

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

import Credits from './Credits';

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

/** The words the accountant's dashboard uses when this exact population is empty. */
const NO_OPEN_CREDITS = translateIn('he', 'accountantDashboard.text_10');
const money = (v: number) => fmtMoneyExact(v, 'ILS').replace(/\s+/g, ' ');

const credit = (over: Record<string, unknown>) => ({
  id: 'cr-1', number: 4, supplier_id: 'sup-1', invoice_id: 'inv-1',
  amount: 150, currency: 'ILS', reason: 'wrong_price', status: 'offset',
  notes: null, created_at: '2026-06-25T09:00:00+03:00', resolved_at: null,
  invoice: { id: 'inv-1', invoice_number: '3377', review_status: 'approved' },
  ...over,
});

function useCredits(rows: Array<Record<string, unknown>>) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/credit_requests`, () =>
      HttpResponse.json(rows, {
        status: 200,
        headers: { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` },
      })),
    http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_directory`, () => HttpResponse.json([{
      id: 'sup-1', name: 'חוות השדה', tax_id: null,
      payment_terms: null, status: 'active', bank_details: null,
    }])),
  );
}

function renderCredits() {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={['/credits?status=all']}>
            <Routes><Route path="/credits" element={<Credits />} /></Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

/**
 * The `<b>` beside the header's total, read as its own text.
 *
 * The label is located through its own dictionary key rather than a literal. `DASH-10` measured
 * that "open" is the wrong word here — `received` credits are counted in this population and
 * their own badge reads done — so the heading names what the three states share instead. A
 * hard-coded sentence in a locator would have to be edited every time that wording sharpens,
 * and would fail as a missing element rather than as a wrong value.
 */
async function headerTotal(): Promise<string> {
  const label = await screen.findByText(translateIn('he', 'credits.fmtMoneyExact_2'));
  return await waitFor(() => {
    const figure = label.parentElement?.querySelector('b');
    if (!figure) throw new Error('header total not rendered');
    return (figure.textContent ?? '').replace(/\s+/g, ' ');
  });
}

describe('/credits — a measured empty population is not an unknown one', () => {
  it('answers a measured-empty open-credit total in the dashboard\'s own words, not with —', async () => {
    // One credit exists and it is already consumed, so the OPEN population is measured and empty.
    useCredits([credit({ status: 'offset' })]);
    renderCredits();

    // The row is on screen: the list loaded, so the header's figure is a measurement.
    await screen.findAllByText('#4');

    expect(await headerTotal()).toBe(NO_OPEN_CREDITS);
    expect(await headerTotal()).not.toBe('—');
  });

  it('still prints the money when a credit really is open', async () => {
    useCredits([credit({ status: 'received' })]);
    renderCredits();

    await screen.findAllByText('#4');
    expect(await headerTotal()).toBe(money(150));
  });
});

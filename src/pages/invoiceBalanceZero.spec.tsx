/**
 * `FIN-09` / `MON-09` — a measured 0.00 is data, and must not borrow the no-data marker.
 *
 * The constitution's rule has two halves and the list only ever honoured one: a metric with NO
 * data shows `—` and never `0`. The mirror is that a measured zero is a claim about the world —
 * "this invoice is settled" — and printing it as `—` makes "paid in full" and "balance could not
 * be read for you" the same glyph. `MON-09` reached the same place from the action side: the
 * sweep paid an invoice down to exactly 0.00 and the row still read `—`.
 *
 * WHY THE ASSERTION IS PER ROW AND NOT A COUNT. Three invoices, three different answers, and a
 * counting assertion ("one dash on screen") would pass on a tree that put the dash on the wrong
 * invoice. Each row is located by its own invoice number and read on its own.
 *
 * The third row is the half that must NOT change: `invoice_balances_by_currency` returns no row
 * at all for an invoice the reader's role may not value (`0218`, and the accountant's approval
 * predicate above it). That is genuinely unknown, and it keeps the em dash.
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

import { InvoicesList } from './Invoices';

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

/** he-IL joins the figure to ₪ with a NBSP; the DOM queries collapse it, so the expectation must too. */
const money = (v: number) => fmtMoneyExact(v, 'ILS').replace(/\s+/g, ' ');

const INVOICES = [
  // Paid to exactly zero — the invoice `MON-09` drove there by hand.
  { id: 'inv-zero', invoice_number: 'N-ZERO' },
  // Ordinary open balance — the control that proves the column still prints money.
  { id: 'inv-open', invoice_number: 'N-OPEN' },
  // No balance row comes back for this one: unknown, and it keeps the dash.
  { id: 'inv-unknown', invoice_number: 'N-UNKNOWN' },
].map((invoice) => ({
  ...invoice,
  invoice_date: '2026-05-10',
  total_amount: 900,
  currency: 'ILS',
  review_status: 'approved',
  payment_status: 'paid',
  export_status: 'not_sent',
  supplier_id: 'sup-1',
  order_links: [],
  deleted_at: null,
}));

const BALANCES: Record<string, number> = { 'inv-zero': 0, 'inv-open': 150 };

function useEndpoints() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/invoices`, () =>
      HttpResponse.json(INVOICES, {
        status: 200,
        headers: { 'content-range': `0-${INVOICES.length - 1}/${INVOICES.length}` },
      })),
    http.head(`${SUPABASE_URL}/rest/v1/invoices`, () =>
      new HttpResponse(null, { status: 200, headers: { 'content-range': `*/${INVOICES.length}` } })),
    http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_directory`, () =>
      HttpResponse.json([{
        id: 'sup-1', name: 'אריזות הדרום', tax_id: null,
        payment_terms: null, status: 'active', bank_details: null,
      }])),
    http.get(`${SUPABASE_URL}/rest/v1/invoice_balances_by_currency`, ({ request }) => {
      const asked = new URL(request.url).searchParams.get('invoice_id')
        ?.replace(/^in\.\(|\)$/g, '').split(',') ?? [];
      return HttpResponse.json(asked
        .filter((id) => id in BALANCES)
        .map((id) => ({ invoice_id: id, currency: 'ILS', balance_in_currency: BALANCES[id] })));
    }),
  );
}

function renderList() {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={['/invoices']}>
            <Routes><Route path="/invoices" element={<InvoicesList />} /></Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

/** The desktop `<tr>` whose cells contain this invoice number, read as its own text. */
async function rowText(invoiceNumber: string): Promise<string> {
  const row = await waitFor(() => {
    const found = screen.getAllByRole('row')
      .find((candidate) => candidate.textContent?.includes(invoiceNumber));
    if (!found) throw new Error(`no row for ${invoiceNumber}`);
    return found;
  });
  return (row.textContent ?? '').replace(/\s+/g, ' ');
}

describe('/invoices — the balance column tells a measured zero from an unknown balance', () => {
  it('prints 0.00 for an invoice measured at zero, and — only where no balance was returned', async () => {
    useEndpoints();
    renderList();

    // FIN-09/MON-09: the defect is exactly this line. A measured 0.00 renders as `—` today,
    // which is the same glyph the unknown row gets.
    expect(await rowText('N-ZERO')).toContain(money(0));
    expect(await rowText('N-ZERO')).not.toContain('—');

    // The control: the column still prints an open balance as money.
    expect(await rowText('N-OPEN')).toContain(money(150));

    // The half that must not move: no balance row came back, so the answer is unknown.
    expect(await rowText('N-UNKNOWN')).toContain('—');
    expect(await rowText('N-UNKNOWN')).not.toContain(money(0));
  });
});

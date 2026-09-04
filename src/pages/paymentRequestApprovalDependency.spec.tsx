/**
 * `REQ-02` — five live payment requests, a 100% refusal rate, and no stated dependency.
 *
 * `p1_transition_payment_request` refuses approval unless EVERY linked invoice is
 * `review_status = 'approved'` (0031:903). In the tenant the sweep measured, not one of the five
 * requests satisfied that, so roughly 10,300 ILS sat under a heading reading "כסף שכבר התחייבנו לו"
 * and none of it could move. The product's own check said "the request includes an invoice that has
 * not yet been approved for payment" — a COUNT from the server's 0034 anti-oracle, which cannot
 * name an invoice. The panel does not need the server to: it is already holding the rows.
 *
 * This suite pins the naming, and only the naming. Whether the approve button should be closed on
 * that dependency is `REQ-01`, which is a separate defect with its own oracle and its own change.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
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

const auth = vi.hoisted(() => ({
  current: {
    profile: { id: 'user-1', org_id: 'org-test', role: 'office' } as { id: string; org_id: string; role: string },
    org: { vat_rate: 18, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  },
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth.current }));

import { PaymentRequestDetail } from './PaymentRequests';

const LINKS_ENDPOINT = `${SUPABASE_URL}/rest/v1/payment_request_invoices`;
const SIGNALS_ENDPOINT = `${SUPABASE_URL}/rest/v1/rpc/payment_request_financial_check_signals`;
const SIMILAR_ENDPOINT = `${SUPABASE_URL}/rest/v1/payment_requests`;

/** #21 in the sweep: 90.00 against an invoice whose review_status is `received`. */
const PR = {
  id: 'pr-1', org_id: 'org-test', unit_id: 'unit-1', number: 21, supplier_id: 'sup-1', amount: 90, currency: 'ILS',
  due_date: null, status: 'pending_approval' as const, notes: null,
  created_by: 'user-1', approved_by: null, approved_at: null,
  open_credit_override_total: null, open_credit_override_reason: null, open_credit_override_at: null,
  executor_notes: null, created_at: '2026-09-01T06:00:00Z',
  supplier: { name: 'משק ירוק — ירקות ופירות' }, approver: null,
};

const BASE_SIGNALS = {
  requested_invoice_count: 1, visible_invoice_count: 1, paid_invoice_count: 0,
  unapproved_invoice_count: 1, amount_matches_open_balance: true,
  similar_bank_transfer_check: 'unavailable',
  currency: 'ILS',
  open_credit_total_by_currency: [] as { currency: string; amount: number }[],
  over_allocated_invoice_count: 0,
};

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

beforeEach(() => {
  auth.current = {
    profile: { id: 'user-1', org_id: 'org-test', role: 'office' },
    org: { vat_rate: 18, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  };
});

type Link = { invoice_id: string; amount_allocated: number; invoice: { invoice_number: string; invoice_date: string; review_status: string } };

function useScreen(links: Link[], signals: Partial<typeof BASE_SIGNALS> = {}) {
  server.use(
    http.get(LINKS_ENDPOINT, () => HttpResponse.json(links)),
    http.get(SIMILAR_ENDPOINT, () => HttpResponse.json([])),
    http.post(SIGNALS_ENDPOINT, () => HttpResponse.json({ ...BASE_SIGNALS, ...signals })),
  );
}

const wrap = (children: ReactNode) => (
  <QueryClientProvider client={createAppQueryClient()}>
    <OrgScopeProvider org="org-test">
      <ToastProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </ToastProvider>
    </OrgScopeProvider>
  </QueryClientProvider>
);

const renderDetail = () => render(wrap(
  <PaymentRequestDetail pr={PR} isOffice onClose={() => {}} onChanged={() => {}} />,
));

describe('PaymentRequestDetail — the dependency a stuck request is waiting on', () => {
  it('names the invoice the approval is waiting for', async () => {
    useScreen([{
      invoice_id: 'inv-1', amount_allocated: 90,
      invoice: { invoice_number: 'LIVE-E2E-6430D260', invoice_date: '2026-08-01', review_status: 'received' },
    }]);
    renderDetail();

    expect(await screen.findByText(/ממתינה לאישור החשבונית LIVE-E2E-6430D260 לתשלום/)).toBeTruthy();
    // And the row itself carries the state, so the sentence and the list agree.
    expect(screen.getAllByText('טרם אושרה').length).toBe(1);
  });

  it('names every one of them when a request is waiting on more than one', async () => {
    useScreen([
      {
        invoice_id: 'inv-1', amount_allocated: 40,
        invoice: { invoice_number: '3377', invoice_date: '2026-08-01', review_status: 'in_review' },
      },
      {
        invoice_id: 'inv-2', amount_allocated: 30,
        invoice: { invoice_number: '7702', invoice_date: '2026-08-02', review_status: 'investigation' },
      },
      {
        invoice_id: 'inv-3', amount_allocated: 20,
        invoice: { invoice_number: '9001', invoice_date: '2026-08-03', review_status: 'approved' },
      },
    ], { requested_invoice_count: 3, visible_invoice_count: 3 });
    renderDetail();

    expect(await screen.findByText(/ממתינה לאישור 2 חשבוניות לתשלום: 3377, 7702/)).toBeTruthy();
    expect(screen.getAllByText('טרם אושרה').length).toBe(2);
  });

  it('says nothing when every linked invoice is approved for payment', async () => {
    useScreen([{
      invoice_id: 'inv-1', amount_allocated: 90,
      invoice: { invoice_number: '9001', invoice_date: '2026-08-01', review_status: 'approved' },
    }], { unapproved_invoice_count: 0 });
    renderDetail();

    expect(await screen.findByText(/9001/)).toBeTruthy();
    // Matched on the clause that only this sentence carries. `ממתינה לאישור` alone is also the
    // status badge's own label for `pending_approval`, so a looser matcher would find the badge
    // and report a dependency line that is not there.
    expect(screen.queryByText(/האישור ייחסם בשרת/)).toBeNull();
    expect(screen.queryByText('טרם אושרה')).toBeNull();
  });
});

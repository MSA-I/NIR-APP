/**
 * `FIN-07` — one KPI label, two populations, and nothing on either screen saying so.
 *
 * The sweep read `יתרת חשבוניות פתוחות` as `790 ₪` on the accountant's control room and
 * `11,582 ₪` on the owner's, under a label identical to the character. The cause is not a bug in
 * either figure: `0218:88-93` filters the accountant's arm of `p0_invoice_balance_rows_by_currency`
 * to `review_status = 'approved'`, so the two roles are measuring different populations and each
 * screen is internally consistent with its own.
 *
 * THE FIX IS THE OPPOSITE OF THE INSTINCT, and this file exists mostly to hold that line. Making
 * the two numbers agree would mean widening the accountant's read to unapproved invoices — a
 * privilege leak dressed as a consistency fix. The population does not move. The LABEL states its
 * scope, on both surfaces the sweep totalled: the control-room KPI and the balance column on
 * `/invoices` that it added up by hand.
 *
 * ONLY THE ROLE-SCOPED SURFACE CHANGES. The owner's figure is not scoped by anything, so the owner
 * keeps the plain label — a qualifier there would be a false statement in the other direction, and
 * `owner: the invoice list keeps the unqualified header` is the control that says so. It passes on
 * the unfixed tree and must keep passing.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

const authState = vi.hoisted(() => ({ role: 'accountant' as string }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', role: authState.role, org_id: 'org-test', full_name: 'בודק' },
    org: { id: 'org-test', settings: {}, base_currency: 'ILS' },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import AccountantDashboard from './dashboards/AccountantDashboard';
import { InvoicesList } from './Invoices';

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (typeof window.IntersectionObserver !== 'function') {
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [];
    } as unknown as typeof window.IntersectionObserver;
  }
});

beforeEach(() => { authState.role = 'accountant'; });

/** The 790 the sweep read, arriving the way the accountant's read actually delivers it. */
function wireDashboard() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/invoice_balances_by_currency`, () => HttpResponse.json([
      { currency: 'ILS', balance_in_currency: 640 },
      { currency: 'ILS', balance_in_currency: 150 },
    ])),
    http.get(`${SUPABASE_URL}/rest/v1/payments`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/:table`, () => HttpResponse.json([])),
  );
}

const INVOICES = [{
  id: 'inv-open', invoice_number: 'N-OPEN', invoice_date: '2026-05-10', total_amount: 900,
  currency: 'ILS', review_status: 'approved', payment_status: 'unpaid', export_status: 'not_sent',
  supplier_id: 'sup-1', order_links: [], deleted_at: null,
}];

function wireInvoiceList() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json(INVOICES, {
      status: 200, headers: { 'content-range': `0-0/${INVOICES.length}` },
    })),
    http.head(`${SUPABASE_URL}/rest/v1/invoices`, () => new HttpResponse(null, {
      status: 200, headers: { 'content-range': `*/${INVOICES.length}` },
    })),
    http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_directory`, () => HttpResponse.json([{
      id: 'sup-1', name: 'אריזות הדרום', tax_id: null,
      payment_terms: null, status: 'active', bank_details: null,
    }])),
    http.get(`${SUPABASE_URL}/rest/v1/invoice_balances_by_currency`, () => HttpResponse.json([
      { invoice_id: 'inv-open', currency: 'ILS', balance_in_currency: 150 },
    ])),
    http.get(`${SUPABASE_URL}/rest/v1/:table`, () => HttpResponse.json([])),
  );
}

function renderIn(node: React.ReactNode, path: string) {
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes><Route path={path} element={node} /></Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

describe('FIN-07 — a role-scoped money label says which population it counted', () => {
  it('accountant control room: the open-balance KPI names its scope instead of the owner label', async () => {
    wireDashboard();
    renderIn(<AccountantDashboard />, '/dashboard');
    await screen.findByText('מרכז הבקרה — הנהלת חשבונות');

    // The control: a KPI whose population is NOT role-scoped keeps exactly the words it had.
    expect(screen.getByText('שולם החודש')).toBeInTheDocument();

    // The defect. This label sits over a figure the accountant's approval predicate narrowed, and
    // it is character-for-character the owner's label over a figure fourteen times larger.
    expect(screen.queryByText('יתרת חשבוניות פתוחות')).toBeNull();
    expect(screen.getByText('יתרת חשבוניות פתוחות — מאושרות בלבד')).toBeInTheDocument();
  });

  // The list renders the desktop table AND the mobile cards into the same document, so every text
  // this screen shows is present more than once. Asked as `getAllByText`, because "exactly one
  // N-OPEN" is a fact about the harness rather than about the label under test.
  it('accountant invoice list: the balance column names the population it can be totalled over', async () => {
    wireInvoiceList();
    renderIn(<InvoicesList />, '/invoices');
    await screen.findAllByText('N-OPEN');

    // The other half of the sweep's repro: it added this column up by hand and got 790.
    expect(screen.getAllByText('יתרה (מאושרות)').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('יתרה')).toHaveLength(0);
  });

  it('owner invoice list: the header stays unqualified, because nothing narrowed it', async () => {
    authState.role = 'owner';
    wireInvoiceList();
    renderIn(<InvoicesList />, '/invoices');
    await screen.findAllByText('N-OPEN');

    // CONTROL — passes before and after. The owner's population is the whole payable ledger, so a
    // scope qualifier here would be the same false statement pointing the other way.
    expect(screen.getAllByText('יתרה').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('יתרה (מאושרות)')).toHaveLength(0);
  });
});

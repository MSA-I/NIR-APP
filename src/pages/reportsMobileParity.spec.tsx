import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

/**
 * RTL-A11Y-05 — /reports at 390px.
 *
 * NOT the same mechanism as RTL-A11Y-02..04, and the remediation plan says otherwise: it lists
 * "src/pages/Reports.tsx (add columnPicker)". Measured on this tree, /reports renders NO DataTable
 * at all — a hand-written <table> hidden below `xl` (it is also the printed sheet the accountant
 * receives, with its own colgroup and print-only rows) and a hand-written card list beside it.
 * There is no `priority`, no picker and nothing for a picker to be added to, so the fix is in the
 * two hand-written bodies and the oracle has to be the finding's own words.
 *
 * What the sweep measured: `תאריך קליטה` — the date that decides which month an invoice belongs
 * to — was on every desktop row and no card; and the month's totals line carried one figure where
 * the desktop <tfoot> carries five, so 487.66 (the pre-VAT total the accountant reconciles
 * against) appeared nowhere on the phone.
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
    org: { id: 'org-test', name: 'עסק לדוגמה', settings: {}, base_currency: 'ILS' },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import Reports from './Reports';

/** Two invoices whose pre-VAT total is a figure that exists nowhere else on the page. */
const invoice = (id: string, num: string, before: number, vat: number, total: number, paid: number) => ({
  id, org_id: 'org-test', supplier_id: 'sup-1', financial_role: 'payable',
  invoice_number: num, invoice_date: '2026-09-01', received_date: '2026-09-02',
  amount_before_vat: before, vat_amount: vat, total_amount: total, currency: 'ILS',
  review_status: 'approved', payment_status: paid >= total ? 'paid' : 'partial',
  export_status: 'pending', notes: null, deleted_at: null,
});

const INVOICES = [
  invoice('inv-1', '3377', 300.00, 54.00, 354.00, 354.00),
  invoice('inv-2', '7702', 187.66, 31.34, 219.00, 208.00),
];

function wire() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json(INVOICES)),
    http.get(`${SUPABASE_URL}/rest/v1/payments`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/credit_requests`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/exceptions`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/bank_transactions`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_directory`, () => HttpResponse.json([
      { id: 'sup-1', name: 'חוות השדה' },
    ])),
    // Every invoice carries a balance row: `allocated` and `openBalance` are withheld entirely
    // when one does not, and a withheld total would hide the very figures under test.
    http.get(`${SUPABASE_URL}/rest/v1/invoice_balances_by_currency`, () => HttpResponse.json([
      { invoice_id: 'inv-1', currency: 'ILS', paid_amount: 354.00, credited_amount: 0, balance_in_currency: 0 },
      { invoice_id: 'inv-2', currency: 'ILS', paid_amount: 208.00, credited_amount: 0, balance_in_currency: 11.00 },
    ])),
    http.get(`${SUPABASE_URL}/rest/v1/payment_reportable_amounts`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/monthly_report_snapshots`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/monthly_report_snapshot_deliveries`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/read_monthly_report_legal_entities`, () => HttpResponse.json([])),
  );
}

/** jsdom has no matchMedia; /reports swaps its bodies on `xl`, so a phone must be stated. */
function phone() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    }),
  });
}

/**
 * Both bodies are mounted and hidden with CSS (`xl:hidden` / `hidden xl:block`), so a bare
 * `screen.getByText` finds a figure in the printed grid that no phone paints. Every claim below is
 * scoped to the card list the phone actually shows.
 */
const mobileList = () => screen.getByRole('list', { name: 'חשבוניות בדוח' });

beforeEach(() => { phone(); wire(); });
afterEach(() => Reflect.deleteProperty(window, 'matchMedia'));

function renderReports() {
  render(
    <LocaleProvider initialLocale="he">
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-test">
          <ToastProvider>
            <MemoryRouter initialEntries={['/reports?month=2026-09']}>
              <Routes><Route path="/reports" element={<Reports />} /></Routes>
            </MemoryRouter>
          </ToastProvider>
        </OrgScopeProvider>
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

describe('/reports at 390px — the entry date and all five totals (RTL-A11Y-05)', () => {
  it('carries תאריך קליטה on every invoice card', async () => {
    renderReports();
    await screen.findByRole('list', { name: 'חשבוניות בדוח' });

    const cards = within(mobileList()).getAllByRole('listitem');
    // The date that decides an invoice's month, and it was on no card.
    for (const card of cards.slice(0, 2)) {
      expect(within(card).getByText(/תאריך קליטה/)).toBeInTheDocument();
      expect(within(card).getByText('02.09.2026')).toBeInTheDocument();
    }
  });

  it('states all five month totals, not only the gross one', async () => {
    renderReports();
    await screen.findByRole('list', { name: 'חשבוניות בדוח' });

    // The totals row is the list's last item, after the invoice cards. Scoped, because the cards
    // carry labels of their own — a per-invoice שולם is not the month's שולם.
    const items = within(mobileList()).getAllByRole('listitem');
    const totalsRow = items[items.length - 1];

    // The five the desktop <tfoot> carries, in its order.
    for (const label of ['לפני מע״מ', 'מע״מ', 'סה״כ', 'שולם', 'יתרה']) {
      expect(within(totalsRow).getByText(label)).toBeInTheDocument();
    }
    // 487.66 is the figure the sweep found nowhere on the phone: the pre-VAT total.
    expect(within(totalsRow).getByText(/487\.66/)).toBeInTheDocument();
    expect(within(totalsRow).getByText(/562\.00/)).toBeInTheDocument();
    expect(within(totalsRow).getByText(/11\.00/)).toBeInTheDocument();
    // The one that always survived stays.
    expect(within(totalsRow).getByText(/573\.00/)).toBeInTheDocument();
  });
});

/**
 * DOC-12 — the goods-receipt detail page nothing in a record links to.
 *
 * `/receipts/:receiptId` is a real screen: it lists what arrived, names the order and the
 * supplier, carries the delivery note, and refuses a nonsense id cleanly. It is reached from
 * exactly two places, and neither is a record a person is reading: the routing card shown once a
 * delivery note has just been reviewed (`document-review/model.ts`), and the linked-context strip
 * on `/invoices/new`. A receipt the reader wants to check tomorrow has no door.
 *
 * The one place the product NAMES a receipt to somebody reading a record is the invoice details
 * card, and there the defect is visible without leaving the line: `invoices.text_7` renders each
 * linked order as a `/orders/:id` link, and `invoices.text_8` — the row directly beneath it —
 * renders each linked receipt as the plain string `#<number>`.
 *
 * THE LINK IS WITHHELD FROM THE ACCOUNTANT ON PURPOSE. `App.tsx` guards the route with STAFF
 * (owner, office); the accountant may read the invoice and may not open the receipt. The number
 * stays on screen for that role exactly as it was — a link nobody may follow is a worse answer
 * than plain text, and widening the route to make the row uniform would be a permission decision
 * taken to tidy a card.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL, rest, rpc } from '../test/msw/handlers';
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

let currentRole: 'owner' | 'office' | 'accountant' = 'owner';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', role: currentRole, full_name: 'בודק', org_id: 'org-1' },
    org: { id: 'org-1', name: 'ארגון בדיקה', settings: {}, base_currency: 'ILS', logo_path: null },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import InvoiceDetail from './InvoiceDetail';

const INVOICE_ID = 'f4000000-0000-4000-8000-000000000013';
const RECEIPT_ID = 'a1000000-0000-4000-8000-000000000077';
const ORDER_ID = 'b2000000-0000-4000-8000-000000000042';

const invoiceRow = () => ({
  id: INVOICE_ID,
  org_id: 'org-1',
  supplier_id: 'sup-1',
  invoice_number: 'INV-9001',
  invoice_date: '2026-08-01',
  received_date: '2026-08-02',
  received_by: null,
  amount_before_vat: 1000,
  vat_amount: 170,
  total_amount: 1170,
  currency: 'ILS',
  review_status: 'pending',
  payment_status: 'unpaid',
  export_status: 'not_exported',
  financial_role: 'payable',
  notes: null,
  deleted_at: null,
  created_at: '2026-08-02T09:00:00Z',
  due_date: '2026-09-01',
  orders: [{ order_id: ORDER_ID, purchase_orders: { id: ORDER_ID, number: 1042, status: 'received' } }],
  receipts: [{ receipt_id: RECEIPT_ID, goods_receipts: { id: RECEIPT_ID, number: 77, received_at: '2026-08-02' } }],
});

function useInvoice() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json(invoiceRow())),
    rest('financial_supplier_directory', [{
      id: 'sup-1', name: 'ספק בדיקה', tax_id: null, payment_terms: null,
      status: 'active', bank_details: null,
    }]),
    http.get(`${SUPABASE_URL}/rest/v1/invoice_balances_by_currency`, () => HttpResponse.json({
      invoice_id: INVOICE_ID, currency: 'ILS',
      total_amount: 1170, paid_amount: 0, credited_amount: 0, balance_in_currency: 1170,
    })),
    rest('payment_allocations', []),
    rest('documents', []),
    rpc('read_allowed_transitions', []),
    rpc('get_invoice_three_way_match', null),
  );
}

function renderDetail() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter initialEntries={[`/invoices/${INVOICE_ID}`]}>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(
    <Routes>
      <Route path="/invoices/:id" element={<InvoiceDetail />} />
    </Routes>,
    { wrapper: Wrapper },
  );
}

/** Every anchor on the rendered page, by href. */
async function hrefs() {
  useInvoice();
  renderDetail();
  // The receipt number itself is the anchor to wait on: it is on screen in both states —
  // as bare text before, as the text of a link after.
  await screen.findByText('#77');
  return [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
}

describe('DOC-12 — the receipt named on the invoice opens', () => {
  beforeEach(() => { server.resetHandlers(); currentRole = 'owner'; });

  it('gives the owner a way into the receipt it names', async () => {
    expect(await hrefs()).toContain(`/receipts/${RECEIPT_ID}`);
  });

  it('gives office the same door', async () => {
    currentRole = 'office';
    expect(await hrefs()).toContain(`/receipts/${RECEIPT_ID}`);
  });

  /**
   * The first control, green in BOTH runs: the ORDER on the line above was already a link. It is
   * what makes the red about the receipt row rather than about anchors, routing or the harness.
   */
  it('leaves the order link on the line above exactly as it was', async () => {
    expect(await hrefs()).toContain(`/orders/${ORDER_ID}`);
  });

  /**
   * The second control, also green in both runs. `App.tsx` guards `/receipts/:receiptId` with
   * STAFF, so the accountant may read this invoice and may not open the receipt. The number is
   * still printed for that role; what must not appear is a door that would refuse them.
   */
  it('offers the accountant the number and no link, because the route is not theirs', async () => {
    currentRole = 'accountant';
    const rendered = await hrefs();
    expect(rendered.filter((href) => href.startsWith('/receipts/'))).toEqual([]);
    expect(screen.getByText('#77')).toBeTruthy();
  });

  /**
   * The third control: the guard the link is aligned to, read from `App.tsx` itself. If somebody
   * later widens the route, this states out loud that the accountant branch above stopped
   * describing the product.
   */
  it('is aligned to the route App.tsx actually declares', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app).toContain('const STAFF: readonly ActiveRole[] = [\'owner\', \'office\'];');
    expect(app).toMatch(/path="\/receipts\/:receiptId"[^\n]*roles=\{STAFF\}/);
  });
});

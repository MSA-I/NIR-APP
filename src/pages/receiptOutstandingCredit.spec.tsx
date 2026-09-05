/**
 * REQ-06 — the receipt record never says what is still outstanding, and never mentions the credit
 * it opened.
 *
 * `/receipts/:receiptId` prints one number per line — "כמות שהתקבלה: 1 קרטון" — and a badge. It
 * does not print the quantity that was ORDERED, so "1" is a figure with nothing to be measured
 * against; it does not print the remainder; and it never says the word זיכוי, although a partial
 * or missing line is the ONE case in which the product raises a credit by itself
 * (`0023:1619,:1638` insert into `credit_requests` with `receipt_item_id` naming the line).
 *
 * THE CAUSE IS ONE FILTER. `ReceiptDetail.tsx:99` builds its only "unsettled" note from
 * `status === 'damaged' || status === 'returned'` — the two line states that produce NO money —
 * so the single line state that does produce money is the one the note excludes.
 *
 * NOTHING IS WIDENED TO MAKE THIS WORK. `goods_receipt_items` already carries `order_item_id`;
 * `purchase_order_items` is read by `/orders` for the same roles; `credit_requests` is read by
 * `/credits`, whose route admits `ACTIVE_ROLES` — a superset of this screen's `STAFF`. The two
 * reads are keyed by the receipt's own lines and by nothing else.
 *
 * The quantities are three different facts and are kept apart: `poi.qty` is what was ordered,
 * `line.qty_received` is what THIS delivery brought, and `poi.qty - poi.received_qty` is what the
 * ORDER is still owed across every delivery. The fixture makes them distinct — 12 ordered, 5 in
 * this receipt, 7 still owed — so an assertion cannot pass by finding the same numeral twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL, rest } from '../test/msw/handlers';
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
    profile: { id: 'office-1', role: 'office', full_name: 'בודקת', org_id: 'org-1' },
    org: { id: 'org-1', name: 'ארגון בדיקה', settings: {}, base_currency: 'ILS', logo_path: null },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import ReceiptDetail from './ReceiptDetail';

const RECEIPT = 'a0000000-0000-4000-8000-000000000024';
const ORDER = 'b0000000-0000-4000-8000-000000000254';
const SHORT_LINE = 'e0000000-0000-4000-8000-000000000001';
const FULL_LINE = 'e0000000-0000-4000-8000-000000000002';
const SHORT_ITEM = 'f0000000-0000-4000-8000-000000000001';
const FULL_ITEM = 'f0000000-0000-4000-8000-000000000002';
const CREDIT = '81b63d4b-4427-4807-a8c2-e44e2c9da49e';

const receipt = {
  id: RECEIPT, org_id: 'org-1', number: 24, order_id: ORDER,
  status: 'completed', received_at: '2026-09-04T09:00:00Z', notes: null,
};
const order = { id: ORDER, number: 254, supplier_id: 'sup-1', status: 'partial' };
const supplier = { id: 'sup-1', name: 'חוות השדה' };
const products = [
  { id: 'p-1', name: 'מלפפון', display_name: null, unit: 'קרטון' },
  { id: 'p-2', name: 'עגבנייה', display_name: null, unit: 'קרטון' },
];

/** Line 1 is short by seven cartons; line 2 arrived whole. */
const shortLine = {
  id: SHORT_LINE, receipt_id: RECEIPT, order_item_id: SHORT_ITEM, product_id: 'p-1',
  qty_received: 5, status: 'partial', notes: null,
};
const fullLine = {
  id: FULL_LINE, receipt_id: RECEIPT, order_item_id: FULL_ITEM, product_id: 'p-2',
  qty_received: 3, status: 'full', notes: null,
};
const orderItems = [
  { id: SHORT_ITEM, order_id: ORDER, product_id: 'p-1', qty: 12, unit_price: 42, received_qty: 5 },
  { id: FULL_ITEM, order_id: ORDER, product_id: 'p-2', qty: 3, unit_price: 10, received_qty: 3 },
];
const openCredit = {
  id: CREDIT, org_id: 'org-1', number: 11, supplier_id: 'sup-1', invoice_id: null,
  receipt_item_id: SHORT_LINE, reason: 'missing', amount: 294, currency: 'ILS',
  status: 'open', notes: 'חוסר כמות בקבלה #24', created_by: null,
  created_at: '2026-09-04T09:00:01Z', resolved_at: null,
};

function useReceipt(lines: (typeof shortLine)[], credits: (typeof openCredit)[]) {
  server.use(
    // `.maybeSingle()` asks PostgREST for one object, so these three answer with one.
    http.get(`${SUPABASE_URL}/rest/v1/goods_receipts`, () => HttpResponse.json(receipt)),
    http.get(`${SUPABASE_URL}/rest/v1/purchase_orders`, () => HttpResponse.json(order)),
    rest('goods_receipt_items', lines),
    http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json(supplier)),
    rest('products', products),
    rest('purchase_order_items', orderItems),
    rest('credit_requests', credits),
    rest('documents', []),
  );
}

function renderReceipt() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter initialEntries={[`/receipts/${RECEIPT}`]}>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(
    <Routes>
      <Route path="/receipts/:receiptId" element={<ReceiptDetail />} />
    </Routes>,
    { wrapper: Wrapper },
  );
}

/** The list item for one product, so a numeral is read on the line it belongs to. */
const lineFor = (product: string) =>
  [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(product)) ?? null;

const hrefs = () => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');

describe('REQ-06 — the receipt states what did not arrive', () => {
  beforeEach(() => { server.resetHandlers(); });

  it('prints the ordered quantity beside the one that arrived', async () => {
    useReceipt([shortLine, fullLine], [openCredit]);
    renderReceipt();
    await screen.findByText('מלפפון');
    expect(lineFor('מלפפון')?.textContent).toContain('12');
  });

  it('prints what the order is still owed', async () => {
    useReceipt([shortLine, fullLine], [openCredit]);
    renderReceipt();
    await screen.findByText('מלפפון');
    expect(lineFor('מלפפון')?.textContent).toContain('7');
  });

  it('names the credit the shortfall opened and offers a way to reach it', async () => {
    useReceipt([shortLine, fullLine], [openCredit]);
    renderReceipt();
    await screen.findByText('מלפפון');
    expect(hrefs()).toContain(`/credits?id=${CREDIT}`);
    expect(document.body.textContent).toContain('294');
  });

  /**
   * Control, green in BOTH runs: the figure the screen already printed is still printed, on the
   * line it belongs to. Without it a "12" and a "7" appearing anywhere would satisfy the two
   * assertions above.
   */
  it('still prints the quantity this delivery brought', async () => {
    useReceipt([shortLine, fullLine], [openCredit]);
    renderReceipt();
    await screen.findByText('מלפפון');
    expect(lineFor('מלפפון')?.textContent).toContain('5');
  });

  /**
   * Control, green in BOTH runs: a receipt with nothing outstanding and no credit gains nothing.
   * A remainder printed on a whole delivery, or a credit block on a receipt that opened none,
   * would be the same defect facing the other way.
   */
  it('adds nothing to a delivery that arrived whole', async () => {
    useReceipt([fullLine], []);
    renderReceipt();
    await screen.findByText('עגבנייה');
    expect(hrefs().filter((href) => href.startsWith('/credits'))).toEqual([]);
    expect(lineFor('עגבנייה')?.textContent).not.toContain('12');
  });
});

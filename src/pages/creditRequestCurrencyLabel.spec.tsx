/**
 * MON-10 — the credit amount field printed its currency twice.
 *
 * The label above the amount box in the credit-request dialog read `סכום (₪) (ILS)`: a shekel sign
 * baked into the dictionary string, and the invoice's own currency code appended at the call site.
 * Two markers for one figure, and on a dollar invoice the two disagree — `סכום (₪) (USD)` tells the
 * reader to type shekels into a box the server stores as USD.
 *
 * THE ORACLE READS THE RENDERED LABEL, not the dictionary and not the JSX. Whichever half is
 * removed, the screen has to end with exactly one marker and it has to be the invoice's. So the
 * dialog is opened on a USD invoice and on an ILS one, and both labels are read off the DOM
 * through the input's own `aria`/`for` association — the same string a person sees.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL, rest, rpc } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { he } from '../lib/i18n/dictionaries/he';

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
    profile: { id: 'owner-1', role: 'owner', full_name: 'בעלים', org_id: 'org-1' },
    org: { id: 'org-1', name: 'ארגון בדיקה', settings: {}, base_currency: 'ILS', logo_path: null },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import InvoiceDetail from './InvoiceDetail';

const INVOICE_ID = 'f4000000-0000-4000-8000-000000000013';

const invoiceRow = (currency: string) => ({
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
  currency,
  review_status: 'pending',
  payment_status: 'unpaid',
  export_status: 'not_exported',
  financial_role: 'payable',
  notes: null,
  deleted_at: null,
  created_at: '2026-08-02T09:00:00Z',
  due_date: '2026-09-01',
  orders: [],
  receipts: [],
});

/** Everything `/invoices/:id` reads as owner. Nothing here is about money shape but the currency. */
function useInvoice(currency: string) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json(invoiceRow(currency))),
    rest('financial_supplier_directory', [{
      id: 'sup-1', name: 'ספק בדיקה', tax_id: null, payment_terms: null,
      status: 'active', bank_details: null,
    }]),
    http.get(`${SUPABASE_URL}/rest/v1/invoice_balances_by_currency`, () => HttpResponse.json({
      invoice_id: INVOICE_ID, currency,
      total_amount: 1170, paid_amount: 0, credited_amount: 0, balance_in_currency: 1170,
    })),
    rest('payment_allocations', []),
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

/** Opens the credit dialog on an invoice in `currency`. */
async function openCreditDialog(currency: string) {
  useInvoice(currency);
  renderDetail();
  const open = await screen.findByRole('button', { name: /דרישת זיכוי/ }, { timeout: 5000 });
  await userEvent.click(open);
  await screen.findByLabelText(/סכום/);
}

/** The text of the amount field's own label, read through the `for`/`id` association. */
function amountLabelText() {
  const input = screen.getByLabelText(/סכום/);
  return document.querySelector(`label[for="${input.id}"]`)?.textContent ?? '';
}

async function amountLabel(currency: string) {
  await openCreditDialog(currency);
  return amountLabelText();
}

/** Every marker the app could print for a currency: the sign, and the ISO code. */
const MARKERS = /₪|\$|€|£|\b[A-Z]{3}\b/g;

describe('MON-10 — one currency marker on the credit amount field', () => {
  beforeEach(() => { server.resetHandlers(); });

  it('states the dollar invoice\'s currency, and does not also say shekel', async () => {
    const text = await amountLabel('USD');
    expect(text).toContain('USD');
    expect(text).not.toContain('₪');
  });

  it('prints exactly one marker, on a dollar invoice', async () => {
    const text = await amountLabel('USD');
    expect(text.match(MARKERS) ?? []).toHaveLength(1);
  });

  /**
   * The shekel case. A shekel invoice was already correct to a reader — `סכום (₪) (ILS)` says the
   * right currency twice — so this one asserts the count, which is the half that was wrong there
   * too. It fails before and passes after for the same single reason as the two above.
   */
  it('prints exactly one marker on a shekel invoice as well', async () => {
    const text = await amountLabel('ILS');
    expect(text.match(MARKERS) ?? []).toHaveLength(1);
    expect(text).toContain('ILS');
  });

  /**
   * The control that passes in BOTH runs. Nothing about the dialog changes except the one label:
   * the reason box and the notes box are still there and still unmarked by any currency. If this
   * ever went red the red above would be a broken harness rather than the defect.
   */
  it('leaves the rest of the dialog exactly as it was', async () => {
    await openCreditDialog('USD');
    expect(screen.getByLabelText(he.invoices.text_25)).toBeTruthy();
    const notes = screen.getByLabelText(he.invoices.setNotes);
    expect(document.querySelector(`label[for="${notes.id}"]`)?.textContent)
      .toBe(he.invoices.setNotes);
    expect(he.invoices.setNotes.match(MARKERS)).toBeNull();
  });
});

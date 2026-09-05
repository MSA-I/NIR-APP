/**
 * ASSIST-06 — a citation that contradicts the claim attached to it.
 *
 * Asked "how much was purchased in the last 30 days?" the assistant answered with three figures
 * from `get_purchase_metrics` — commitment 96,702.29, gross spend 562, net spend 522 — and gave
 * all three the SAME source: "פתיחת מקור: מסך ההוצאות" → `/expenses?from=2026-08-05&to=2026-09-04`.
 * Followed, that URL opens a screen headed 663 ILS. None of the three numbers is anywhere on it.
 *
 * THE DEFECT IS THE LINK, NOT THE CLAIM AND NOT THE ROUTE. Every number is right — 562 really is
 * the approved gross for that window — and the route is a real, role-correct product screen opened
 * on the exact window the tool declared. What is false is the PROMISE: `routeAccess.ts` says in its
 * own header that a source is "the place a person goes to check a claim for themselves", and its
 * shaped-param docblock says out loud what it cannot check — "Binding a citation to the number it
 * cites is the tool author's obligation; this rule only removes the drift between the two halves."
 * The window matched perfectly and the POPULATION did not: `get_purchase_metrics` gross counts
 * APPROVED invoices by `invoice_date`, `/expenses` totals every non-deleted payable invoice in the
 * range, and commitment (order value) is not a quantity the screen displays at all.
 *
 * THE HALF THAT WAS ALREADY THERE. `Expenses.tsx` already calls `get_purchase_metrics` with the
 * same `from`/`to` — it has since the workbook export was written — and then showed the result to
 * nobody. So the screen was DOWNLOADING the assistant's three figures in a spreadsheet while
 * printing a different total above the button that produces it. Rendering what the screen already
 * fetched keeps the evidence trail and closes that second divergence; no query is widened, no role
 * reaches further, and the screen's own total stays exactly where it was, next to the definition
 * that distinguishes the two.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { rest, rpc } from '../test/msw/handlers';
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
    profile: { id: 'owner-1', role: 'owner', full_name: 'בעלים', org_id: 'org-1' },
    org: { id: 'org-1', name: 'ארגון בדיקה', settings: {}, base_currency: 'ILS', logo_path: null },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import Expenses from './Expenses';

/** The cited window, exactly as the tool declared it in `route_params`. */
const FROM = '2026-08-05';
const TO = '2026-09-04';

/**
 * The measured tenant. The screen's own population totals 663 — every non-deleted payable invoice
 * in the range — while the canonical metrics count only what was APPROVED. Every figure is
 * distinct so no assertion can be satisfied by the wrong one.
 */
const invoices = [
  { id: 'i-1', invoice_number: 'QA-R3-1112376', invoice_date: '2026-08-20', total_amount: 300, currency: 'ILS', payment_status: 'unpaid', supplier_id: 'sup-1' },
  { id: 'i-2', invoice_number: 'QA-R3-1112377', invoice_date: '2026-08-22', total_amount: 363, currency: 'ILS', payment_status: 'unpaid', supplier_id: 'sup-2' },
];
const metrics = {
  committed_by_currency: [{ currency: 'ILS', amount: 96702.29 }],
  gross_expense_by_currency: [{ currency: 'ILS', amount: 562 }],
  credits_recognised_by_currency: [{ currency: 'ILS', amount: 40 }],
  credits_pending_by_currency: null,
  net_expense_by_currency: [{ currency: 'ILS', amount: 522 }],
  net_definition: 'ברוטו פחות זיכויים שהוכרו',
};

function useTenant() {
  server.use(
    rest('invoices', invoices),
    rest('categories', []),
    rest('invoice_order_links', []),
    rest('purchase_order_items', []),
    rest('financial_supplier_directory', [
      { id: 'sup-1', name: 'חוות השדה', tax_id: null, payment_terms: null, status: 'active', bank_details: null },
      { id: 'sup-2', name: 'משק ירוק', tax_id: null, payment_terms: null, status: 'active', bank_details: null },
    ]),
    rpc('get_purchase_metrics', metrics),
  );
}

function renderExpenses() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter initialEntries={[`/expenses?from=${FROM}&to=${TO}`]}>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(<Expenses />, { wrapper: Wrapper });
}

const pageText = () => document.body.textContent ?? '';

describe('ASSIST-06 — the cited screen holds the claim it is cited for', () => {
  beforeEach(() => { server.resetHandlers(); });

  it('shows the approved gross the assistant quotes', async () => {
    useTenant();
    renderExpenses();
    await screen.findAllByText('חוות השדה');
    expect(pageText()).toContain('562.00');
  });

  it('shows the net the assistant quotes', async () => {
    useTenant();
    renderExpenses();
    await screen.findAllByText('חוות השדה');
    expect(pageText()).toContain('522.00');
  });

  it('shows the commitment the assistant quotes', async () => {
    useTenant();
    renderExpenses();
    await screen.findAllByText('חוות השדה');
    expect(pageText()).toContain('96,702.29');
  });

  /**
   * Control, green in BOTH runs: the screen's OWN total is not replaced. 663 is a true answer to a
   * different question — every invoice in the range, approved or not — and swapping it for the
   * assistant's population would be the same defect facing the other way. It is the rounded shape
   * this strip has always used, which is also why it cannot be confused with the exact figures
   * above: 300 + 363 is the screen's population and none of 562, 522 or 96,702.29 is an invoice.
   */
  it('keeps the total it was already printing', async () => {
    useTenant();
    renderExpenses();
    await screen.findAllByText('חוות השדה');
    expect(pageText()).toContain('663');
  });

  /**
   * Control, green in BOTH runs: the window is the one in the URL, which is what the citation's
   * `route_params` bind to. Without it the three assertions above could be about any period.
   */
  it('reads the cited window off the URL', async () => {
    useTenant();
    renderExpenses();
    await screen.findAllByText('חוות השדה');
    const dates = [...document.querySelectorAll('input[type="date"]')].map((input) => (input as HTMLInputElement).value);
    expect(dates).toContain(FROM);
    expect(dates).toContain(TO);
  });
});

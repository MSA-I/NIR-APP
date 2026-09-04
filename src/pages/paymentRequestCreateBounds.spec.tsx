/**
 * The create screen's two promises: what it will accept, and what it will produce.
 *
 * `REQ-03` — 999,999.99 typed against a printed 150.00 balance was an amber warning under a green,
 * enabled submit, and 4,721.00 against 4,720.00 produced no balance finding at all. The screen
 * offered what it already knew the server would refuse, and the refusal arrived after the form was
 * finished. Here the allocation bound is measured against the balance the screen itself printed, so
 * the finding is CRITICAL and both submits close.
 *
 * `REQ-05` — with any critical showing, the only submit read "שמירה (יסומן כחשד לכפילות)". The
 * server assigns `suspected_duplicate` on one condition and one only: a live request already exists
 * for this supplier at this exact amount (0073:457-469). An unapproved invoice is not that, so a
 * user choosing the cautious-looking option got a live claim on cash in the approval queue. The
 * label now follows the duplicate signal, which is what the server actually keys on.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    profile: { id: 'user-1', org_id: 'org-test', role: 'owner' } as { id: string; org_id: string; role: string },
    org: { vat_rate: 18, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  },
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth.current }));

import { CreatePaymentRequest } from './PaymentRequests';

const SUPPLIERS_ENDPOINT = `${SUPABASE_URL}/rest/v1/financial_supplier_directory`;
const INVOICES_ENDPOINT = `${SUPABASE_URL}/rest/v1/invoices`;
const BALANCES_ENDPOINT = `${SUPABASE_URL}/rest/v1/invoice_balances_by_currency`;
const SIGNALS_ENDPOINT = `${SUPABASE_URL}/rest/v1/rpc/payment_request_financial_check_signals`;
const REQUESTS_ENDPOINT = `${SUPABASE_URL}/rest/v1/payment_requests`;

/** 3377, from the sweep: 900.00 invoiced, 750.00 paid, and 150.00 the screen prints and pre-fills. */
const INVOICE = {
  id: 'inv-1', invoice_number: '3377', invoice_date: '2026-08-01',
  total_amount: 900, currency: 'ILS', review_status: 'received', payment_status: 'partial',
};
const PRINTED_BALANCE = 150;

const BASE_SIGNALS = {
  requested_invoice_count: 1, visible_invoice_count: 1, paid_invoice_count: 0,
  // The invoice is not approved for payment: a critical, and NOT a duplicate. This is the exact
  // state the sweep pressed the button in.
  unapproved_invoice_count: 1,
  amount_matches_open_balance: true,
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
    profile: { id: 'user-1', org_id: 'org-test', role: 'owner' },
    org: { vat_rate: 18, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  };
});

/**
 * One endpoint serves two different questions on this screen — the deep-linked invoice (a single
 * object, through `maybeSingle`) and the supplier's open list (an array). They are told apart by
 * the columns each asks for, which is what PostgREST itself sees.
 */
function useScreen(options: { similarRequests?: { id: string; number: number; status: string }[] } = {}) {
  server.use(
    http.get(SUPPLIERS_ENDPOINT, () => HttpResponse.json([{
      id: 'sup-1', name: 'משק ירוק — ירקות ופירות', tax_id: null,
      payment_terms: null, status: 'active', bank_details: null,
    }])),
    http.get(INVOICES_ENDPOINT, ({ request }) => {
      const select = new URL(request.url).searchParams.get('select') ?? '';
      if (select.includes('supplier_id')) {
        return HttpResponse.json({
          id: INVOICE.id, supplier_id: 'sup-1', total_amount: INVOICE.total_amount,
          currency: INVOICE.currency, payment_status: INVOICE.payment_status,
        });
      }
      return HttpResponse.json([INVOICE]);
    }),
    http.get(BALANCES_ENDPOINT, ({ request }) => {
      const select = new URL(request.url).searchParams.get('select') ?? '';
      return select.includes('invoice_id')
        ? HttpResponse.json([{ invoice_id: INVOICE.id, balance_in_currency: PRINTED_BALANCE }])
        : HttpResponse.json({ balance_in_currency: PRINTED_BALANCE });
    }),
    http.get(REQUESTS_ENDPOINT, () => HttpResponse.json(options.similarRequests ?? [])),
    http.post(SIGNALS_ENDPOINT, () => HttpResponse.json(BASE_SIGNALS)),
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

const renderCreate = () => render(wrap(
  <CreatePaymentRequest presetInvoiceId={INVOICE.id} onClose={() => {}} onSaved={() => {}} />,
));

const amountField = () => screen.getByLabelText(/סכום ההקצאה לחשבונית 3377/) as HTMLInputElement;
// Each button keeps a name of its own when it closes, so a screen reader is told WHICH route is
// blocked — and so these two selectors cannot both match the same element.
const draftButton = () => screen.getByRole('button', { name: /שמירה כטיוטה/ });
const primaryButton = () => screen.getByRole('button', { name: /שליחה לאישור|חשד לכפילות/ });

describe('CreatePaymentRequest — the allocation bound and the promise on the button', () => {
  it('opens with the printed balance, both submits live', async () => {
    useScreen();
    renderCreate();

    await waitFor(() => expect(amountField().value).toBe('150'), { timeout: 4000 });
    await waitFor(() => expect(primaryButton().hasAttribute('disabled')).toBe(false), { timeout: 4000 });
    expect(draftButton().hasAttribute('disabled')).toBe(false);
  });

  it('closes both submits and states the bound when the allocation goes above the printed balance', async () => {
    useScreen();
    renderCreate();
    await waitFor(() => expect(amountField().value).toBe('150'), { timeout: 4000 });
    await waitFor(() => expect(primaryButton().hasAttribute('disabled')).toBe(false), { timeout: 4000 });

    fireEvent.change(amountField(), { target: { value: '999999.99' } });

    // The finding: critical, and it names the invoice and the balance rather than saying "differs".
    expect(await screen.findByText(/הסכום שהוקצה לחשבונית 3377 גבוה מהיתרה הפתוחה שלה/)).toBeTruthy();
    await waitFor(() => expect(primaryButton().hasAttribute('disabled')).toBe(true), { timeout: 4000 });
    // The draft closes too: create_payment_request applies the same bound to a draft.
    expect(draftButton().hasAttribute('disabled')).toBe(true);
    expect(primaryButton().getAttribute('aria-label'))
      .toBe('השליחה לאישור חסומה — הסכום שהוקצה גבוה מהיתרה הפתוחה של החשבונית');
    expect(draftButton().getAttribute('aria-label'))
      .toBe('שמירה כטיוטה חסומה — הסכום שהוקצה גבוה מהיתרה הפתוחה של החשבונית');
  });

  it('fires one agora over the balance, where the tolerance signal said the amount matched', async () => {
    useScreen();
    renderCreate();
    await waitFor(() => expect(amountField().value).toBe('150'), { timeout: 4000 });

    fireEvent.change(amountField(), { target: { value: '150.01' } });

    expect(await screen.findByText(/הסכום שהוקצה לחשבונית 3377 גבוה מהיתרה הפתוחה שלה/)).toBeTruthy();
    await waitFor(() => expect(primaryButton().hasAttribute('disabled')).toBe(true), { timeout: 4000 });
  });

  it('reopens both submits as soon as the amount comes back inside the balance', async () => {
    useScreen();
    renderCreate();
    await waitFor(() => expect(amountField().value).toBe('150'), { timeout: 4000 });
    fireEvent.change(amountField(), { target: { value: '999999.99' } });
    await waitFor(() => expect(primaryButton().hasAttribute('disabled')).toBe(true), { timeout: 4000 });

    fireEvent.change(amountField(), { target: { value: '120' } });
    await waitFor(() => expect(primaryButton().hasAttribute('disabled')).toBe(false), { timeout: 4000 });
    expect(screen.queryByText(/גבוה מהיתרה הפתוחה שלה/)).toBeNull();
  });

  it('promises approval, not a quarantine, when the critical is an unapproved invoice', async () => {
    useScreen();
    renderCreate();

    // REQ-05: this is the measured case — unapproved_invoice_count 1, no duplicate — and the
    // record the server writes is `pending_approval`.
    //
    // The critical has to be ON SCREEN before the label is read. Asserting the label first would
    // pass on the empty pre-check render, when there is no critical to key anything on, and the
    // defect only exists once the checks have come back.
    expect(await screen.findByText(/הדרישה כוללת חשבונית שטרם אושרה לתשלום/)).toBeTruthy();
    expect(primaryButton().textContent).toContain('שליחה לאישור');
    expect(screen.queryByRole('button', { name: /יסומן כחשד לכפילות/ })).toBeNull();
  });

  it('promises the duplicate flag only when the duplicate signal is the one that fired', async () => {
    useScreen({ similarRequests: [{ id: 'pr-9', number: 12, status: 'pending_approval' }] });
    renderCreate();

    expect(await screen.findByText(/קיימת דרישת תשלום פעילה לאותו ספק באותו סכום בדיוק/)).toBeTruthy();
    expect(primaryButton().textContent).toContain('יסומן כחשד לכפילות');
  });
});

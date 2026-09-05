/**
 * `REQ-01` — the panel says the request cannot be approved, and the button beside it approves.
 *
 * Request #21 in the sweep rendered "לא ניתן לאשר את הדרישה במצבה הנוכחי" · "חסימה אחת" · "הדרישה
 * כוללת חשבונית שטרם אושרה לתשלום", and directly beneath it an ENABLED red primary reading "אישור
 * למרות האזהרות". Pressing it produced HTTP 400 `payment_request_checks_failed`, rendered as "בדיקות
 * השרת מצאו חשבונית ששולמה או יתרה שהשתנתה. רענן ובדוק את הדרישה." Nothing had been paid
 * (`paid_invoice_count: 0` in the same log), no balance had moved, and refreshing redisplayed
 * exactly the same screen. Three separate wrongs in one panel: a button offering an act the server
 * refuses absolutely, a refusal naming a cause that did not happen, and an instruction that changes
 * nothing.
 *
 * `i.review_status <> 'approved'` is one disjunct of the approval barrier (`0031:903`), and it is
 * an ABSOLUTE refusal — there is no override, no reason field and no role that gets past it. The
 * exceptional credit route (`0073:625-663`) re-runs the identical barrier, so it is not a way
 * round either. When the server will certainly refuse, this file already knows what to do: for the
 * over-allocation critical it renders a DISABLED button carrying the reason as its accessible name
 * (`aria_label_4`). This suite holds `invoice_unapproved` to that same standard, and holds the
 * generic refusal to naming what the server actually tests.
 *
 * NOT what this suite measures: whether the queue becomes workable. It does not, and could not —
 * that needs the invoices approved for payment, which the tenant's own three-way-review guard
 * refuses (`REQ-02`). This is about what the screen SAYS and what it OFFERS.
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
import { toErrorKey } from '../lib/errors';
import { he } from '../lib/i18n/dictionaries/he';
import { en } from '../lib/i18n/dictionaries/en';

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

/** #21 as the sweep found it: 90.00 against an invoice still in `received`. */
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

const UNAPPROVED_LINK = {
  invoice_id: 'inv-1', amount_allocated: 90,
  invoice: { invoice_number: 'LIVE-E2E-6430D260', invoice_date: '2026-08-01', review_status: 'received' },
};
const APPROVED_LINK = {
  invoice_id: 'inv-1', amount_allocated: 90,
  invoice: { invoice_number: '9001', invoice_date: '2026-08-01', review_status: 'approved' },
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

type Link = typeof UNAPPROVED_LINK;

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

/** Every button on the panel that offers to APPROVE, whatever its wording. */
const approvalButtons = () => screen.queryAllByRole('button')
  .filter((button) => /אישור/.test(button.textContent ?? '') && !/ביטול/.test(button.textContent ?? ''));

describe('PaymentRequestDetail — an approval the server will certainly refuse', () => {
  it('closes the approve button and carries the reason as its accessible name', async () => {
    useScreen([UNAPPROVED_LINK]);
    renderDetail();

    // The panel that states approval is impossible — the sentence the button contradicted.
    expect(await screen.findByText(/לא ניתן לאשר את הדרישה במצבה הנוכחי/)).toBeTruthy();

    // The precedent this file already set for a refusal the server makes absolutely.
    const approve = await screen.findByRole('button', { name: /אישור חסום — חשבונית בדרישה טרם אושרה לתשלום/ });
    expect(approve.hasAttribute('disabled')).toBe(true);
    // And nothing else on the panel offers to approve. `אישור למרות האזהרות` was the button the
    // sweep pressed; it must not be reachable while this dependency stands.
    expect(screen.queryByRole('button', { name: /אישור למרות האזהרות/ })).toBeNull();
    expect(approvalButtons().every((button) => button.hasAttribute('disabled'))).toBe(true);

    // Cancel stays — it is the only move the state machine still allows from here.
    expect(screen.getByRole('button', { name: /ביטול/ })).toBeTruthy();
  });

  it('does not offer the exceptional credit route as a way past it', async () => {
    useScreen([UNAPPROVED_LINK], { open_credit_total_by_currency: [{ currency: 'ILS', amount: 250 }] });
    renderDetail();

    // The acknowledgement is what arms the exceptional button, so it is pressed here: a door that
    // opens only after a checkbox is still a door.
    const acknowledge = await screen.findByRole('checkbox');
    fireEvent.click(acknowledge);

    expect(screen.queryByRole('button', { name: /אישור חריג/ })).toBeNull();
    expect(approvalButtons().every((button) => button.hasAttribute('disabled'))).toBe(true);
  });

  it('leaves the ordinary approval open when every linked invoice is approved for payment', async () => {
    useScreen([APPROVED_LINK], { unapproved_invoice_count: 0 });
    renderDetail();

    await waitFor(() => expect(screen.getByRole('button', { name: /אישור הדרישה/ })
      .hasAttribute('disabled')).toBe(false));
  });
});

describe('the refusal the server actually sends', () => {
  const key = toErrorKey(new Error('payment_request_checks_failed'));
  const hebrew = (he.errors as Record<string, string>)[key];
  const english = (en.errors as Record<string, string>)[key];

  it('does not claim a payment or a balance change that did not happen', () => {
    // `paid_invoice_count: 0` in the very signals call that preceded the refusal. The barrier
    // (`0031:895-915`) is a disjunction, and "an invoice was paid" is not the disjunct that fired.
    expect(hebrew).not.toMatch(/חשבונית ששולמה/);
    expect(english).not.toMatch(/has been paid/i);
  });

  it('does not send the reader to refresh, which changes nothing', () => {
    // The state is on the server and did not move; the sweep refreshed and read the same screen.
    expect(hebrew).not.toMatch(/רענן/);
    expect(english).not.toMatch(/refresh/i);
  });

  it('names the approval dependency and the step that clears it', () => {
    expect(hebrew).toMatch(/אושרו לתשלום/);
    expect(hebrew).toMatch(/יש לאשר את החשבונית לתשלום/);
    expect(english).toMatch(/approved for payment/i);
  });
});

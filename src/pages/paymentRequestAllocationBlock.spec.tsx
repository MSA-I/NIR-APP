/**
 * The payment request a credit killed — and the refusal that now says so.
 *
 * `payment_request_invoices.amount_allocated` is written when the request is created and is never
 * recomputed. A credit offset afterwards reduces the invoice balance under it, and from that
 * moment the server rejects the request twice — `payment_request_checks_failed` on approval
 * (0073:650-656) and `allocation_exceeds_balance` on execution (0031:678-691) — while no screen
 * can edit an allocation. That is the shape the owner reported as "cannot close a payment request
 * when there is a credit": a refusal with no reason and no next step.
 *
 * 0146 returns `over_allocated_invoice_count` (a count, never a balance — the 0034 anti-oracle),
 * and this suite pins what the screen does with it: BOTH approval routes closed, the reason on
 * screen, and cancel still available. The exceptional-approval route also gets its first client
 * coverage here — it had none, so every button around it was previously unpinned.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const PR = {
  id: 'pr-1', org_id: 'org-test', unit_id: 'unit-1', number: 41, supplier_id: 'sup-1', amount: 1000, currency: 'ILS',
  due_date: null, status: 'pending_approval' as const, notes: null,
  created_by: 'user-1', approved_by: null, approved_at: null,
  open_credit_override_total: null, open_credit_override_reason: null, open_credit_override_at: null,
  executor_notes: null, created_at: '2026-08-19T06:00:00Z',
  supplier: { name: 'אחים כהן' }, approver: null,
};

const BASE_SIGNALS = {
  requested_invoice_count: 1, visible_invoice_count: 1, paid_invoice_count: 0,
  unapproved_invoice_count: 0, amount_matches_open_balance: true,
  similar_bank_transfer_check: 'unavailable',
  // 0219: the signals name the currency the whole answer is in, and report open credits one
  // entry per currency — a dollar credit does not offset a shekel request, so there is no one
  // figure to report.
  currency: 'ILS',
  open_credit_total_by_currency: [],
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

function useScreen(signals: Partial<typeof BASE_SIGNALS>) {
  server.use(
    http.get(LINKS_ENDPOINT, () => HttpResponse.json([{
      invoice_id: 'inv-1', amount_allocated: 1000,
      invoice: { invoice_number: 'A-1', invoice_date: '2026-08-01' },
    }])),
    // The duplicate probe reads the same table the list screen does; nothing similar exists here.
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

describe('PaymentRequestDetail — an allocation that no longer fits', () => {
  it('closes both approval routes and names the credit as the cause', async () => {
    useScreen({ over_allocated_invoice_count: 1, open_credit_total_by_currency: [{ currency: 'ILS', amount: 250 }] });
    renderDetail();

    expect(await screen.findByText(/לא ניתן לאשר את הדרישה במצבה הנוכחי/)).toBeTruthy();
    // ONCE — and this reverses a decision that used to be pinned here, so read before restoring it.
    //
    // This assertion used to demand exactly two, and the reason was not laziness: the check list is
    // where a user looks for WHY, the panel above the buttons is where they look for WHAT NOW, and
    // a refusal appearing in only one of them can be missed. What that reasoning missed is that the
    // two boxes carried the SAME sentence, and a third copy arrived as a toast on approve. The
    // owner saw all three on 19.08.2026 and ruled that one summary states it: what blocks, what is
    // only a warning, what action is required — with the per-check detail behind a disclosure.
    //
    // So WHY and WHAT NOW still both appear; they appear in one box instead of two. `CheckSummary`
    // mounts `CheckList` only after the fold is opened, because a shut `<details>` still holds its
    // children in the DOM and a second copy hidden there would be the same stack, folded. Restoring
    // "2" here would restore the defect, not fix a regression.
    expect(screen.getAllByText(/לבטל את הדרישה ולפתוח דרישה חדשה בסכום המעודכן/)).toHaveLength(1);
    // The count line is the part that replaces the stack: one blocking finding, and the open credit
    // plus the unavailable bank probe as warnings that do not block.
    expect(screen.getByText('חסימה אחת · 2 אזהרות')).toBeTruthy();

    const approve = screen.getByRole('button', { name: 'אישור חסום — ההקצאה גבוהה מהיתרה שנותרה' });
    expect(approve.hasAttribute('disabled')).toBe(true);
    // The exceptional route must NOT be offered as a way past this: the server rejects it too.
    expect(screen.queryByRole('button', { name: /אישור חריג/ })).toBeNull();
    // Cancel stays — it is the only move the state machine still allows from here.
    expect(screen.getByRole('button', { name: /ביטול/ })).toBeTruthy();
  });

  it('leaves the exceptional route alone when the only finding is an open credit', async () => {
    useScreen({ open_credit_total_by_currency: [{ currency: 'ILS', amount: 250 }] });
    renderDetail();

    expect(await screen.findByText(/לספק קיימים זיכויים פתוחים שטרם קוזזו/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /אישור חריג ללא קיזוז הזיכוי/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'אישור רגיל חסום בגלל זיכויים פתוחים' })
      .hasAttribute('disabled')).toBe(true);
  });

  it('offers ordinary approval when nothing is wrong', async () => {
    useScreen({});
    renderDetail();

    await waitFor(() => expect(screen.getByRole('button', { name: /אישור הדרישה/ })
      .hasAttribute('disabled')).toBe(false));
    expect(screen.queryByText(/לא ניתן לאשר את הדרישה במצבה הנוכחי/)).toBeNull();
  });
});

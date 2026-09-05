/**
 * `MON-06` — /pay stops answering one question with two populations.
 *
 * WHAT THE SWEEP SAW, AND WHAT IT ACTUALLY IS. The row was filed as "a `SECURITY DEFINER`
 * function counting credits that the RLS reader beneath it hides — 2 of N". Measured against
 * production on 05.09.2026, both halves of that sentence are wrong, and the truth is worse.
 *
 * `payment_request_financial_check_signals` — the definer the row points at — cannot be called by
 * an accountant AT ALL: its live body opens with `v_role not in ('owner','office') -> raise
 * not_authorized`. So no definer is counting anything under this reader. The number that reaches
 * `/pay` is `payment_requests.open_credit_override_total`: an IMMUTABLE AUDIT FACT, frozen by the
 * approval command at the moment an owner approved this transfer without offsetting credits, and
 * documented in its own column comment as "informational only".
 *
 * And the accountant does not see 2 of N. Measured on the guarded path — role `authenticated`,
 * `accountant@gamos.demo`'s real JWT subject — `credit_request_balance_rows` returns **0 rows of
 * the organisation's 9 open credits, worth 3,423.20 ILS**. The same owner subject returns all 9.
 * The blind spot is total, and it is DELIBERATE: ruling #13 gives this role approved invoices
 * only, and three policies enforce it in agreement — `invoices_select`, `goods_receipts_select`,
 * and `credit_requests_derived_scope_rider`, whose `EXISTS` on `invoices` resolves under the
 * caller's own RLS. Not one open credit in the tenant hangs on an approved invoice.
 *
 * SO NEITHER OF THE TWO OBVIOUS FIXES IS THE FIX. Widening the reader is the privilege leak the
 * plan forbids and ruling #13 already refused. Re-scoping the quoted figure to the reader would
 * destroy an audit record of what the APPROVER saw and, for this role, always render it 0 —
 * deleting the very warning that exists to tell the executor an exception was taken.
 *
 * The two figures disagree because THEIR POPULATIONS DIFFER — one is the approver's view at
 * approval, the other is this reader's view now — so the fix is the plan's own rule for that
 * case: the label states its scope. Two sentences on this screen were lying about scope:
 *
 *   1. The empty state said "אין לספק זה זיכויים פתוחים" — *this supplier has no open credits* —
 *      a positive claim about the world, printed by a reader that had just proved it cannot see
 *      the world. `ASSIST-12` reached this exact conclusion for the SAME DATA on the accountant's
 *      dashboard and drew `—` instead of `0`; `/pay` never received it. An empty read here is
 *      "two different facts wearing one shape", and when `open_credit_override_total` is set the
 *      screen KNOWS which of the two it is: credits existed at approval and are not visible now.
 *
 *   2. The override note quoted 50.00 with no owner and no clock, one panel above that empty
 *      list, inviting a reconciliation that cannot succeed.
 *
 * WHAT THIS SUITE DOES NOT CLAIM. It renders the component against fixtures, so it pins what the
 * screen draws for a given server answer. It asserts nothing about the RLS itself — that was
 * measured read-only against production and is recorded in the evidence file, not here. No
 * migration accompanies this finding: nothing in the database is wrong.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', org_id: 'org-test', role: 'accountant', full_name: 'רואת חשבון' },
    org: { id: 'org-test', base_currency: 'ILS', settings: {} },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

// The default export only. A reviewer has to be able to run this file against the unfixed tree and
// read assertion failures about the SCREEN — importing a not-yet-existing helper would turn the
// red into a module-resolution error instead.
import AccountantPaymentQueue from './AccountantPaymentQueue';

const REQUESTS_ENDPOINT = `${SUPABASE_URL}/rest/v1/payment_requests`;
const DIRECTORY_ENDPOINT = `${SUPABASE_URL}/rest/v1/financial_supplier_directory`;
const BANK_ENDPOINT = `${SUPABASE_URL}/rest/v1/financial_supplier_bank_accounts`;
const CURRENCIES_ENDPOINT = `${SUPABASE_URL}/rest/v1/currencies`;
const BALANCES_ENDPOINT = `${SUPABASE_URL}/rest/v1/invoice_balances_by_currency`;
const EXCEPTIONS_ENDPOINT = `${SUPABASE_URL}/rest/v1/exceptions`;
const CREDIT_BALANCES_RPC = `${SUPABASE_URL}/rest/v1/rpc/credit_request_balance_rows`;

/** חוות השדה — the supplier of production payment request #15, credit #8, 50.00 ILS. */
const SUPPLIER = {
  id: 'sup-2', name: 'חוות השדה', tax_id: null, payment_terms: null,
  status: 'active', bank_details: null,
};

/**
 * Production request #15, to the figure: `approved`, 299.00 ILS, and an approval override that
 * froze 50.00 ILS of open credits the approver could see and this reader cannot.
 */
const REQUEST = {
  id: 'pr-15', org_id: 'org-test', unit_id: null, number: 15, supplier_id: 'sup-2',
  amount: 299, currency: 'ILS', due_date: '2026-09-12', status: 'approved',
  notes: null, created_by: 'user-2', approved_by: 'user-3', approved_at: '2026-09-01T09:00:00Z',
  open_credit_override_total: 50,
  open_credit_override_reason: 'הזיכוי ייושב מול הספק בנפרד',
  open_credit_override_at: '2026-09-01T09:00:00Z',
  executor_notes: null, created_at: '2026-08-30T09:00:00Z',
  invoices: [{ invoice_id: 'inv-3011', amount_allocated: 299, invoice: { invoice_number: '3011' } }],
  approver: { full_name: 'בעל העסק' },
};

const BALANCE = {
  invoice_id: 'inv-3011', currency: 'ILS',
  total_amount: 299, paid_amount: 0, credited_amount: 0, balance_in_currency: 299,
};

/**
 * A credit the reader CAN see, already spent. This is the control population: rows came back, so
 * "no open credits" is a MEASUREMENT and must survive the fix untouched. `ASSIST-12` names this
 * caveat in its own words — hiding a measured zero behind an em dash is the mirror mistake.
 */
const SPENT_CREDIT = {
  credit_id: 'cr-8', supplier_id: 'sup-2', invoice_id: 'inv-3011', credit_number: 8,
  currency: 'ILS', amount: 50, allocated_amount: 50, remaining_amount: 0, status: 'offset',
};

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

/** Every read the screen makes, answered from a fixture. */
function useScreen(credits: unknown[] = []) {
  server.use(
    http.get(REQUESTS_ENDPOINT, () => HttpResponse.json([REQUEST])),
    http.get(DIRECTORY_ENDPOINT, () => HttpResponse.json([SUPPLIER])),
    http.get(BANK_ENDPOINT, () => HttpResponse.json([])),
    http.get(CURRENCIES_ENDPOINT, () => HttpResponse.json([{ code: 'ILS', minor_units: 2 }])),
    http.get(BALANCES_ENDPOINT, () => HttpResponse.json([BALANCE])),
    http.get(EXCEPTIONS_ENDPOINT, () => HttpResponse.json([])),
    http.post(CREDIT_BALANCES_RPC, () => HttpResponse.json(credits)),
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

async function openDialog() {
  const user = userEvent.setup();
  const card = await screen.findByRole('button', { name: /חוות השדה/ });
  await user.click(card);
  return within(await screen.findByRole('dialog'));
}

/** The sentence that claims a fact about the world: "this supplier has no open credits". */
const NO_CREDITS_EXIST = 'אין זיכויים פתוחים לספק זה';

describe('/pay — the credit figure and the credit list name their own populations', () => {
  beforeEach(() => { useScreen([]); });

  it('does not claim the supplier has no open credits when the read returned nothing', async () => {
    // The measured production case: the reader returns zero rows, and the frozen override proves
    // credits existed. Zero rows is "I cannot see", never "there are none".
    render(wrap(<AccountantPaymentQueue />));
    const dialog = await openDialog();
    expect(dialog.queryByText(NO_CREDITS_EXIST)).toBeNull();
  });

  it('says instead that this role cannot see the supplier credits', async () => {
    render(wrap(<AccountantPaymentQueue />));
    const dialog = await openDialog();
    // Anchored on the reason, not on decoration: the role's horizon is approved invoices (#13).
    expect(dialog.getByText(/חשבוניות מאושרות בלבד/)).toBeTruthy();
  });

  it('marks the quoted override figure as the approver view at approval', async () => {
    render(wrap(<AccountantPaymentQueue />));
    const dialog = await openDialog();
    // Without this clause the 50.00 above the empty list reads as a live figure the reader should
    // be able to reconcile, which is the whole of MON-06.
    expect(dialog.getByText(/נמדד ברגע האישור/)).toBeTruthy();
  });

  it('CONTROL — still prints the override amount and its reason', async () => {
    // Passes on both the unfixed and the fixed tree. The fix states a scope; it does not delete
    // an approval-override warning from the executor screen.
    render(wrap(<AccountantPaymentQueue />));
    const dialog = await openDialog();
    const note = dialog.getByText(/לא קוזזו אוטומטית/).closest('span');
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain('50.00');
    expect(note!.textContent).toContain('הזיכוי ייושב מול הספק בנפרד');
  });

  it('CONTROL — a measured zero stays a measured zero', async () => {
    // Rows came back and none of them is open. THAT is a measurement, and it keeps the sentence
    // that states it. Passes on both trees; if it ever fails, the fix over-reached.
    useScreen([SPENT_CREDIT]);
    render(wrap(<AccountantPaymentQueue />));
    const dialog = await openDialog();
    expect(dialog.getByText(NO_CREDITS_EXIST)).toBeTruthy();
    expect(dialog.queryByText(/חשבוניות מאושרות בלבד/)).toBeNull();
  });
});

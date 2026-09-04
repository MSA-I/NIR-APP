/**
 * `FIN-03` · `FIN-10` · `MON-05` — /pay stops contradicting itself.
 *
 * THREE FINDINGS, ONE SCREEN, AND ONE RULING THAT DECIDES THE SHAPE.
 *
 * `FIN-03`: both queued transfers in the live tenant target invoices whose balance is already
 * zero, the dialog shows no balance at all, and the product had ALREADY opened a high-severity
 * duplicate-payment exception for one of them while this screen said nothing.
 *
 * `FIN-10`/`MON-05`: an enabled "ההעברה בוצעה" sat under a red block stating the transfer cannot
 * be performed — and the sweep performed the recording twice, successfully, under that block.
 *
 * Owner ruling #353 (04.09.2026) decides which half goes. **The recording is always accepted**:
 * `/pay` documents a transfer that has ALREADY LEFT THE BANK, so refusing after the click throws
 * away an accounting fact. So the primary is NEVER disabled here, and an earlier draft of the
 * remediation plan that wanted it disabled on a settled invoice contradicted the ruling. What goes
 * is the CONTRADICTION — a red block claiming the action is impossible above a button that
 * performs it — and what arrives is the information the screen was missing: the live balance, the
 * settled mark, and the exception the product already holds.
 *
 * WHY THE MISSING-BANK-DETAILS NOTE STAYS. It is true and useful: nobody can start the NEXT
 * transfer without those details. It simply is not a refusal of THIS recording, so it stops
 * claiming to be one.
 *
 * WHAT THIS SUITE DOES NOT CLAIM. It renders the screen against fixtures, so it pins what the
 * component draws for a given server answer. Whether the server accepts a recording that exceeds
 * the balance is the server half of #353 — a separate contract, a separate PR — and no assertion
 * here touches it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

// The default export ONLY, on purpose: this file is the browser-shaped oracle and a reviewer has
// to be able to run it against the unfixed tree and read five clean assertion failures. Importing
// the new helper here would turn that run into a module-resolution error instead — a red that
// proves an export is missing, not that the screen was wrong. The helper's own arithmetic is
// pinned next door, in `payQueueBalanceArithmetic.spec.ts`.
import AccountantPaymentQueue from './AccountantPaymentQueue';

const REQUESTS_ENDPOINT = `${SUPABASE_URL}/rest/v1/payment_requests`;
const DIRECTORY_ENDPOINT = `${SUPABASE_URL}/rest/v1/financial_supplier_directory`;
const BANK_ENDPOINT = `${SUPABASE_URL}/rest/v1/financial_supplier_bank_accounts`;
const CURRENCIES_ENDPOINT = `${SUPABASE_URL}/rest/v1/currencies`;
const BALANCES_ENDPOINT = `${SUPABASE_URL}/rest/v1/invoice_balances_by_currency`;
const EXCEPTIONS_ENDPOINT = `${SUPABASE_URL}/rest/v1/exceptions`;
const CREDIT_BALANCES_RPC = `${SUPABASE_URL}/rest/v1/rpc/credit_request_balance_rows`;

/** The supplier the sweep read: real, approved, and with NO stored bank account. */
const SUPPLIER = {
  id: 'sup-1', name: 'נקי וזוהר', tax_id: null, payment_terms: null,
  status: 'active', bank_details: null,
};

const REQUEST = {
  id: 'pr-12', org_id: 'org-test', unit_id: null, number: 12, supplier_id: 'sup-1',
  amount: 300, currency: 'ILS', due_date: '2026-09-10', status: 'approved',
  notes: null, created_by: 'user-2', approved_by: 'user-3', approved_at: '2026-09-01T09:00:00Z',
  open_credit_override_total: null, open_credit_override_reason: null, open_credit_override_at: null,
  executor_notes: null, created_at: '2026-08-30T09:00:00Z',
  invoices: [{ invoice_id: 'inv-2088', amount_allocated: 300, invoice: { invoice_number: '2088' } }],
  approver: { full_name: 'בעל העסק' },
};

/** The exception the product opened on its own and the screen never mentioned. */
const DUPLICATE_EXCEPTION = {
  id: 'exc-1', org_id: 'org-test', type: 'duplicate_payment', severity: 'high',
  status: 'open', title: 'חשד לדרישת תשלום כפולה — #12 · נקי וזוהר',
  supplier_id: 'sup-1', invoice_id: 'inv-2088', payment_id: null,
  payment_request_id: 'pr-12', bank_transaction_id: null,
  assigned_role: 'office', created_at: '2026-09-02T10:00:00Z',
  resolved_at: null, resolution_note: null, details: null,
};

/** `invoice_balances_by_currency` — 2088 was settled after the request was approved. */
const SETTLED_BALANCE = {
  invoice_id: 'inv-2088', currency: 'ILS',
  total_amount: 1062, paid_amount: 1062, credited_amount: 0, balance_in_currency: 0,
};

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

/**
 * Every read this screen makes, answered from a fixture.
 *
 * `invoice_balances_by_currency` and `exceptions` are named here even though the unfixed tree
 * never calls them: an msw handler nobody asks for is inert, and naming them keeps the RED run's
 * failure about the SCREEN rather than about an unhandled request.
 */
function useScreen(overrides: {
  balances?: unknown[];
  exceptions?: unknown[];
} = {}) {
  server.use(
    http.get(REQUESTS_ENDPOINT, () => HttpResponse.json([REQUEST])),
    http.get(DIRECTORY_ENDPOINT, () => HttpResponse.json([SUPPLIER])),
    http.get(BANK_ENDPOINT, () => HttpResponse.json([])),
    http.get(CURRENCIES_ENDPOINT, () => HttpResponse.json([{ code: 'ILS', minor_units: 2 }])),
    http.get(BALANCES_ENDPOINT, () => HttpResponse.json(overrides.balances ?? [SETTLED_BALANCE])),
    http.get(EXCEPTIONS_ENDPOINT, () => HttpResponse.json(overrides.exceptions ?? [DUPLICATE_EXCEPTION])),
    http.post(CREDIT_BALANCES_RPC, () => HttpResponse.json([])),
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

/** Opens the one queued card and returns the execution dialog. */
async function openDialog() {
  const user = userEvent.setup();
  const card = await screen.findByRole('button', { name: /נקי וזוהר/ });
  await user.click(card);
  return within(await screen.findByRole('dialog'));
}

beforeEach(() => { useScreen(); });

describe('/pay — a queue that says what it knows and refuses nothing', () => {
  it('marks a queued request whose invoices are already settled', async () => {
    render(wrap(<AccountantPaymentQueue />));
    // The queue itself carries the mark: FIN-03 asks for it BEFORE the dialog is opened, because
    // the accountant decides which card to open from the list.
    expect(await screen.findByText('החשבוניות כבר נפרעו')).toBeTruthy();
  });

  it('shows the invoice live balance beside the approved amount in the dialog', async () => {
    render(wrap(<AccountantPaymentQueue />));
    const dialog = await openDialog();
    // The label, and the measured zero beside it. `0.00` is a claim about the world — the invoice
    // is settled — and it must not borrow the em dash this codebase reserves for "not measured".
    const label = dialog.getByText('יתרה לתשלום בחשבוניות');
    const row = label.closest('div');
    expect(row).toBeTruthy();
    expect(row!.textContent).toMatch(/0\.00/);
  });

  it('draws the em dash, not a zero, when the balance could not be read', async () => {
    // No row from `invoice_balances_by_currency` means the reader's role may not value that
    // invoice (0218). That is genuinely unknown, and "unknown" must not print as "settled".
    useScreen({ balances: [], exceptions: [] });
    render(wrap(<AccountantPaymentQueue />));
    const dialog = await openDialog();
    const row = dialog.getByText('יתרה לתשלום בחשבוניות').closest('div');
    expect(row!.textContent).toContain('—');
    expect(screen.queryByText('החשבוניות כבר נפרעו')).toBeNull();
  });

  it('surfaces the open duplicate-payment exception the product already holds', async () => {
    render(wrap(<AccountantPaymentQueue />));
    const dialog = await openDialog();
    expect(dialog.getByText(/חשד לדרישת תשלום כפולה — #12 · נקי וזוהר/)).toBeTruthy();
  });

  it('never claims the transfer cannot be performed', async () => {
    render(wrap(<AccountantPaymentQueue />));
    const dialog = await openDialog();
    // MON-05's exact contradiction. The missing bank account is still stated — it is true, and it
    // matters for the NEXT transfer — but it no longer refuses the recording underneath it.
    expect(dialog.queryByText(/לא ניתן לבצע את ההעברה/)).toBeNull();
    expect(dialog.getByText(/לא הוזנו פרטי בנק לספק זה/)).toBeTruthy();
  });

  it('keeps the primary enabled — ruling #353 accepts the recording', async () => {
    render(wrap(<AccountantPaymentQueue />));
    const dialog = await openDialog();
    const primary = dialog.getByRole('button', { name: /ההעברה בוצעה/ });
    await waitFor(() => expect(primary.hasAttribute('disabled')).toBe(false));
  });
});

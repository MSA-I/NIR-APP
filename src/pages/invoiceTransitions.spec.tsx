import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';

/** Real supabase-js against the MSW base URL — the wire behaviour stays real. */
vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

/**
 * `office` on purpose: it is inside the FINANCE pair that may move a review status, and it is the
 * role for which InvoiceDetail skips the balance and allocation reads — so the only traffic left is
 * the invoice, the transition graph and the (empty) attachment list.
 */
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', role: 'office', org_id: 'org-test', full_name: 'בודק' },
    org: { id: 'org-test', settings: {} },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import InvoiceDetail, { INVOICE_REVIEW_ACTIONS, readAllowedInvoiceTransitions } from './InvoiceDetail';

const INVOICE_ID = 'inv-1';

const invoice = (reviewStatus: string) => ({
  id: INVOICE_ID, org_id: 'org-test', supplier_id: 'sup-1', invoice_number: '7702',
  invoice_date: '2026-05-01', received_date: '2026-05-02', received_by: null,
  amount_before_vat: 300, vat_amount: 51, total_amount: 351,
  review_status: reviewStatus, payment_status: 'unpaid', export_status: 'not_exported',
  notes: null, deleted_at: null, created_at: '2026-05-02T08:00:00Z',
  supplier: { id: 'sup-1', name: 'מאפה זהב' },
  orders: [], receipts: [],
});

/** `read_allowed_transitions` answers `table (next_status text)` — a row set, never a scalar. */
function useInvoiceScreen(reviewStatus: string, transitions: string[] | { status: number }) {
  const calls: Array<Record<string, unknown>> = [];
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json(invoice(reviewStatus))),
    http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_directory`, () => HttpResponse.json([{
      id: 'sup-1', name: 'מאפה זהב', tax_id: null, payment_terms: null,
      status: 'active', bank_details: null,
    }])),
    http.get(`${SUPABASE_URL}/rest/v1/documents`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/get_invoice_three_way_match`, () => HttpResponse.json({
      status: 'not_comparable',
      approval_blocked: false,
      approval_allowed: true,
      definite_duplicate_invoice: false,
      assessment_hash: 'no-order-assessment',
      override_active: false,
      override: null,
      reasons: [{ code: 'no_order_not_comparable', severity: 'warning' }],
      lines: [],
    })),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/read_allowed_transitions`, async ({ request }) => {
      calls.push((await request.json()) as Record<string, unknown>);
      if (Array.isArray(transitions)) {
        return HttpResponse.json(transitions.map((next_status) => ({ next_status })));
      }
      return HttpResponse.json(
        { message: 'allowed_transitions_entity_unknown', code: 'P0002', details: null, hint: null },
        { status: transitions.status },
      );
    }),
  );
  return calls;
}

function renderDetail() {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={[`/invoices/${INVOICE_ID}`]}>
            <Routes>
              <Route path="/invoices/:id" element={<InvoiceDetail />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

const actionNames = () => screen.getAllByRole('button')
  .map((node) => node.textContent?.trim() ?? '')
  .filter((label) => INVOICE_REVIEW_ACTIONS.some((action) => action.auditLabel === label));

const heading = () => screen.findByRole('heading', { name: /חשבונית 7702/ });

describe('InvoiceDetail — the server owns the review graph (migration 0070)', () => {
  it('asks for the invoice_review graph of the current status and offers exactly what came back', async () => {
    const calls = useInvoiceScreen('in_review', ['approved', 'investigation', 'pending_approval']);
    renderDetail();
    await heading();

    // The entity type is the server's vocabulary — `invoice_review`, not `invoice` (0070:296).
    await waitFor(() => expect(calls).toEqual([
      { p_entity_type: 'invoice_review', p_current_status: 'in_review' },
    ]));
    // The reader's set is unordered by contract; the order is the client's, from the labels.
    expect(actionNames()).toEqual(['העברה לאישור', 'אישור לתשלום', 'סימון לבירור']);
    expect(screen.queryByRole('button', { name: /העברה לבדיקה/ })).toBeNull();
  });

  it('offers approved → investigation, the one visible change of OPEN-DECISIONS #105', async () => {
    // The server has allowed this since 0023; the deleted local matrix hid it.
    useInvoiceScreen('approved', ['investigation']);
    renderDetail();
    await heading();

    const investigate = await screen.findByRole('button', { name: /סימון לבירור/ });
    expect(investigate).toBeEnabled();
    expect(actionNames()).toEqual(['סימון לבירור']);
  });

  it('hides the controls — it does not disable them — when the graph has no successor', async () => {
    useInvoiceScreen('approved', []);
    renderDetail();
    // The heading renders only once the query resolved, and the graph read is part of that query.
    await heading();

    // Zero rows is a legitimate answer, not a failure: no action is offered and nothing is wrong.
    expect(actionNames()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await readAllowedInvoiceTransitions('approved')).toEqual([]);
  });

  it('disables the controls when the graph cannot be read, and never guesses one', async () => {
    useInvoiceScreen('in_review', { status: 500 });
    renderDetail();
    await heading();

    // A failed read is not an empty graph: every action is shown DISABLED, with the reason on
    // screen, because both hiding a legal transition and offering an illegal one are worse.
    await waitFor(() => expect(actionNames()).toEqual(
      INVOICE_REVIEW_ACTIONS.map((action) => action.auditLabel),
    ));
    for (const action of INVOICE_REVIEW_ACTIONS) {
      expect(screen.getByRole('button', { name: new RegExp(action.auditLabel) })).toBeDisabled();
    }
    expect(await screen.findByRole('alert')).toHaveTextContent('עדכון הסטטוס חסום');
    // The invoice itself still rendered: a graph failure must not take the screen down with it.
    expect(screen.getByText('מאפה זהב')).toBeInTheDocument();
  });

  it('reads null — not a fallback matrix — when the RPC fails', async () => {
    useInvoiceScreen('in_review', { status: 403 });
    expect(await readAllowedInvoiceTransitions('in_review')).toBeNull();
  });
});

/**
 * Owner review, defect 5: "every status change opens a reason dialog".
 *
 * The rule these cases pin down is the one in `src/lib/transitionIntent.ts` — a step up the ladder
 * is the work and goes through on one tap; a diversion out of it still stops to ask. The second
 * half of the rule matters just as much as the first: the silent path is silent towards the
 * *user*, never towards `audit_logs`. The last case covers what the dialog was accidentally doing
 * before — standing between an impatient tap and a second command.
 */
describe('InvoiceDetail — a dialog only where a sentence is owed', () => {
  function captureReviewCommand(holdMs = 0) {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/rpc/set_invoice_review_status`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        if (holdMs) await new Promise((resolve) => setTimeout(resolve, holdMs));
        return HttpResponse.json({ invoice_id: INVOICE_ID, review_status: 'pending_approval', idempotent: false });
      }),
    );
    return bodies;
  }

  it('sends an invoice to approval on one tap — no dialog — and still writes a reason to the ledger', async () => {
    useInvoiceScreen('in_review', ['pending_approval', 'approved', 'investigation']);
    const bodies = captureReviewCommand();
    renderDetail();
    await heading();

    await userEvent.click(await screen.findByRole('button', { name: /העברה לאישור/ }));

    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].p_status).toBe('pending_approval');
    // Never null: the command rejects a blank reason (`invoice_review_fields_required`, 0023:1907),
    // and an audit line that says nobody explained the step is a true line, not an empty one.
    expect(bodies[0].p_reason).toMatch(/ללא הערה מהמשתמש/);
  });

  it('still asks before marking an invoice for investigation', async () => {
    useInvoiceScreen('in_review', ['pending_approval', 'investigation']);
    const bodies = captureReviewCommand();
    renderDetail();
    await heading();

    await userEvent.click(await screen.findByRole('button', { name: /סימון לבירור/ }));

    // Diverting an invoice out of the flow is exactly the line an auditor will want a sentence
    // next to, so the dialog opens and nothing is sent until it is confirmed.
    expect(await screen.findByRole('dialog')).toHaveTextContent('עדכון סטטוס בדיקת חשבונית');
    expect(bodies).toEqual([]);
  });

  it('fires once when the button is tapped three times before the command answers', async () => {
    // The dialog used to be an accidental confirm step. Without it the only thing standing between
    // an impatient double-tap and two commands is `busy`, so that claim is measured rather than
    // assumed: the request is held open while three clicks land in the same tick.
    useInvoiceScreen('in_review', ['pending_approval', 'approved', 'investigation']);
    const bodies = captureReviewCommand(50);
    renderDetail();
    await heading();

    const send = await screen.findByRole('button', { name: /העברה לאישור/ });
    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.click(send);

    expect(send).toBeDisabled();
    await waitFor(() => expect(bodies).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(bodies).toHaveLength(1);
  });
});

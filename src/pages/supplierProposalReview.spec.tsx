/**
 * The decision on a supplier's proposal — and the reason that no longer holds the button.
 *
 * This screen had no client coverage at all: no suite named its route, its RPC or „רישום ההחלטה",
 * so every guard around the decision was unpinned. Two of them are worth telling apart, because
 * they look identical on screen and are opposites in principle:
 *
 * - `allDecided` is a COMPLETENESS check. `decide_supplier_order_proposal` refuses a partially
 *   decided proposal (`decisions_incomplete`, 0167), and a button that submitted one would be
 *   offering a state the server does not have. It stays, and it is pinned here.
 * - The reason box is not a check at all. `reason.ts` records the owner's ruling that a box
 *   blocking a legitimate action produces "asdf"; the ledger keeps its sentence from `reasonOr`
 *   instead. What is pinned here is that a rejection goes through with the box untouched — and
 *   that the sentence reaching the server is non-blank, because on a rejection the server itself
 *   raises `decision_reason_required` and null would have failed at the last step.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
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
    profile: { id: 'user-1', org_id: 'org-test', role: 'owner' },
    org: { vat_rate: 18, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import SupplierProposalReview from './SupplierProposalReview';

const line = (id: string, position: number, overrides: Record<string, unknown> = {}) => ({
  id, org_id: 'org-test', proposal_id: 'proposal-1', order_item_id: `item-${position}`, position,
  product_name: `פריט ${position}`, unit: 'ק"ג',
  original_qty: 10, proposed_qty: 8,
  original_unit_price: 12, proposed_unit_price: 12,
  availability: 'available', replacement_note: null,
  line_delta: -24, decision: 'pending',
  created_at: '2026-08-20T06:00:00Z',
  ...overrides,
});

const PROPOSAL = {
  id: 'proposal-1', org_id: 'org-test', link_id: 'link-1', purchase_order_id: 'order-1',
  supplier_id: 'sup-1', status: 'submitted',
  // Null on purpose: the delivery-date decision is a second axis, and this suite is about the
  // line verdicts and the reason. A date here would add a rejection nobody in the test chose.
  proposed_delivery_date: null, supplier_note: null,
  total_delta: -48, submitted_at: '2026-08-20T06:00:00Z',
  decided_at: null, decided_by: null, decision_reason: null,
  delivery_date_accepted: null, revision_order_id: null,
  created_at: '2026-08-20T06:00:00Z',
  lines: [line('line-1', 1), line('line-2', 2, { availability: 'unavailable' })],
};

const ORDER = {
  id: 'order-1', number: 41, status: 'sent', currency: 'ILS', expected_date: '2026-09-01',
  supplier: { name: 'אחים כהן' },
};

function renderScreen() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={['/orders/proposals/proposal-1']}>
            <Routes>
              <Route path="/orders/proposals/:proposalId" element={children} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  return render(<SupplierProposalReview />, { wrapper });
}

function serve() {
  const decisions: Record<string, unknown>[] = [];
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/supplier_order_proposals`, () => HttpResponse.json(PROPOSAL)),
    http.get(`${SUPABASE_URL}/rest/v1/purchase_orders`, () => HttpResponse.json(ORDER)),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/decide_supplier_order_proposal`, async ({ request }) => {
      decisions.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ status: 'rejected', accepted: 0, rejected: 2 });
    }),
  );
  return decisions;
}

describe('SupplierProposalReview', () => {
  it('רושם דחייה גם כשתיבת הסיבה ריקה, ושולח לשרת משפט לא ריק', async () => {
    const decisions = serve();
    const user = userEvent.setup();
    renderScreen();

    const submit = await screen.findByRole('button', { name: 'רישום ההחלטה' });
    await user.click(screen.getByRole('button', { name: 'דחיית כל השורות' }));
    // The box is on screen and untouched — that is the whole point of the test.
    expect((screen.getByLabelText('סיבת ההחלטה (רשות)') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    await waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]).toMatchObject({
      p_proposal_id: 'proposal-1',
      p_accept_delivery_date: false,
      p_line_decisions: [
        { line_id: 'line-1', decision: 'rejected' },
        { line_id: 'line-2', decision: 'rejected' },
      ],
    });
    // `decision_reason_required` (0167) fires on any rejection, so a null here would have been a
    // translated server error instead of a recorded decision.
    expect(String(decisions[0].p_reason).trim()).not.toBe('');
    expect(String(decisions[0].p_reason)).toContain('ללא הערה');
  });

  it('שומר על החסימה עד שכל שורה הוכרעה — היא בדיקת שלמות ולא בדיקת סיבה', async () => {
    const decisions = serve();
    const user = userEvent.setup();
    renderScreen();

    const submit = await screen.findByRole('button', { name: 'רישום ההחלטה' });
    expect(submit).toBeDisabled();

    const groups = screen.getAllByRole('group', { name: 'החלטה לשורה' });
    await user.click(within(groups[0]).getByRole('button', { name: 'אישור' }));
    expect(screen.getByText('יש להכריע על כל שורה לפני רישום ההחלטה.')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    // A typed reason does not unlock it either: the missing verdict is the reason it is closed.
    await user.type(screen.getByLabelText('סיבת ההחלטה (רשות)'), 'סוכם טלפונית');
    expect(submit).toBeDisabled();

    await user.click(within(groups[1]).getByRole('button', { name: 'דחייה' }));
    await waitFor(() => expect(submit).toBeEnabled());
    expect(decisions).toHaveLength(0);
  });
});

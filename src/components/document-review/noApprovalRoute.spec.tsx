/**
 * DOC-06 — the document type the approval command does not accept.
 *
 * `apply_reviewed_document` takes four subtypes and names its refusal of everything else:
 * `0110:326` admits `invoice`, `delivery_note` and `tax_receipt`, and `0172` widened that to
 * `credit_note`. A payment confirmation is therefore not "blocked" — it has no approval route at
 * all, and the screen said so and then stopped. The sweep found a receipt read at full confidence
 * whose only control was disabled and whose screen offered nothing else to press.
 *
 * Two things are asserted, because the defect had two halves:
 *
 *  1. `canSubmit` did not know the server's list. Whether the button came up disabled was decided
 *     by something unrelated — an unresolved supplier — so the same document with a resolved
 *     supplier offered a live button whose only possible outcome is
 *     `document_review_subtype_unsupported`. It now refuses exactly what the command refuses, by
 *     the same list.
 *  2. The screen names a NEXT STEP for that document instead of a state. "There is no approval
 *     route" is true and is not an instruction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { canSubmit, type DocumentReviewRead } from './assessment';

const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn(() => {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'is']) chain[method] = () => chain;
  chain.range = () => Promise.resolve({ data: [], error: null });
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return chain;
}));
vi.mock('../../lib/supabase', () => ({ supabase: { rpc, from } }));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', org_id: 'org-test', role: 'office' },
    org: { vat_rate: 18 },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import { DocumentAssessmentPanel } from './DocumentAssessmentPanel';

function reviewRead(over: Partial<DocumentReviewRead> = {}): DocumentReviewRead {
  return {
    document_id: 'doc-1',
    file_name: 'receipt-7352.pdf',
    document_kind: 'other',
    document_type: 'payment_confirmation',
    document_date: '2026-09-01',
    file_stored: true,
    data_approved: false,
    interpretation_id: 'interpretation-1',
    // Resolved on purpose: this is the case the sweep could not see. With a supplier, the old
    // `canSubmit` said yes to a document the command refuses by name.
    supplier_resolution: {
      resolved: true, matched_by: 'by_vat_id', reason: null, candidates: [],
      supplier_id: 'supplier-1',
    },
    order_resolution: null,
    assessment: null,
    state: 'ready_for_approval',
    ...over,
  };
}

async function renderPanel(read: DocumentReviewRead) {
  rpc.mockResolvedValue({ data: read, error: null });
  render(<MemoryRouter><DocumentAssessmentPanel documentId="doc-1" /></MemoryRouter>);
  return screen.findByRole('button', { name: 'אישור המסמך' });
}

describe('canSubmit mirrors the subtypes apply_reviewed_document accepts', () => {
  it('refuses a payment confirmation even when everything else resolved', () => {
    expect(canSubmit(reviewRead(), 'supplier-1')).toBe(false);
  });

  it('refuses a quote and an unclassified document for the same reason', () => {
    expect(canSubmit(reviewRead({ document_type: 'quote' }), 'supplier-1')).toBe(false);
    expect(canSubmit(reviewRead({ document_type: 'other' }), 'supplier-1')).toBe(false);
  });

  it('still accepts the four subtypes the command does', () => {
    expect(canSubmit(reviewRead({ document_type: 'invoice' }), 'supplier-1')).toBe(true);
    expect(canSubmit(reviewRead({ document_type: 'tax_receipt' }), 'supplier-1')).toBe(true);
  });
});

describe('DOC-06 · מסמך שאין לו מסלול אישור מקבל צעד הבא', () => {
  beforeEach(() => rpc.mockReset());

  it('אומר מה לעשות עם אישור תשלום, לא רק שאין מסלול', async () => {
    await renderPanel(reviewRead());

    expect(screen.getByText('לסוג המסמך הזה אין עדיין מסלול אישור')).toBeInTheDocument();
    const nextStep = screen.getByTestId('no-approval-route-next-step');
    expect(nextStep).toHaveTextContent(/ההתאמה לתשלום שכבר בוצע/);
    expect(nextStep).toHaveTextContent(/תיקיית המסמכים/);
    expect(screen.getByRole('link', { name: 'תיקיית המסמכים' }))
      .toHaveAttribute('href', '/documents');
  });

  it('אומר מה לעשות עם הצעת מחיר — לתקן את הסוג או לשייך מהתיקייה', async () => {
    await renderPanel(reviewRead({ document_type: 'quote' }));

    const nextStep = screen.getByTestId('no-approval-route-next-step');
    // Two actions, both of which exist on screens this role can open: correct the classification
    // (the type selector is on this same page) or file the document from the folder it came from.
    expect(nextStep).toHaveTextContent(/אם הסוג שגוי אפשר לתקן אותו/);
    expect(nextStep).toHaveTextContent(/תיקיית המסמכים/);
  });

  it('אינו מוסיף הוראה כזו למסמך שיש לו מסלול אישור', async () => {
    await renderPanel(reviewRead({ document_type: 'invoice' }));

    expect(screen.queryByTestId('no-approval-route-next-step')).toBeNull();
  });
});

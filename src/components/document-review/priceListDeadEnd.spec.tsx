/**
 * `PL-11` — the two supplier price lists that reached no price.
 *
 * The sweep found exactly two price-list documents in the tenant and neither became prices:
 *
 *   1. „אחים כהן מחירון.pdf" is classified `quote`. `apply_reviewed_document` takes four subtypes
 *      and a quote is not one of them, so the panel correctly says there is no approval route —
 *      and then offers the reader the generic unrouted step, which talks about filing the document
 *      against an invoice or a goods receipt. For a supplier's PRICE LIST that is not the action.
 *      There is exactly one that opens it, and the control for it is on this same page: correct the
 *      classification to מחירון.
 *
 *   2. „פעמית מחירון.pdf" showed „בעיבוד" with 79 lines already read and no result. The document
 *      was not processing at all: `canStart` folds the reader's permission into the DOCUMENT's
 *      state, so an office user who did not upload the file is told the system is still reading it.
 *      The state a badge reports belongs to the document; whether this reader may act on it is a
 *      different sentence, and the screen already has one.
 *
 * The oracle of the row is "a supplier price list reaches a screen where its lines can be matched
 * and imported, OR the screen says which single action unblocks it". Both halves below are the
 * second clause, because the first is a server route this PR may not open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { DocumentProcessingSnapshot } from '../../lib/useDocumentProcessing';
import { canSubmit, type DocumentReviewRead } from './assessment';

const rpc = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ data: unknown; error: unknown }>>(
  async () => ({ data: [], error: null })));
const from = vi.hoisted(() => vi.fn(() => {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is']) chain[method] = () => chain;
  chain.order = () => Promise.resolve({ data: [], error: null });
  chain.range = () => Promise.resolve({ data: [], error: null });
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return chain;
}));
vi.mock('../../lib/supabase', () => ({ supabase: { rpc, from } }));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'office-2', org_id: 'org-1', role: 'office' },
    org: { id: 'org-1', vat_rate: 18 },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import { DocumentAssessmentPanel } from './DocumentAssessmentPanel';
import { PriceListReviewConfirmation } from './PriceListReviewConfirmation';

/* ── 1. the mis-classified price list ─────────────────────────────────────────────────────── */

function reviewRead(over: Partial<DocumentReviewRead> = {}): DocumentReviewRead {
  return {
    document_id: 'doc-quote',
    file_name: 'אחים כהן מחירון.pdf',
    document_kind: 'other',
    document_type: 'quote',
    document_date: '2026-09-01',
    file_stored: true,
    data_approved: false,
    interpretation_id: 'interpretation-1',
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

/* ── 2. the price list that was not processing ────────────────────────────────────────────── */

/** One line item is enough: the finding is about the STATE the screen reports, not the count. */
function priceListSnapshot(jobStatus: string): DocumentProcessingSnapshot {
  return {
    documentId: 'doc-price-list', stage: 'review',
    document: {
      id: 'doc-price-list', org_id: 'org-1', unit_id: null, entity_type: 'inbox', entity_id: null,
      storage_path: 'org-1/price-list.pdf', file_name: 'פעמית מחירון.pdf',
      mime_type: 'application/pdf', document_kind: 'price_list',
      // NOT this reader. That is the whole point of the second half.
      uploaded_by: 'office-1', supplier_id: null, document_date: null,
      deleted_at: null, created_at: '2026-09-02T00:00:00Z',
    },
    job: { id: 'job-1', status: jobStatus, last_error_code: null, last_error_message: null },
    jobs: [], extraction: null, extractions: [],
    interpretation: {
      id: 'interpretation-1', org_id: 'org-1', document_id: 'doc-price-list', provider: 'openai',
      model: 'fixture', prompt_version: 'v1', schema_version: '1', suggested_supplier_id: null,
      payload: {
        schema_version: '1', document_type: 'price_list', document_type_confidence: 0.99,
        supplier: { suggested_id: null, suggested_name: 'פעמית', confidence: 0.9, evidence_block_ids: [] },
        fields: [],
        line_items: [{ source_row: 1, values: { description: 'מוצר', unit_price: 10 }, evidence_block_ids: [] }],
        suggested_annotations: [],
      },
    },
    interpretations: [], annotations: [], ruleApplications: [], learningRules: [],
    reviewCorrections: [], typeReviewDecisions: [], filings: [], feedback: [],
    exportTemplates: [], exportTemplateVersions: [], exports: [], packet: null, packetSegments: [],
    actorNames: new Map(),
    priceListDecision: null, priceListLines: [], priceListPredictions: [],
  } as unknown as DocumentProcessingSnapshot;
}

function renderConfirmation(jobStatus: string) {
  render(
    <MemoryRouter>
      <PriceListReviewConfirmation snapshot={priceListSnapshot(jobStatus)} actorId="office-2"
        onRefetch={async () => true} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: [], error: null });
});

describe('PL-11 · מחירון ספק שסווג „הצעת מחיר"', () => {
  it('נותן את הפעולה האחת שפותחת אותו — תיקון הסוג למחירון', async () => {
    rpc.mockResolvedValue({ data: reviewRead(), error: null });
    render(<MemoryRouter><DocumentAssessmentPanel documentId="doc-quote" /></MemoryRouter>);
    await screen.findByRole('button', { name: 'אישור המסמך' });

    const nextStep = screen.getByTestId('no-approval-route-next-step');
    // The word the reader has to reach for in the type selector, and the screen that follows.
    expect(nextStep).toHaveTextContent(/מחירון/);
    // And it stays a step, not a state: the action is named, on this page.
    expect(nextStep).toHaveTextContent(/אם הסוג שגוי אפשר לתקן אותו/);
  });

  it('בקרה — מסמך שיש לו מסלול אישור אינו מקבל הוראה כזו', async () => {
    rpc.mockResolvedValue({ data: reviewRead({ document_type: 'invoice' }), error: null });
    render(<MemoryRouter><DocumentAssessmentPanel documentId="doc-quote" /></MemoryRouter>);
    await screen.findByRole('button', { name: 'אישור המסמך' });

    expect(screen.queryByTestId('no-approval-route-next-step')).toBeNull();
    expect(canSubmit(reviewRead({ document_type: 'invoice' }), 'supplier-1')).toBe(true);
  });
});

describe('PL-11 · „בעיבוד" שאינו בעיבוד', () => {
  it('מסמך שהקריאה שלו הסתיימה אינו מוצג כמעובד רק מפני שהקורא אינו מעלה המסמך', async () => {
    renderConfirmation('review');

    // The document is at the review gate. It is not being read, and nothing will „appear here when
    // it finishes" — it is waiting for a person.
    await waitFor(() => expect(screen.queryByText('בעיבוד')).toBeNull(), { timeout: 3_000 });
    expect(screen.queryByText('המערכת קוראת את המחירון ומתאימה את השורות. התוצאה תופיע כאן בסיום.'))
      .toBeNull();
    // The state the document is actually in, said out loud — and it is not „ממתין לאישורך",
    // because this reader is not the one who can press it.
    expect(screen.getByText('ממתין לאישור')).toBeInTheDocument();
    // The sentence naming who can act was already there and stays.
    expect(screen.getByText('האישור זמין רק למעלה המסמך בתפקיד בעלים, משרד או ספק.'))
      .toBeInTheDocument();
  });

  it('בקרה — מסמך שבאמת נקרא כרגע עדיין מוצג כבעיבוד', async () => {
    renderConfirmation('processing');

    expect(await screen.findByText('בעיבוד')).toBeInTheDocument();
    expect(screen.queryByText('ממתין לאישור')).toBeNull();
  });
});

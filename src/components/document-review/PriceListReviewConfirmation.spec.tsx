import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { DocumentProcessingSnapshot, PriceListPredictedLine } from '../../lib/useDocumentProcessing';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'owner-1', role: 'owner', org_id: 'org-1' } }),
}));
vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: async () => ({
            data: [{ id: 'product-1', name: 'מוצר בדיקה', unit: 'unit', sku: 'SKU-1' }],
            error: null,
          }),
        }),
      }),
    }),
    rpc: vi.fn(),
  },
}));

import { PriceListReviewConfirmation } from './PriceListReviewConfirmation';

const LINE_COUNT = 22;
const UNMATCHED_LINES = 2;

/**
 * A shadow prediction per line: every line matched to the one product the catalogue mock offers,
 * except the last two — one whose SKU matched nothing, one whose price could not be read. That is
 * the shape a real price list arrives in, and it is the only shape that distinguishes "one button"
 * from "one button plus the exceptions".
 */
function predictions(): PriceListPredictedLine[] {
  return Array.from({ length: LINE_COUNT }, (_, index) => {
    const unmatched = index >= LINE_COUNT - UNMATCHED_LINES;
    return {
      id: `shadow-line-${index}`,
      org_id: 'org-1',
      shadow_run_id: 'shadow-run-1',
      document_id: 'document-1',
      interpretation_id: 'interpretation-1',
      line_index: index,
      source_row: index + 1,
      predicted_action: unmatched ? 'review' : 'apply_existing_price',
      reason_code: unmatched
        ? index === LINE_COUNT - 1 ? 'line_price_unreadable' : 'line_product_unmatched'
        : null,
      matched_by: unmatched ? null : 'sku',
      product_id: unmatched ? null : 'product-1',
      supplier_product_id: null,
      sku: unmatched ? null : `SKU-${index}`,
      barcode: null,
      product_name: `מוצר ${index + 1}`,
      unit: 'unit',
      proposed_unit_price: unmatched ? null : index + 10,
      current_unit_price: null,
      price_change_percent: null,
      product_would_be_created: false,
      created_at: '2026-08-17T00:00:00Z',
    };
  });
}

function snapshot(priceListPredictions: PriceListPredictedLine[]): DocumentProcessingSnapshot {
  const lineItems = Array.from({ length: LINE_COUNT }, (_, index) => ({
    source_row: index + 1,
    values: { description: `מוצר ${index + 1}`, unit_price: index + 10 },
    evidence_block_ids: [],
  }));
  return {
    documentId: 'document-1', stage: 'review',
    document: {
      id: 'document-1', org_id: 'org-1', unit_id: null, entity_type: 'inbox', entity_id: null,
      storage_path: 'org-1/price-list.pdf', file_name: 'price-list.pdf', mime_type: 'application/pdf',
      document_kind: 'price_list', uploaded_by: 'owner-1', supplier_id: null, document_date: null,
      deleted_at: null, created_at: '2026-08-17T00:00:00Z',
    },
    job: { id: 'job-1', status: 'review', last_error_code: null, last_error_message: null },
    jobs: [], extraction: null, extractions: [],
    interpretation: {
      id: 'interpretation-1', org_id: 'org-1', document_id: 'document-1', provider: 'openai',
      model: 'fixture', prompt_version: 'v1', schema_version: '1', suggested_supplier_id: null,
      payload: {
        schema_version: '1', document_type: 'price_list', document_type_confidence: 0.99,
        supplier: { suggested_id: null, suggested_name: 'ספק בדיקה', confidence: 0.99, evidence_block_ids: [] },
        fields: [], line_items: lineItems, suggested_annotations: [],
      },
    },
    interpretations: [], annotations: [], ruleApplications: [], learningRules: [], reviewCorrections: [],
    typeReviewDecisions: [], filings: [], feedback: [], exportTemplates: [], exportTemplateVersions: [],
    exports: [], packet: null, packetSegments: [], actorNames: new Map(),
    priceListDecision: null, priceListLines: [], priceListPredictions,
  } as unknown as DocumentProcessingSnapshot;
}

describe('אישור מחירון', () => {
  it('קולט את השורות שזוהו בלחיצה אחת ומשאיר את הרשת הידנית מקופלת', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    const confirm = await screen.findByTestId('price-list-intake-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    // 20 of 22 prefilled, so the button commits them without the reviewer touching a line.
    expect(confirm).toHaveTextContent(`קליטת ${LINE_COUNT - UNMATCHED_LINES} המחירים שנבחרו`);
    expect(screen.getByTestId('price-list-intake-summary').textContent)
      .toContain(`${LINE_COUNT - UNMATCHED_LINES} מתוך ${LINE_COUNT} שורות זוהו במלואן`);
    expect(screen.getByTestId('price-list-details-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/אני מאשר שורה זו לקליטה/)).not.toBeInTheDocument();
    expect(screen.getByText('החודש קובע לאיזו גרסת מחירון ישויכו המחירים שנבחרו.')).toBeInTheDocument();
  });

  it('פותח רק את השורות שדורשות טיפול, ומאפשר לראות את כולן', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('price-list-intake-confirm')).toBeEnabled());
    await userEvent.click(screen.getByTestId('price-list-show-unmatched'));
    expect(screen.getAllByText(/אני מאשר שורה זו לקליטה/)).toHaveLength(UNMATCHED_LINES);
    expect(screen.getByText(/לא נמצא מק״ט או ברקוד/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('price-list-unmatched-filter'));
    expect(screen.getAllByText(/אני מאשר שורה זו לקליטה/)).toHaveLength(LINE_COUNT);
  });

  it('בלי תחזית שמורה אינו ממלא כלום, אומר זאת, ומשאיר את האישור הידני זמין', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot([])} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    const confirm = await screen.findByTestId('price-list-intake-confirm');
    await waitFor(() => expect(screen.getByTestId('price-list-intake-summary')).toBeInTheDocument());
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/לא נמצאה התאמה אוטומטית שמורה למסמך הזה/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('price-list-details-toggle'));
    expect(screen.getAllByText(/אני מאשר שורה זו לקליטה/)).toHaveLength(LINE_COUNT);
  });
});

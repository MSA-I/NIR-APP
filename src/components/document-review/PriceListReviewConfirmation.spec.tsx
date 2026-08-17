import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { DocumentProcessingSnapshot } from '../../lib/useDocumentProcessing';

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

function snapshot(): DocumentProcessingSnapshot {
  const lineItems = Array.from({ length: 22 }, (_, index) => ({
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
    priceListDecision: null, priceListLines: [],
  } as unknown as DocumentProcessingSnapshot;
}

describe('אישור מחירון ידני', () => {
  it('פותח את 22 השורות, מסביר את חודש היעד ומשאיר קליטה חסומה בלי בחירה', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot()} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('price-list-details-toggle')).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByText((_, node) => node?.tagName === 'P'
      && node.textContent === '0 מתוך 22 שורות נבחרו לקליטה')).toBeInTheDocument();
    expect(screen.getByText('החודש קובע לאיזו גרסת מחירון ישויכו המחירים שנבחרו.')).toBeInTheDocument();
    expect(screen.getByText('הערה ליומן הביקורת — רשות')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'אישור וקליטת השורות שנבחרו' })).toBeDisabled();
    expect(screen.getAllByText(/אני מאשר שורה זו לקליטה/)).toHaveLength(22);
  });
});

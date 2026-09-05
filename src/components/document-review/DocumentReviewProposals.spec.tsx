// The proposals panel, read as an exception inbox.
//
// Seven sibling cards used to stand open at once, the worst of them a 338-row table of every value
// the interpreter returned. What is asserted here is the new contract: the decision surfaces stay
// open, the evidence folds behind counted rows, the table is not BUILT while folded, and the one
// thing on this panel that is a money claim — arithmetic that does not add up — stays outside every
// fold, because staged disclosure hides detail and never hides a finding.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { ReviewSnapshot } from './model';

vi.mock('../../lib/supabase', () => ({
  supabase: { rpc: async () => ({ data: null, error: { message: 'not mocked in this spec' } }) },
}));

import { DocumentReviewProposals } from './DocumentReviewProposals';

const lineItem = (row: number, quantity: number, unitPrice: number, lineTotal: number) => ({
  source_row: row,
  values: { description: `פריט ${row}`, quantity, unit_price: unitPrice, line_total: lineTotal },
});

function proposalsSnapshot(over: { lineItems?: unknown[] } = {}): ReviewSnapshot {
  return {
    documentId: 'document',
    stage: 'review',
    document: {
      id: 'document', file_name: 'invoice.pdf', mime_type: 'application/pdf',
      storage_path: 'org/invoice.pdf', document_kind: 'invoice',
    },
    job: { id: 'job-1', status: 'review', last_error_message: null },
    jobs: [],
    extraction: {
      id: 'extraction-1', engine: 'openai', model: 'gpt-4o-mini', model_version: '2026-05',
      input_checksum: 'etag:1111', contract_version: '1',
      payload: {
        schema_version: '1',
        document: { page_count: 1, detected_languages: ['heb'], plain_text: '', partial: false },
        blocks: [], tables: [], marks: [],
      },
    },
    extractions: [],
    interpretation: {
      id: 'interpretation-1', org_id: 'org', document_id: 'document',
      provider: 'openai', model: 'gpt-4o-mini', prompt_version: '3', schema_version: '1',
      suggested_supplier_id: 'supplier-1',
      payload: {
        schema_version: '1',
        document_type: 'invoice',
        document_type_confidence: 0.95,
        supplier: { suggested_id: 'supplier-1', suggested_name: 'ספק בע״מ', confidence: 0.96, evidence_block_ids: [] },
        fields: [
          { key: 'invoice_number', value: 'INV-1042', confidence: 0.93, evidence_block_ids: [] },
          { key: 'total', value: '126.36', confidence: 0.91, evidence_block_ids: [] },
        ],
        line_items: over.lineItems ?? [
          lineItem(1, 3, 12, 36),
          lineItem(2, 2, 10, 20),
          // The one that does not multiply out: 4 × 5 is 20, the document says 25.
          lineItem(3, 4, 5, 25),
        ],
        suggested_annotations: [],
      },
    },
    interpretations: [],
    annotations: [{
      id: 'annotation-1', document_id: 'document', interpretation_id: 'interpretation-1',
      target_kind: 'mark', target_id: 'mark-1', tag_key: 'urgent', label: 'דחוף',
      confidence: 0.8, source: 'rule', active: true, rule_version: 2,
      created_at: '2026-08-17T00:00:00Z',
    }],
    ruleApplications: [{
      id: 'application-1', document_id: 'document', interpretation_id: 'interpretation-1',
      rule_id: 'rule-1', rule_version: 2, target_id: 'mark-1', confidence: 0.8,
      created_at: '2026-08-17T00:00:00Z',
    }],
    learningRules: [{
      id: 'rule-1', org_id: 'org', user_id: null, document_type: 'invoice', supplier_id: null,
      mark_kind: 'circle', mark_fingerprint: null, tag_key: 'urgent', label: 'דחוף',
      active: true, version: 2, created_at: '2026-08-17T00:00:00Z',
    }],
    reviewCorrections: [], typeReviewDecisions: [], filings: [], feedback: [],
    documentReviewFeedback: [],
    exportTemplates: [], exportTemplateVersions: [], exports: [],
    actorNames: new Map<string, string>(),
  } as unknown as ReviewSnapshot;
}

function renderProposals(snapshot = proposalsSnapshot()) {
  return render(
    <MemoryRouter>
      <DocumentReviewProposals snapshot={snapshot} onRefetch={async () => true} />
    </MemoryRouter>,
  );
}

const foldFor = (label: string) => screen.getByText(label).closest('details') as HTMLDetailsElement;

describe('הראיות מתקפלות, ההחלטה נשארת פתוחה', () => {
  it('פותח את משטחי ההחלטה ומקפל את שני מקטעי הראיות עם ספירה', () => {
    renderProposals();

    // Open, because these are what the reviewer decides on.
    expect(screen.getByText('מה עודכן ולאן').closest('details')).toBeNull();
    expect(screen.getByText('פירוש המסמך').closest('details')).toBeNull();
    expect(screen.getByText('סוג המסמך').closest('details')).toBeNull();
    expect(screen.getByRole('button', { name: /יצירת טיוטת חשבונית מהמסמך/ }).closest('details')).toBeNull();

    // Folded evidence, each carrying its own count on the summary row.
    for (const [label, count] of [
      ['שדות מוצעים', '2'],
      ['שורות מוצעות', '3'],
    ] as const) {
      const fold = foldFor(label);
      expect(fold.open).toBe(false);
      expect(fold.querySelector('summary')).toHaveTextContent(count);
    }

    // Training-console surfaces are gone. One document-level action replaces them.
    expect(screen.queryByText('הערות והחלטות')).toBeNull();
    expect(screen.queryByText('כללים שהופעלו')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'זה לא נכון' })).toHaveLength(1);
  });

  it('אינו בונה את טבלת השורות לפני פתיחה', async () => {
    renderProposals();

    // 338 rows of `<dl>` per row is the real shape of a price list. A shut <details> still renders
    // its children, so the fold has to gate construction — no table means none of it was built.
    expect(screen.queryByRole('table')).toBeNull();

    await userEvent.click(screen.getByText('שורות מוצעות'));
    expect(foldFor('שורות מוצעות').open).toBe(true);
    expect(within(foldFor('שורות מוצעות')).getByRole('table')).toBeInTheDocument();
    expect(within(foldFor('שורות מוצעות')).getAllByText('הכפל אינו מסתדר')).toHaveLength(1);
  });

  it('משאיר את אזהרת הכפל מחוץ לקיפול — ממצא כספי אינו פירוט', () => {
    renderProposals();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('שורות הכפל אינו מסתדר');
    expect(alert).toHaveTextContent('1');
    expect(alert.closest('details')).toBeNull();
  });

  it('שותק כשכל השורות מסתדרות', () => {
    renderProposals(proposalsSnapshot({ lineItems: [lineItem(1, 3, 12, 36), lineItem(2, 2, 10, 20)] }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(foldFor('שורות מוצעות').querySelector('summary')).toHaveTextContent('2');
  });

  it('אומר בשקט שלא זוהו שורות במקום להציע קיפול ריק', () => {
    renderProposals(proposalsSnapshot({ lineItems: [] }));
    expect(screen.queryByText('שורות מוצעות')).toBeNull();
    expect(screen.getByText('לא זוהו שורות פריט.')).toBeInTheDocument();
  });
});

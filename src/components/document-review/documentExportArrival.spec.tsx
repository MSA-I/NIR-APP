/**
 * PR 33 — `EXP-08`: a menu item named "ייצוא" that leads somewhere with nothing to export.
 *
 * The document row action offers `ייצוא` whenever the processing job reached `review` or
 * `completed` (`DocumentsInbox.tsx`), and choosing it navigates to the review screen with
 * `?panel=export`. The sweep followed it on `pricelist-A.csv`, enumerated every button on the
 * destination for `/הורד|ייצוא|CSV|Excel|xlsx/i` and got `[]`. What the screen said instead was a
 * sentence about who may APPROVE the document — a different restriction, about a different act.
 *
 * The gate cannot move to the menu: the folder loads its snapshots without details, so at the
 * moment the menu is built it does not know the document's type, its templates or whether the
 * reader may write. The destination knows all three. So the rule this file pins is the oracle's:
 * a screen reached by an item named "export" either produces a file, or says on arrival what has
 * to happen first for it to — naming the ACTUAL blocking condition, of which there are four.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReviewSnapshot } from './model';

vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: async () => ({ data: null, error: { message: 'not mocked in this spec' } }),
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: 'https://files.example.test/source' }, error: null }),
      }),
    },
  },
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'actor', role: 'owner', full_name: 'בודק', org_id: 'org' },
    org: { id: 'org', name: 'ארגון הבדיקה', settings: {}, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import { DocumentReviewWorkspace } from './DocumentReviewWorkspace';

const CONTRACT = {
  name: 'ייצוא חשבונית',
  format: 'xlsx' as const,
  columns: [{ key: 'invoice_number', label: 'מספר חשבונית', type: 'text' as const, source_path: 'fields.invoice_number', required: false }],
};

function snapshot({
  documentType = 'invoice',
  interpreted = true,
  withTemplate = false,
}: { documentType?: string; interpreted?: boolean; withTemplate?: boolean } = {}): ReviewSnapshot {
  const interpretation = interpreted ? {
    id: 'interpretation-1',
    org_id: 'org',
    document_id: 'document',
    provider: 'openai',
    model: 'gpt-4o-mini',
    prompt_version: '3',
    schema_version: '1',
    suggested_supplier_id: null,
    payload: {
      schema_version: '1',
      document_type: documentType,
      document_type_confidence: 0.9,
      supplier: { suggested_id: null, suggested_name: 'ספק בע״מ', confidence: 0.9, evidence_block_ids: [] },
      fields: [{ key: 'invoice_number', value: 'INV-1042', confidence: 0.93, evidence_block_ids: [] }],
      line_items: [],
      suggested_annotations: [],
    },
  } : null;

  return {
    documentId: 'document',
    stage: 'review',
    document: {
      id: 'document',
      file_name: documentType === 'price_list' ? 'pricelist-A.csv' : 'invoice.png',
      mime_type: documentType === 'price_list' ? 'text/csv' : 'image/png',
      storage_path: 'org/file',
      document_kind: documentType === 'price_list' ? 'price_list' : 'invoice',
    },
    job: { id: 'job-1', status: 'review', last_error_message: null },
    jobs: [],
    extraction: {
      id: 'extraction-1',
      engine: 'openai',
      model: 'gpt-4o-mini',
      model_version: '2026-05',
      input_checksum: 'etag:1111111111111111',
      contract_version: '1',
      payload: {
        schema_version: '1',
        document: { page_count: 1, detected_languages: ['heb'], plain_text: '', partial: false },
        blocks: [],
        tables: [],
        marks: [],
      },
    },
    extractions: [],
    interpretation,
    interpretations: [],
    annotations: [],
    ruleApplications: [],
    learningRules: [],
    reviewCorrections: [],
    typeReviewDecisions: [],
    filings: [],
    feedback: [],
    exportTemplates: withTemplate ? [{
      id: 'template-1', org_id: 'org', active: true, owner_user_id: null,
      supplier_id: null, document_type: documentType, active_version_id: 'version-1',
    }] : [],
    exportTemplateVersions: withTemplate ? [{
      id: 'version-1', template_id: 'template-1', org_id: 'org', version: 1,
      approved_by: 'actor', approved_at: '2026-09-01T00:00:00.000Z', contract: CONTRACT,
    }] : [],
    exports: [],
    // The price-list confirmation panel reads these directly, and this is the branch that stands
    // in for `pricelist-A.csv` — the document the sweep actually followed the menu item on.
    priceListDecision: null,
    priceListLines: [],
    priceListPredictions: [],
    actorNames: new Map<string, string>(),
  } as unknown as ReviewSnapshot;
}

function arriveOnExport(input: Parameters<typeof snapshot>[0] & { readOnly?: boolean } = {}) {
  const { readOnly = false, ...rest } = input;
  render(
    <MemoryRouter>
      <DocumentReviewWorkspace
        snapshot={snapshot(rest)}
        actorId="actor"
        onRefetch={async () => true}
        initialPanel="export"
        readOnly={readOnly}
      />
    </MemoryRouter>,
  );
}

/** The sweep's own probe, verbatim: every button on the destination that offers a file. */
const downloadControls = () => screen.queryAllByRole('button', { name: /הורד|ייצוא|CSV|Excel|xlsx/i });

describe('EXP-08 — arriving from a menu item named "ייצוא"', () => {
  it('produces the export control when there is one, and says nothing extra', () => {
    arriveOnExport({ withTemplate: true });

    expect(screen.getByTestId('document-export-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('document-export-unavailable')).toBeNull();
  });

  it('explains, on arrival, that a price list is confirmed rather than exported', () => {
    arriveOnExport({ documentType: 'price_list' });

    // The sweep's finding, exactly: no download control anywhere on the destination.
    expect(downloadControls()).toEqual([]);
    const note = screen.getByTestId('document-export-unavailable');
    expect(note.textContent).toContain('מחירון');
  });

  it('explains, on arrival, that no export template is configured for this document', () => {
    arriveOnExport({ withTemplate: false });

    expect(downloadControls()).toEqual([]);
    expect(screen.getByTestId('document-export-unavailable').textContent).toContain('תבנית');
  });

  it('explains, on arrival, that read-only access cannot produce a file', () => {
    arriveOnExport({ withTemplate: true, readOnly: true });

    expect(downloadControls()).toEqual([]);
    expect(screen.getByTestId('document-export-unavailable').textContent).toContain('קריאה בלבד');
  });

  it('explains, on arrival, that the document has not been interpreted yet', () => {
    arriveOnExport({ interpreted: false });

    expect(downloadControls()).toEqual([]);
    expect(screen.getByTestId('document-export-unavailable').textContent).toContain('עיבוד');
  });

  it('stays silent for a reader who did not ask for the export panel', () => {
    render(
      <MemoryRouter>
        <DocumentReviewWorkspace
          snapshot={snapshot({ documentType: 'price_list' })}
          actorId="actor"
          onRefetch={async () => true}
          initialPanel={null}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('document-export-unavailable')).toBeNull();
  });
});

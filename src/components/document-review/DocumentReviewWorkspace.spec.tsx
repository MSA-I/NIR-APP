// Task D2 — the confidence percentages leave the everyday review screens and land, verbatim, in
// the "פרטים טכניים" disclosure. The owner's words: "אנחנו לא אמורים לראות את כל הprocess של ה-OCR
// עם אחוזי תאימות וכו. המשתמשים הם לא מתכנתים והנתונים הללו רק מבלבלים עוד יותר."
//
// What is asserted here is the *placement*, which model.spec.ts cannot see: that no percentage
// reaches the two panels a reviewer actually reads, that every one of them is still present inside
// a disclosure that starts closed, and that the supplier — the one value carried into a payee
// field — says out loud what a middling grade obliges.
//
// Who this screen is for, since it is the reason the numbers left it: active owner/office document
// reviewers. Neither is an engineer, and the source viewer is not an expert surface.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { ReviewSnapshot } from './model';

// The workspace signs a storage URL on mount. MSW is configured to fail on any unhandled request,
// and this call is not what is under test, so the client is stubbed rather than described.
vi.mock('../../lib/supabase', () => ({
  supabase: {
    // The assessment panel this workspace now renders makes one read on mount. Answering it
    // with an error keeps this spec about what it has always been about — the evidence tables
    // and the staged disclosure — while leaving no unhandled rejection behind.
    rpc: async () => ({ data: null, error: { message: 'not mocked in this spec' } }),
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: 'https://files.example.test/source' }, error: null }),
      }),
    },
  },
}));

import { DocumentReviewWorkspace } from './DocumentReviewWorkspace';

/** Distinct percentages on purpose: each one can be located and attributed on its own. */
function snapshotWith(supplierConfidence: number | null): ReviewSnapshot {
  return {
    documentId: 'document',
    stage: 'review',
    document: {
      id: 'document',
      file_name: 'invoice.png',
      mime_type: 'image/png',
      storage_path: 'org/invoice.png',
      document_kind: 'invoice',
    },
    job: {
      id: 'job-1',
      status: 'review',
      last_error_message: null,
    },
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
        blocks: [
          { id: 'block-1', page: 1, type: 'text', bbox: [0, 0.26, 1, 0.3], text: 'ספק בע״מ', confidence: 0.71 },
        ],
        tables: [],
        marks: [
          { id: 'mark-1', page: 1, kind: 'check', bbox: [0.1, 0.4, 0.2, 0.5], nearby_block_ids: [], confidence: 0.55, fingerprint: null },
        ],
      },
    },
    extractions: [],
    interpretation: {
      id: 'interpretation-1',
      org_id: 'org',
      document_id: 'document',
      provider: 'openai',
      model: 'gpt-4o-mini',
      prompt_version: '3',
      schema_version: '1',
      suggested_supplier_id: 'supplier',
      payload: {
        schema_version: '1',
        document_type: 'invoice',
        document_type_confidence: 0.87,
        supplier: { suggested_id: null, suggested_name: 'ספק בע״מ', confidence: supplierConfidence, evidence_block_ids: ['block-1'] },
        fields: [{ key: 'invoice_number', value: 'INV-1042', confidence: 0.93, evidence_block_ids: ['block-1'] }],
        line_items: [],
        suggested_annotations: [],
      },
    },
    interpretations: [],
    annotations: [],
    ruleApplications: [],
    learningRules: [],
    reviewCorrections: [],
    typeReviewDecisions: [],
    filings: [],
    feedback: [],
    exportTemplates: [],
    exportTemplateVersions: [],
    exports: [],
    actorNames: new Map<string, string>(),
  } as unknown as ReviewSnapshot;
}

const renderWorkspace = (supplierConfidence: number | null) => render(
  <MemoryRouter>
    <DocumentReviewWorkspace
      snapshot={snapshotWith(supplierConfidence)}
      actorId="actor"
      onRefetch={async () => true}
      initialPanel={null}
    />
  </MemoryRouter>,
);

const technicalDetails = () => screen.getByText('פרטים טכניים').closest('details') as HTMLDetailsElement;

/**
 * Open it the way a reviewer does. The contents do not exist until then — the rows are one per
 * block and mark across the whole document, so they are built on demand rather than rendered and
 * re-diffed behind a shut disclosure on every workspace interaction.
 */
async function openTechnicalDetails() {
  await userEvent.click(screen.getByText('פרטים טכניים'));
  return technicalDetails();
}

describe('confidence leaves the review screens and stays inside the disclosure', () => {
  it('prints no percentage in the two panels a reviewer reads', () => {
    renderWorkspace(0.62);

    // The proposals panel is what the bookkeeper actually reads. Every confidence on it used to be
    // "רמת ביטחון NN%". Neither the old wording nor the number may survive there — this is the
    // assertion that fails if confidenceLabel regresses.
    const proposals = within(screen.getByTestId('document-review-proposals'));
    expect(proposals.queryByText(/רמת ביטחון/)).toBeNull();
    // The fixture's block and mark confidences, by value: 0.71 and 0.55.
    expect(proposals.queryByText(/71%/)).toBeNull();
    expect(proposals.queryByText(/55%/)).toBeNull();
    expect(proposals.queryByText(/\d+%/)).toBeNull();

    // The source viewer went further than losing its percentages: it lost the whole extraction.
    // An earlier round let page coordinates stay, on the argument that a coordinate is a
    // measurement the reviewer can check. The owner overruled it looking at the screen — "בפירוש
    // אין צורך לראות את הקווים הכחולים הללו" — so the surface now carries no engine output at all,
    // and the blunt assertion is the one that matches the rule.
    const viewer = within(screen.getByTestId('document-source-viewer'));
    expect(viewer.queryByText(/\d+%/)).toBeNull();
    expect(viewer.queryByText(/מיקום בעמוד|פרוס על פני כל העמוד/)).toBeNull();
    expect(viewer.queryByText(/זוהה בבירור|לא ודאי|רמת הזיהוי אינה ידועה/)).toBeNull();
    expect(screen.queryByTestId('document-annotations-keyboard')).toBeNull();

    // The grade itself is present and verbal, where the decision is actually made.
    expect(proposals.getAllByText(/זוהה בבירור/).length).toBeGreaterThan(0);
  });

  it('keeps every number, closed by default, inside פרטים טכניים', async () => {
    renderWorkspace(0.62);

    // Collapsed: the reviewer who does not want the machine never meets it — and while it is shut
    // the rows are not built at all, which is what keeps a long price list from paying for them.
    expect(technicalDetails().open).toBe(false);
    expect(screen.queryByText('87%')).toBeNull();

    const disclosure = within(await openTechnicalDetails());
    expect(technicalDetails().open).toBe(true);

    // Present and reachable in one click — document type, supplier, field, block, mark.
    expect(disclosure.getByText('87%')).toBeInTheDocument();
    expect(disclosure.getByText('62%')).toBeInTheDocument();
    expect(disclosure.getByText('93%')).toBeInTheDocument();
    expect(disclosure.getByText('71%')).toBeInTheDocument();
    expect(disclosure.getByText('55%')).toBeInTheDocument();
    // Evidence identifiers travel with them, or the number cannot be traced back to anything.
    expect(disclosure.getAllByText('block-1').length).toBeGreaterThan(0);
    expect(disclosure.getByText('mark-1')).toBeInTheDocument();
  });

  it('shows — for a confidence the contract never carried, never a fabricated 0%', async () => {
    renderWorkspace(null);
    const disclosure = within(await openTechnicalDetails());
    expect(disclosure.getAllByText('—').length).toBeGreaterThan(0);
    expect(disclosure.queryByText('0%')).toBeNull();
  });
});

describe('the supplier match is graded like the rest and obliges more than the rest', () => {
  it('states the check when the match is not clear', () => {
    renderWorkspace(0.62);
    expect(screen.getByText(/יש לאמת את שם הספק מול המסמך/)).toBeInTheDocument();
  });

  it('states it for an unknown match too — absence is the reason to check, not a pass', () => {
    renderWorkspace(null);
    expect(screen.getByText(/יש לאמת את שם הספק מול המסמך/)).toBeInTheDocument();
  });

  it('stays quiet when the supplier was read clearly', () => {
    renderWorkspace(0.95);
    expect(screen.queryByText(/יש לאמת את שם הספק מול המסמך/)).toBeNull();
  });
});

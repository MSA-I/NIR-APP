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

/**
 * One state, one sentence.
 *
 * Every case below was on screen at the same time for a document that was merely queued: the
 * lifecycle strip, the badge, a note saying the screen was read-only, and a note promising an
 * update — four surfaces, four wordings, one fact. Two of them also outlived the fact itself,
 * because neither was gated on the job having stopped or having finished.
 *
 * `created_at` is relative to `Date.now()` on purpose: `DocumentProcessingProgress` reads the wall
 * clock when the workspace does not pass it one, and a fixed timestamp would drift across the
 * two-hour stuck threshold and turn a green suite red at a particular time of day. That has
 * already happened once in CI, which is why the strip takes a `now` at all.
 */
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

function withJob(job: Record<string, unknown>, mutate?: (snapshot: ReviewSnapshot) => void): ReviewSnapshot {
  const snapshot = snapshotWith(0.95);
  snapshot.job = job as unknown as ReviewSnapshot['job'];
  snapshot.extraction = null;
  snapshot.interpretation = null;
  mutate?.(snapshot);
  return snapshot;
}

const READING = {
  id: 'job-1',
  status: 'leased',
  attempt_count: 1,
  created_at: secondsAgo(90),
  updated_at: secondsAgo(5),
  lease_until: new Date(Date.now() + 60_000).toISOString(),
  last_error_code: null,
  last_error_message: null,
  progress_done: 3,
  progress_total: 12,
};

const renderSnapshot = (snapshot: ReviewSnapshot) => render(
  <MemoryRouter>
    <DocumentReviewWorkspace snapshot={snapshot} actorId="actor" onRefetch={async () => true} initialPanel={null} />
  </MemoryRouter>,
);

describe('a document being read makes exactly one claim that it is being read', () => {
  it('prints the page counter once — the strip owns it, the badge does not repeat it', () => {
    const snapshot = withJob(READING);
    snapshot.stage = 'processing';
    renderSnapshot(snapshot);

    // The strip's own line, and the accessible name of its bar. `DocumentStatusBadge` renders the
    // very same string from `progressLabel` for the folder and the upload centre, which have no
    // strip; here that made "עמוד 3 מתוך 12" appear twice, a few pixels apart, from two files.
    expect(screen.getAllByText('עמוד 3 מתוך 12')).toHaveLength(1);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'עמוד 3 מתוך 12');
    expect(document.querySelectorAll('[data-document-status-progress]')).toHaveLength(0);
  });

  it('leaves the strip as the only surface saying work is under way', () => {
    const snapshot = withJob(READING);
    snapshot.stage = 'processing';
    renderSnapshot(snapshot);

    expect(screen.getByRole('list', { name: 'שלבי התהליך' })).toBeInTheDocument();
    // The three that used to stand beside it.
    expect(screen.queryByText('בעיבוד')).toBeNull();
    expect(screen.queryByText(/מוצג כרגע לקריאה בלבד/)).toBeNull();
    expect(screen.queryByText(/החילוץ עדיין אינו זמין/)).toBeNull();
  });
});

describe('a job that stopped is not also promised an update', () => {
  it('shows the stuck alert without a sentence saying the screen will update by itself', () => {
    const snapshot = withJob({
      ...READING,
      attempt_count: 9,
      created_at: secondsAgo(3 * 60 * 60),
      updated_at: secondsAgo(3 * 60 * 60),
      lease_until: secondsAgo(60 * 60),
      progress_done: null,
      progress_total: null,
    });
    snapshot.stage = 'processing';
    renderSnapshot(snapshot);

    // The alert names the next move, not the heuristic that produced the verdict — the reason
    // itself already reaches the badge through documentUiStatus.
    expect(screen.getByText(/העיבוד נעצר/)).toBeInTheDocument();
    expect(screen.getByText('עיבוד תקוע')).toBeInTheDocument();
    // The old condition was `job && !extraction && stage !== 'failed'` — true of a stuck job, so
    // the alert and "המסך יתעדכן כאשר תתקבל תוצאה" were rendered one under the other.
    expect(screen.queryByText(/המסך יתעדכן כאשר תתקבל תוצאה/)).toBeNull();
  });

  it('does not claim an interpretation is under way on a document already waiting for review', () => {
    const snapshot = snapshotWith(0.95);
    snapshot.interpretation = null;
    snapshot.job = { id: 'job-1', status: 'review', last_error_message: null } as unknown as ReviewSnapshot['job'];

    renderSnapshot(snapshot);

    // The old condition was `extraction && !interpretation && stage !== 'failed'`, which is true
    // of a document that reached review without one — the extraction is in, nothing is running,
    // and the sentence said the opposite.
    expect(screen.queryByText(/הפירוש הסמנטי עדיין בעיבוד/)).toBeNull();
    expect(screen.getByText('נדרשת בדיקה')).toBeInTheDocument();
  });
});

describe('one level-one heading per screen', () => {
  it('leaves the h1 to the page and names its own card instead', () => {
    const snapshot = withJob(READING);
    snapshot.stage = 'processing';
    renderSnapshot(snapshot);

    // `DocumentReview` renders <h1>בדיקת מסמך</h1> above this component, and renders it even while
    // a scan is still pending and this component does not mount. Two of them on one page is a
    // WCAG 2.1 AA defect against PRODUCT.md's target.
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'מצב המסמך' })).toBeInTheDocument();
  });
});

describe('שחזור מסמך שנכשל', () => {
  it('מציג עיבוד מחדש ומעביר את הפעולה לבעל המסך', async () => {
    const failed = snapshotWith(0.95);
    failed.stage = 'failed';
    failed.job = { ...failed.job!, status: 'failed', last_error_message: 'provider failed' };
    const onReprocess = vi.fn();
    render(
      <MemoryRouter>
        <DocumentReviewWorkspace
          snapshot={failed}
          actorId="actor"
          onRefetch={async () => true}
          initialPanel={null}
          onReprocess={onReprocess}
        />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'עיבוד מחדש' }));
    expect(onReprocess).toHaveBeenCalledOnce();
  });
});

/**
 * What a phone meets first on a review screen.
 *
 * Below `xl` the two columns collapse into one, and the source viewer is a full-width page image
 * with no height cap — roughly 750px of scan at 428px wide. Opening an invoice review used to mean
 * scrolling past all of it before the first word about what the machine concluded. The decision
 * column now comes first visually for every document kind, which is the treatment the price list
 * already had; DOM order is untouched, so the reading order a screen reader follows is unchanged
 * and the source is still one scroll away, on the same screen.
 */
describe('בצר — ההחלטה לפני הראיה', () => {
  it('מסדר את עמודת ההחלטה ראשונה מתחת ל-xl ומחזיר את הסדר המקורי ברוחב מלא', () => {
    renderWorkspace(0.94);

    const source = screen.getByTestId('document-source-viewer').parentElement!;
    const decision = screen.getByTestId('document-review-proposals').parentElement!;

    expect(source.className).toContain('order-2');
    expect(source.className).toContain('xl:order-1');
    expect(decision.className).toContain('order-1');
    expect(decision.className).toContain('xl:order-2');
    // DOM order is the thing that did not move: source first, exactly as before.
    expect(source.compareDocumentPosition(decision) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

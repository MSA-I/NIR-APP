import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { DocumentPacketSegment, DocumentProcessingSnapshot } from '../../lib/useDocumentProcessing';

const rpc = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
vi.mock('../../lib/supabase', () => ({
  supabase: { rpc, functions: { invoke } },
}));

import { DocumentPacketReview } from './DocumentPacketReview';

type SegmentSeed = Partial<Pick<DocumentPacketSegment,
  'start_page' | 'end_page' | 'document_type' | 'confidence' | 'child_document_id'>>;

function segment(ordinal: number, seed: SegmentSeed): DocumentPacketSegment {
  const childDocumentId = seed.child_document_id ?? null;
  return {
    id: `segment-${ordinal}`, org_id: 'org-1', unit_id: null, packet_id: 'packet-1', ordinal,
    start_page: seed.start_page ?? ordinal * 2 - 1,
    end_page: seed.end_page ?? ordinal * 2,
    document_type: seed.document_type ?? 'invoice',
    confidence: seed.confidence ?? 0.97,
    child_document_id: childDocumentId,
    storage_path: childDocumentId ? `org-1/child-${ordinal}.pdf` : null,
    created_at: '2026-08-17T00:00:00Z',
    materialized_at: childDocumentId ? '2026-08-17T00:00:00Z' : null,
  };
}

function packetSnapshot({
  status = 'needs_review',
  segments = [segment(1, { confidence: 0.97, document_type: 'delivery_note' }), segment(2, { confidence: 0.96 })],
  sourcePartial = false,
  pageCount,
}: {
  status?: 'needs_review' | 'approved' | 'materialized';
  segments?: DocumentPacketSegment[];
  sourcePartial?: boolean;
  pageCount?: number;
} = {}): DocumentProcessingSnapshot {
  return {
    documentId: 'parent-document',
    stage: 'review',
    document: {
      id: 'parent-document', org_id: 'org-1', unit_id: null, entity_type: 'inbox',
      entity_id: null, storage_path: 'org-1/source.pdf', file_name: 'source.pdf',
      mime_type: 'application/pdf', document_kind: 'other', uploaded_by: 'owner-1',
      supplier_id: null, document_date: null, deleted_at: null, created_at: '2026-08-17T00:00:00Z',
    },
    job: null, jobs: [], extraction: null, extractions: [], interpretation: null,
    interpretations: [], annotations: [], ruleApplications: [], learningRules: [],
    reviewCorrections: [], typeReviewDecisions: [], filings: [], feedback: [],
    exportTemplates: [], exportTemplateVersions: [], exports: [], actorNames: new Map(),
    priceListDecision: null, priceListLines: [],
    packet: {
      id: 'packet-1', org_id: 'org-1', unit_id: null, parent_document_id: 'parent-document',
      source_job_id: 'job-1', source_interpretation_id: 'interpretation-1',
      page_count: pageCount ?? segments[segments.length - 1].end_page,
      source_partial: sourcePartial, confidence_threshold: 0.9, automatic_eligible: false,
      status, manifest_hash: 'a'.repeat(64), manifest_version: 1, created_by: 'owner-1',
      approved_by: status === 'needs_review' ? null : 'owner-1',
      approved_at: status === 'needs_review' ? null : '2026-08-17T00:00:00Z',
      approval_reason: status === 'needs_review' ? null : 'אישור בדיקה',
      failure_code: null, failure_message: null, created_at: '2026-08-17T00:00:00Z',
      updated_at: '2026-08-17T00:00:00Z',
    },
    packetSegments: segments,
  } as unknown as DocumentProcessingSnapshot;
}

function renderPacket(snapshot = packetSnapshot(), onRefetch = vi.fn(async () => true)) {
  return {
    onRefetch,
    ...render(<MemoryRouter><DocumentPacketReview snapshot={snapshot} readOnly={false} onRefetch={onRefetch} /></MemoryRouter>),
  };
}

/** The one fold on this panel: everything the classifier was sure about. */
const classifiedFold = () => screen.getByText('עמודים מסווגים').closest('details') as HTMLDetailsElement;

async function openClassified() {
  await userEvent.click(screen.getByText('עמודים מסווגים'));
  return classifiedFold();
}

describe('בדיקת חבילת מסמכים מעורבת', () => {
  beforeEach(() => {
    rpc.mockReset();
    invoke.mockReset();
  });

  it('מאשר manifest מלא, שולח את ה-hash הצפוי ויוצר מסמכי בת', async () => {
    rpc.mockResolvedValueOnce({ data: { status: 'approved' }, error: null });
    invoke.mockResolvedValueOnce({ data: { status: 'materialized' }, error: null });
    const { onRefetch } = renderPacket();

    // Both parts are folded here — the classifier was sure about both. The manifest is built from
    // the draft state, not from what happens to be on screen, so approving without ever opening
    // the fold must still cover every page of the file. That is the assertion this line protects.
    expect(classifiedFold().open).toBe(false);

    await userEvent.type(screen.getByLabelText('הערה ליומן הביקורת — רשות'), 'בדיקה ידנית');
    await userEvent.click(screen.getByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('approve_document_packet', {
      p_packet_id: 'packet-1',
      p_expected_manifest_hash: 'a'.repeat(64),
      p_segments: [
        { ordinal: 1, start_page: 1, end_page: 2, document_type: 'delivery_note', confidence: 0.97 },
        { ordinal: 2, start_page: 3, end_page: 4, document_type: 'invoice', confidence: 0.96 },
      ],
      p_reason: 'בדיקה ידנית',
    }));
    expect(invoke).toHaveBeenCalledWith('interpret-document', { body: { packetId: 'packet-1' } });
    expect(onRefetch).toHaveBeenCalledOnce();
  });

  it('מציג שגיאת stale ואינו מנסה materialization', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'document_packet_stale_context' } });
    renderPacket();
    await userEvent.click(screen.getByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  // CHANGED DELIBERATELY (exception-inbox round): the link used to be on screen unconditionally.
  // A materialised part is a finished result, not a decision, so it now lives inside the same fold
  // as every other confident part — one click, nothing deleted. The count line and the fold's own
  // summary still SAY on the surface that documents were created, which is what "the machine
  // changed something stays visible" actually requires; the link is navigation, not the claim.
  it('מקפל את הקישור למסמך שנוצר אך מודיע עליו בשורת הסיכום', async () => {
    const materialized = packetSnapshot({
      status: 'materialized',
      segments: [
        segment(1, { confidence: 0.97, document_type: 'delivery_note', child_document_id: 'child-1' }),
        segment(2, { confidence: 0.96 }),
      ],
    });
    renderPacket(materialized);

    expect(classifiedFold().open).toBe(false);
    expect(classifiedFold().querySelector('summary')).toHaveTextContent('1 נוצרו');
    expect(screen.queryByRole('link', { name: 'פתיחת המסמך שנוצר' })).toBeNull();

    const fold = within(await openClassified());
    expect(fold.getByRole('link', { name: 'פתיחת המסמך שנוצר' })).toHaveAttribute(
      'href', '/documents/child-1/review',
    );
  });
});

describe('החלוקה בין מה שהמערכת סגרה למה שדורש אדם', () => {
  beforeEach(() => {
    rpc.mockReset();
    invoke.mockReset();
  });

  it('מונה עמודים בשורת הכותרת לפני כל גלילה', () => {
    renderPacket(packetSnapshot({
      pageCount: 6,
      segments: [
        segment(1, { start_page: 1, end_page: 2, confidence: 0.97 }),
        segment(2, { start_page: 3, end_page: 4, confidence: 0.42 }),
        segment(3, { start_page: 5, end_page: 6, confidence: 0.99 }),
      ],
    }));
    const counts = screen.getByTestId('packet-counts');
    expect(counts).toHaveTextContent('6 עמודים');
    expect(counts).toHaveTextContent('4 מסווגים');
    expect(counts).toHaveTextContent('2 דורשים בדיקה');
  });

  it('משאיר פתוח רק את מה שדורש בדיקה ובונה את השאר רק בפתיחה', async () => {
    renderPacket(packetSnapshot({
      pageCount: 6,
      segments: [
        segment(1, { start_page: 1, end_page: 2, confidence: 0.97 }),
        segment(2, { start_page: 3, end_page: 4, confidence: 0.42 }),
        segment(3, { start_page: 5, end_page: 6, confidence: 0.99 }),
      ],
    }));

    // One editor on screen: the part below the packet's own confidence_threshold. The other two
    // are not merely hidden — they are not built, which is the point on a 42-page packet.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(within(screen.getByTestId('packet-attention')).getByText('זיהוי נמוך')).toBeInTheDocument();
    expect(classifiedFold().open).toBe(false);

    await openClassified();
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
  });

  it('דורש בדיקה על "מסמך אחר" גם כשהזיהוי גבוה — סיווג שלא נקבע אינו תשובה', () => {
    renderPacket(packetSnapshot({
      pageCount: 4,
      segments: [
        segment(1, { start_page: 1, end_page: 2, document_type: 'other', confidence: 0.99 }),
        segment(2, { start_page: 3, end_page: 4, confidence: 0.99 }),
      ],
    }));
    expect(within(screen.getByTestId('packet-attention')).getByText('הסוג לא זוהה')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('פותח את כל החלקים כשהחילוץ חלקי — אין מה לקפל כשלא נקרא כל הקובץ', () => {
    renderPacket(packetSnapshot({
      sourcePartial: true,
      pageCount: 4,
      segments: [
        segment(1, { start_page: 1, end_page: 2, confidence: 0.99 }),
        segment(2, { start_page: 3, end_page: 4, confidence: 0.99 }),
      ],
    }));
    expect(screen.queryByText('עמודים מסווגים')).toBeNull();
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect(screen.getAllByText('החילוץ חלקי')).toHaveLength(2);
    expect(screen.getByTestId('packet-counts')).toHaveTextContent('4 דורשים בדיקה');
  });

  it('שולח גם חלק שנשאר מקופל אחרי עריכה של חלק פתוח', async () => {
    rpc.mockResolvedValueOnce({ data: { status: 'approved' }, error: null });
    invoke.mockResolvedValueOnce({ data: { status: 'materialized' }, error: null });
    renderPacket(packetSnapshot({
      pageCount: 4,
      segments: [
        segment(1, { start_page: 1, end_page: 2, document_type: 'other', confidence: 0.99 }),
        segment(2, { start_page: 3, end_page: 4, confidence: 0.99 }),
      ],
    }));

    await userEvent.selectOptions(screen.getByRole('combobox'), 'invoice');
    await userEvent.click(screen.getByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('approve_document_packet', expect.objectContaining({
      p_segments: [
        { ordinal: 1, start_page: 1, end_page: 2, document_type: 'invoice', confidence: 0.99 },
        { ordinal: 2, start_page: 3, end_page: 4, document_type: 'invoice', confidence: 0.99 },
      ],
    })));
    // The corrected part does not jump into the fold under the cursor: the split is graded against
    // what the machine stored, not against the draft being edited.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });
});

/**
 * The split screen on a phone: N part editors, each with two number fields and a type select, and
 * one button at the end of them that finishes the job. `editable` and `canMaterialize` are two
 * different packet statuses, so the bar never holds two actions at once.
 */
describe('בטלפון — הכפתור שמסיים את הפיצול נוסע עם החלקים', () => {
  beforeEach(() => {
    rpc.mockReset();
    invoke.mockReset();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  });
  afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

  it('מציג את "אישור הפיצול" בסרגל מוצמד, פעם אחת, מעל מרווח בסוף המסמך', () => {
    renderPacket();

    const cta = screen.getByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' });
    expect(screen.getAllByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' })).toHaveLength(1);
    expect(screen.getByTestId('sticky-primary-action')).toContainElement(cta);
    expect(document.body.lastElementChild)
      .toBe(screen.getByTestId('sticky-primary-action-clearance'));
  });

  it('בחבילה שכבר אושרה הסרגל נושא את יצירת המסמכים — ולא שתי פעולות', () => {
    renderPacket(packetSnapshot({ status: 'approved' }));

    const sticky = screen.getByTestId('sticky-primary-action');
    expect(within(sticky).getAllByRole('button')).toHaveLength(1);
    expect(within(sticky).getByRole('button', { name: 'יצירת המסמכים הנפרדים' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' })).toBeNull();
  });

  it('חבילה שהפיצול שלה הושלם אינה מקבלת פס פעולה ריק', () => {
    renderPacket(packetSnapshot({ status: 'materialized' }));

    expect(screen.queryByTestId('sticky-primary-action')).toBeNull();
    expect(screen.queryByTestId('sticky-primary-action-clearance')).toBeNull();
  });
});

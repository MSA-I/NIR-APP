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

/** Everything the classifier was sure about — folded to a counted line by default. */
const classifiedFold = () => screen.getByTestId('packet-classified') as HTMLDetailsElement;
/** What still needs a person — open by default, and foldable by the reviewer himself. */
const attentionFold = () => screen.getByTestId('packet-attention') as HTMLDetailsElement;

async function openClassified() {
  await userEvent.click(screen.getByText('עמודים מסווגים'));
  return classifiedFold();
}

/** Twenty-four parts the machine was sure about — the owner's packet, in the shape he sent it. */
function confidentSegments(count: number): DocumentPacketSegment[] {
  return Array.from({ length: count }, (_, index) =>
    segment(index + 1, { start_page: index + 1, end_page: index + 1, confidence: 0.99 }));
}

/** What the panel actually builds: one editor is two number fields and one 8-option select. */
function census() {
  return {
    editors: screen.queryAllByRole('combobox').length,
    numberFields: screen.queryAllByRole('spinbutton').length,
    options: document.querySelectorAll('option').length,
  };
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

  // CHANGED DELIBERATELY (owner report, 18.08.2026). `source_partial` used to be the first
  // attention test, so it graded every part as an exception and no packet ever folded. It is a fact
  // about the FILE: it is now said once, at the top, and the parts are graded on their own reading.
  it('אומר שהחילוץ חלקי פעם אחת בראש הפאנל, ולא כתג על כל חלק', () => {
    renderPacket(packetSnapshot({
      sourcePartial: true,
      pageCount: 4,
      segments: [
        segment(1, { start_page: 1, end_page: 2, confidence: 0.99 }),
        segment(2, { start_page: 3, end_page: 4, confidence: 0.99 }),
      ],
    }));

    expect(screen.getAllByText(/לא כל הקובץ נקרא/)).toHaveLength(1);
    expect(screen.queryByTestId('packet-attention')).toBeNull();
    expect(classifiedFold().open).toBe(false);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.getByTestId('packet-counts')).not.toHaveTextContent('דורשים בדיקה');
  });

  /**
   * Two limits, two sentences, and they are no longer the same number.
   *
   * The single sentence they shared — „החילוץ חלקי או ארוך מ־20 עמודי OCR” — was read by the owner
   * as a claim about reading quality on a document that had been read perfectly, and after
   * migration 0144 it was also simply wrong: it refused a 21–40 page packet the server accepts.
   */
  it('חבילה של 24 עמודים אינה מקבלת יותר אזהרת אורך — 0144 העלה את התקרה ל-40', () => {
    renderPacket(packetSnapshot({ pageCount: 24, segments: confidentSegments(24) }));

    expect(screen.queryByText(/מעל.*תקרת הפיצול האוטומטי/)).toBeNull();
    expect(screen.queryByText(/עמודי OCR/)).toBeNull();
    expect(screen.getByTestId('packet-counts')).toHaveTextContent('24 עמודים');
  });

  it('קובץ ארוך מ-40 עמודים מקבל אמירה על אורך בלבד — לא על איכות הקריאה', () => {
    renderPacket(packetSnapshot({ pageCount: 48, segments: confidentSegments(48) }));

    const length = screen.getByText(/מעל.*תקרת הפיצול האוטומטי/);
    expect(length).toHaveTextContent('40');
    expect(length).toHaveTextContent('זו אמירה על אורך הקובץ, לא על איכות הקריאה');
    expect(screen.queryByText(/לא כל הקובץ נקרא/)).toBeNull();
  });

  it('כששני התנאים חלים — שתי אמירות נפרדות, שני מספרים שונים', () => {
    renderPacket(packetSnapshot({ pageCount: 48, segments: confidentSegments(48), sourcePartial: true }));

    // Coverage: the paid-OCR cap, which did NOT move in 0144.
    const coverage = screen.getByText(/לא כל הקובץ נקרא/);
    expect(coverage).toHaveTextContent('20');
    // Length: the split ceiling, which did.
    const length = screen.getByText(/מעל.*תקרת הפיצול האוטומטי/);
    expect(length).toHaveTextContent('40');
    expect(coverage).not.toBe(length);
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
 * The owner's packet: 24 parts, every one of them read at 0.99. What he got was 24 open editors,
 * because `source_partial` — true on every document the worker has produced — was graded per part.
 *
 * The counts below are measured, not assumed. Before this round, with `source_partial` true and all
 * 24 parts confident, the panel built 24 editors, 48 number fields and 192 `<option>`s. The numbers
 * asserted here are what it builds now.
 */
describe('חבילה בת 24 חלקים — מה נבנה בפועל', () => {
  beforeEach(() => {
    rpc.mockReset();
    invoke.mockReset();
  });

  for (const sourcePartial of [false, true]) {
    it(`נפתחת מקופלת ובונה אפס עורכים (source_partial=${sourcePartial})`, () => {
      renderPacket(packetSnapshot({ pageCount: 24, segments: confidentSegments(24), sourcePartial }));

      expect(census()).toEqual({ editors: 0, numberFields: 0, options: 0 });
      expect(classifiedFold().open).toBe(false);
      // The fold is not an erasure: the summary carries what the list would have said.
      expect(classifiedFold().querySelector('summary')).toHaveTextContent('עמודים מסווגים');
      expect(classifiedFold().querySelector('summary')).toHaveTextContent('24 חלקים');
    });
  }

  it('פתיחה מלאה בונה את כל 24 העורכים, וקיפול חוזר מפרק אותם', async () => {
    renderPacket(packetSnapshot({ pageCount: 24, segments: confidentSegments(24) }));

    await userEvent.click(screen.getByTestId('packet-fold-all'));
    // 24 editors × (2 number fields + one 8-option select).
    expect(census()).toEqual({ editors: 24, numberFields: 48, options: 192 });

    await userEvent.click(screen.getByTestId('packet-fold-all'));
    expect(census()).toEqual({ editors: 0, numberFields: 0, options: 0 });
  });

  it('שולח את כל 24 החלקים גם כשאיש לא פתח אותם, עם אותו manifest_hash', async () => {
    rpc.mockResolvedValueOnce({ data: { status: 'approved' }, error: null });
    invoke.mockResolvedValueOnce({ data: { status: 'materialized' }, error: null });
    renderPacket(packetSnapshot({ pageCount: 24, segments: confidentSegments(24) }));

    expect(census().editors).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('approve_document_packet', expect.objectContaining({
      p_expected_manifest_hash: 'a'.repeat(64),
    })));
    expect(rpc.mock.calls[0][1].p_segments).toHaveLength(24);
    expect(rpc.mock.calls[0][1].p_segments[23])
      .toEqual({ ordinal: 24, start_page: 24, end_page: 24, document_type: 'invoice', confidence: 0.99 });
  });
});

/**
 * The reviewer's own control over the list, on top of the automatic behaviour rather than instead
 * of it: exceptions still open themselves, and a person looking at 24 parts can still fold or
 * unfold the whole thing without hunting for a toggle on every row.
 */
describe('קיפול ופתיחה ביוזמת הבודק', () => {
  beforeEach(() => {
    rpc.mockReset();
    invoke.mockReset();
  });

  const mixed = () => packetSnapshot({
    pageCount: 6,
    segments: [
      segment(1, { start_page: 1, end_page: 2, confidence: 0.97 }),
      segment(2, { start_page: 3, end_page: 4, confidence: 0.42 }),
      segment(3, { start_page: 5, end_page: 6, confidence: 0.99 }),
    ],
  });

  it('מקפל את הכל בלחיצה אחת, כולל מה שדורש בדיקה, ופותח הכל בלחיצה הבאה', async () => {
    renderPacket(mixed());
    const control = screen.getByTestId('packet-fold-all');

    expect(attentionFold().open).toBe(true);
    expect(classifiedFold().open).toBe(false);
    expect(control).toHaveTextContent('קיפול כל החלקים');
    expect(control).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(control);
    expect(attentionFold().open).toBe(false);
    expect(classifiedFold().open).toBe(false);
    expect(census().editors).toBe(0);
    expect(control).toHaveTextContent('פתיחת כל החלקים');
    expect(control).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(control);
    expect(attentionFold().open).toBe(true);
    expect(classifiedFold().open).toBe(true);
    expect(census().editors).toBe(3);
  });

  it('מצביע על שתי הקבוצות שהוא שולט בהן', () => {
    renderPacket(mixed());
    const controls = screen.getByTestId('packet-fold-all').getAttribute('aria-controls')!.split(' ');
    expect(controls).toHaveLength(2);
    expect(controls).toContain(attentionFold().id);
    expect(controls).toContain(classifiedFold().id);
  });

  it('קיפול ידני אינו משנה את מה שנשלח', async () => {
    rpc.mockResolvedValueOnce({ data: { status: 'approved' }, error: null });
    invoke.mockResolvedValueOnce({ data: { status: 'materialized' }, error: null });
    renderPacket(mixed());

    await userEvent.click(screen.getByTestId('packet-fold-all'));
    expect(census().editors).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('approve_document_packet', expect.objectContaining({
      p_expected_manifest_hash: 'a'.repeat(64),
      p_segments: [
        { ordinal: 1, start_page: 1, end_page: 2, document_type: 'invoice', confidence: 0.97 },
        { ordinal: 2, start_page: 3, end_page: 4, document_type: 'invoice', confidence: 0.42 },
        { ordinal: 3, start_page: 5, end_page: 6, document_type: 'invoice', confidence: 0.99 },
      ],
    })));
  });
});

/**
 * Where the button that ends the job lives: at the head of the parts, in the flow, at every width.
 * It briefly rode in a bar fixed above the phone navigation; that bar came to rest ~6rem off the
 * bottom edge with the list still scrolling underneath it (owner report, 18.08.2026).
 */
describe('מיקום הכפתור שמסיים את הפיצול', () => {
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

  it('יושב לפני רשימת החלקים, פעם אחת, בלי סרגל צף ובלי מרווח מושתל', () => {
    renderPacket(packetSnapshot({ pageCount: 24, segments: confidentSegments(24) }));

    const cta = screen.getByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' });
    expect(screen.getAllByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' })).toHaveLength(1);
    expect(screen.getByTestId('primary-decision')).toContainElement(cta);
    // Before the list, after the counts: the decision the summary line already answered.
    expect(screen.getByTestId('packet-counts').compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cta.compareDocumentPosition(classifiedFold()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing fixed over the page, and nothing appended to `<body>` to make room for it.
    expect(screen.queryByTestId('sticky-primary-action')).toBeNull();
    expect(screen.queryByTestId('sticky-primary-action-clearance')).toBeNull();
    expect(document.querySelector('.phone-taskbar')).toBeNull();
  });

  it('אינו מכסה את השורה האחרונה — הקבוצה האחרונה היא האלמנט האחרון בפאנל', async () => {
    renderPacket(mixedForOverlap());

    await userEvent.click(screen.getByTestId('packet-fold-all'));
    const panel = screen.getByTestId('primary-decision').closest('section')!;
    expect(panel.lastElementChild).toContainElement(classifiedFold());
    expect(panel.lastElementChild).not.toContainElement(screen.getByTestId('primary-decision'));
  });

  it('בחבילה שכבר אושרה אזור ההכרעה נושא את יצירת המסמכים — ולא שתי פעולות', () => {
    renderPacket(packetSnapshot({ status: 'approved' }));

    const decision = screen.getByTestId('primary-decision');
    expect(within(decision).getAllByRole('button')).toHaveLength(1);
    expect(within(decision).getByRole('button', { name: 'יצירת המסמכים הנפרדים' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'אישור הפיצול ויצירת המסמכים' })).toBeNull();
  });

  it('חבילה שהפיצול שלה הושלם אינה מקבלת אזור פעולה ריק', () => {
    renderPacket(packetSnapshot({ status: 'materialized' }));

    expect(screen.queryByTestId('primary-decision')).toBeNull();
    expect(screen.queryByTestId('sticky-primary-action')).toBeNull();
  });
});

function mixedForOverlap() {
  return packetSnapshot({
    pageCount: 6,
    segments: [
      segment(1, { start_page: 1, end_page: 2, confidence: 0.97 }),
      segment(2, { start_page: 3, end_page: 4, confidence: 0.42 }),
      segment(3, { start_page: 5, end_page: 6, confidence: 0.99 }),
    ],
  });
}

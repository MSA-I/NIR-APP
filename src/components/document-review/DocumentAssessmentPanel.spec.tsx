// The received-document check, read as an exception inbox.
//
// What is asserted here is placement, which assessment.spec.ts cannot see: that a blocking finding
// and the approve button are both reachable without scrolling past the machine's working, that the
// reconciliation table is folded AND not built while folded, and that nothing which carries a
// business claim — a blocking finding, ordered goods missing from the document — was folded away
// to buy the quiet.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssessmentLine, DocumentReviewRead } from './assessment';

const rpc = vi.hoisted(() => vi.fn());
/**
 * `from` exists because the mapping card reads the catalogue and the supplier's name. It answers
 * empty on purpose: the empty catalogue IS the new-account case, and the card has to be useful
 * there. What the card does with rows of its own is asserted in DocumentLineMapping.spec.
 */
const from = vi.hoisted(() => vi.fn(() => {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'is']) {
    chain[method] = () => chain;
  }
  chain.range = () => Promise.resolve({ data: [], error: null });
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return chain;
}));
vi.mock('../../lib/supabase', () => ({ supabase: { rpc, from } }));

import { DocumentAssessmentPanel } from './DocumentAssessmentPanel';

function line(index: number, over: Partial<AssessmentLine> = {}): AssessmentLine {
  return {
    line_index: index,
    description: `פריט ${index + 1}`,
    sku: null, barcode: null, product_id: `product-${index}`, product_source: 'catalog',
    quantity: 3, unit: 'יח׳', unit_price: 12, discount_amount: null, vat_rate: 17,
    line_total: 36, normalized_quantity: 3, normalized_unit_price: 12,
    baseline_price: 11, baseline_source: 'price_list', baseline_effective_date: '2026-06-01',
    overcharge_amount: 3, findings: [],
    ...over,
  };
}

function reviewRead(over: Partial<DocumentReviewRead> = {}): DocumentReviewRead {
  return {
    document_id: 'doc-1',
    file_name: 'invoice.pdf',
    document_kind: 'invoice',
    document_type: 'invoice',
    document_date: '2026-08-01',
    file_stored: true,
    data_approved: false,
    interpretation_id: 'interpretation-1',
    supplier_resolution: null,
    order_resolution: null,
    state: 'ready_for_approval',
    assessment: {
      document_type: 'invoice', document_number: 'INV-9', document_date: '2026-08-01',
      supplier_id: 'supplier-1', order_id: 'order-1',
      sources: { document: true, ordered: true, received: true, baseline: true },
      totals: { lines_net: 108, header_net: 108, header_vat: 18.36, header_total: 126.36, overcharge_total: 9 },
      severity: 'warning', approval_blocked: false,
      lines: [line(0), line(1), line(2)],
      order_items: [],
      findings: [
        { code: 'price_above_baseline', severity: 'warning', message: 'מחיר גבוה מהמחירון', line_index: 0 },
        { code: 'quantity_above_ordered', severity: 'info', message: 'כמות גבוהה מההזמנה', line_index: 1 },
      ],
    },
    ...over,
  };
}

async function renderPanel(read: DocumentReviewRead = reviewRead()) {
  rpc.mockResolvedValue({ data: read, error: null });
  render(<DocumentAssessmentPanel documentId="doc-1" />);
  return screen.findByRole('button', { name: 'אישור המסמך' });
}

const linesFold = () => screen.getByText('שורות מול המקורות').closest('details') as HTMLDetailsElement;
const advisoryFold = () => screen.getByText('שווה לשים לב').closest('details') as HTMLDetailsElement;

describe('הבדיקה מקפלת את העבודה של המכונה ולא את הממצאים', () => {
  beforeEach(() => rpc.mockReset());

  it('מקפל את טבלת ההשוואה ואינו בונה את השורות לפני פתיחה', async () => {
    await renderPanel();

    expect(linesFold().open).toBe(false);
    // Folded is not enough: 7 columns over a long document is thousands of cells, so the rows must
    // not exist until asked for. No table means no cells were built.
    expect(screen.queryByRole('table')).toBeNull();
    expect(linesFold().querySelector('summary')).toHaveTextContent('3');

    await userEvent.click(screen.getByText('שורות מול המקורות'));
    expect(linesFold().open).toBe(true);
    expect(within(linesFold()).getByRole('table')).toBeInTheDocument();
    expect(within(linesFold()).getByText('פריט 1')).toBeInTheDocument();
  });

  it('מקפל ממצאי מידע ואזהרה מאחורי ספירה, ומצהיר על הכמות בשורת הסיכום', async () => {
    await renderPanel();

    expect(advisoryFold().open).toBe(false);
    expect(advisoryFold().querySelector('summary')).toHaveTextContent('שווה לשים לב');
    expect(advisoryFold().querySelector('summary')).toHaveTextContent('2');
    // A short finding list is cheap to build, so it is folded rather than gated — but it must be
    // INSIDE the fold, not beside it, or the fold claims to hold something it does not.
    expect(screen.getByText(/מחיר גבוה מהמחירון/).closest('details')).toBe(advisoryFold());
    expect(screen.getByText(/כמות גבוהה מההזמנה/).closest('details')).toBe(advisoryFold());

    await userEvent.click(screen.getByText('שווה לשים לב'));
    expect(advisoryFold().open).toBe(true);
  });

  it('משאיר ממצא חוסם פתוח, מעל הכפתור, ולעולם לא בתוך קיפול', async () => {
    await renderPanel(reviewRead({
      state: 'blocked',
      assessment: {
        ...reviewRead().assessment!,
        approval_blocked: true,
        severity: 'error',
        findings: [
          { code: 'duplicate_document', severity: 'error', message: 'מסמך כפול', line_index: null },
          { code: 'price_above_baseline', severity: 'warning', message: 'מחיר גבוה מהמחירון', line_index: 0 },
        ],
      },
    }));

    const blocking = screen.getByRole('alert');
    expect(within(blocking).getByText(/מסמך כפול/)).toBeInTheDocument();
    expect(blocking.closest('details')).toBeNull();

    // The exception, then the decision, then the machine's working. The table used to stand
    // between the finding and the only button on the screen.
    const cta = screen.getByRole('button', { name: 'אישור המסמך' });
    const detail = screen.getByTestId('assessment-detail');
    expect(blocking.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cta.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The button stays live even while blocked — the server is the gate (DESIGN.md).
    expect(cta).toBeEnabled();
  });

  it('נותן לשורה בלי מוצר את כלי המיפוי, מתחת לממצא החוסם ומעל הכפתור', async () => {
    // The tester's case (28.08.2026): an invoice whose items the catalogue does not know. The
    // screen named the problem and offered nothing; the assertion is that the control is now on
    // the same screen, and in the position that makes the finding actionable rather than merely
    // reported.
    await renderPanel(reviewRead({
      state: 'blocked',
      assessment: {
        ...reviewRead().assessment!,
        approval_blocked: true,
        severity: 'error',
        lines: [line(0, { product_id: null, product_source: 'unmatched' }), line(1)],
        findings: [{ code: 'product_unidentified', severity: 'error', message: 'לא ניתן לזהות איזה מוצר זה', line_index: 0 }],
      },
    }));

    const card = await screen.findByTestId('document-line-mapping');
    // One control per UNMATCHED line, not per line: the matched one needs no decision.
    expect(card.querySelectorAll('select')).toHaveLength(1);

    const blocking = screen.getByRole('alert');
    const cta = screen.getByRole('button', { name: 'אישור המסמך' });
    expect(blocking.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('אינו מציג כלי מיפוי כשכל השורות כבר משויכות למוצר', async () => {
    await renderPanel();
    expect(screen.queryByTestId('document-line-mapping')).toBeNull();
  });

  it('מציע לקבוע מחיר מוסכם רק לשורות שאין להן מחיר, ואומר שמחיר קיים לא ישתנה', async () => {
    await renderPanel(reviewRead({
      assessment: {
        ...reviewRead().assessment!,
        lines: [line(0, { baseline_price: null, baseline_source: null }), line(1)],
      },
    }));

    // One product, not two: the second line already has an agreed price and is not offered.
    const seed = screen.getByRole('checkbox');
    expect(seed).toBeChecked();
    const label = seed.closest('label') as HTMLLabelElement;
    expect(label.textContent).toMatch(/מחיר מוסכם קיים לא ישתנה/);
    expect(label.querySelector('.num')).toHaveTextContent('1');
  });

  it('אינו מציע לקבוע מחירים כשלכל השורות כבר יש מחיר מוסכם', async () => {
    await renderPanel();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('משאיר את "מה יקרה באישור" צמוד לכפתור ומחוץ לקיפול', async () => {
    const cta = await renderPanel();
    const effects = screen.getByText('מה יקרה באישור');
    expect(effects.closest('details')).toBeNull();
    expect(effects.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('מציג את חשבונית המקור והיתרה של מסמך זיכוי לפני האישור', async () => {
    await renderPanel(reviewRead({
      document_type: 'credit_note',
      credit_resolution: {
        resolved: true, reason: null, supplier_id: 'supplier-1', invoice_id: 'invoice-1',
        reference_invoice_number: 'INV-1042', amount: 60, candidate_count: 1,
      },
    }));

    expect(screen.getByText('חשבונית המקור לזיכוי')).toBeInTheDocument();
    expect(screen.getByText('INV-1042')).toBeInTheDocument();
    expect(screen.getByText(/60/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'אישור המסמך' })).toBeEnabled();
  });

  it('אינו מקפל סחורה שהוזמנה ואינה מופיעה במסמך — זו טענת מלאי, לא פירוט', async () => {
    await renderPanel(reviewRead({
      assessment: {
        ...reviewRead().assessment!,
        order_items: [{
          purchase_order_item_id: 'poi-1', product_id: 'product-9', product_name: 'קמח',
          ordered_quantity: 10, received_quantity: 0, recorded_received_qty: null,
          unit: 'ק״ג', on_this_document: false,
        }],
      },
    }));

    const missing = screen.getByText('הוזמן ואינו מופיע במסמך הזה:');
    expect(missing.closest('details')).toBeNull();
    expect(screen.getByText(/קמח/)).toBeInTheDocument();
  });
});

/**
 * The same screen on a phone, which is where it is actually used.
 *
 * The approve button sits between „מה יקרה באישור” and the folded working — above the evidence,
 * where this screen chose to put it — at every width. It briefly travelled into a bar fixed above
 * the navigation on a phone; that bar came to rest ~6rem off the bottom edge with content scrolling
 * underneath it, which reads as a slab dropped into the list rather than as a bottom bar (owner
 * report, 18.08.2026). What is asserted here is that there is exactly ONE button, that it stays in
 * the page's own flow, and that nothing is portalled to `<body>` to make room for it.
 */
describe('בטלפון — הפעולה נשארת במקומה בזרימה, ופעם אחת', () => {
  beforeEach(() => {
    rpc.mockReset();
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

  it('מציג את "אישור המסמך" במקומו בזרימה, פעם אחת, בלי סרגל צף ובלי מרווח מושתל', async () => {
    await renderPanel();

    expect(screen.getAllByRole('button', { name: 'אישור המסמך' })).toHaveLength(1);
    const decision = screen.getByTestId('primary-decision');
    expect(decision).toContainElement(screen.getByRole('button', { name: 'אישור המסמך' }));
    // In the card it was written in — not fixed, and not portalled out of it.
    expect(decision.closest('[data-testid="assessment-detail"]')).toBeNull();
    expect(decision.parentElement).not.toBe(document.body);
    expect(screen.queryByTestId('sticky-primary-action')).toBeNull();
    expect(screen.queryByTestId('sticky-primary-action-clearance')).toBeNull();
  });

  it('לוקח את משפט "השרת יבדוק שוב" יחד עם הכפתור, ומשאיר אותו פעיל', async () => {
    await renderPanel(reviewRead({
      state: 'blocked',
      assessment: {
        ...reviewRead().assessment!,
        approval_blocked: true,
        severity: 'error',
        findings: [{ code: 'duplicate_document', severity: 'error', message: 'מסמך כפול', line_index: null }],
      },
    }));

    const cta = screen.getByRole('button', { name: 'אישור המסמך' });
    expect(cta).toBeEnabled();
    const reason = screen.getByText(/השרת יבדוק שוב ויסביר בדיוק מה מונע/);
    // One copy, beside the button and BEFORE it: a reason read after the press is not a reason.
    expect(screen.getAllByText(/השרת יבדוק שוב ויסביר בדיוק מה מונע/)).toHaveLength(1);
    expect(screen.getByTestId('primary-decision')).toContainElement(reason);
    expect(reason.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The blocking finding itself never moved into the bar or into a fold.
    expect(screen.getByRole('alert').closest('details')).toBeNull();
  });

  it('אין אזור פעולה כשאין מה לאשר — מסמך שכבר אושר אינו מקבל פס פעולה ריק', async () => {
    rpc.mockResolvedValue({ data: reviewRead({ data_approved: true }), error: null });
    render(<DocumentAssessmentPanel documentId="doc-1" />);
    expect(await screen.findByText('מה יקרה באישור')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'אישור המסמך' })).toBeNull();
    expect(screen.queryByTestId('primary-decision')).toBeNull();
  });
});

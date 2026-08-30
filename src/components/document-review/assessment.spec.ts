import { describe, expect, it } from 'vitest';
import {
  approvalEffects,
  blockingFindings,
  canSubmit,
  findingLabel,
  formatLineRanges,
  groupFindings,
  priceSeedRows,
  resolutionLabel,
  reviewedProposal,
  storageAndApprovalSentences,
  type DocumentReviewRead,
} from './assessment';

/**
 * These tests guard the two things this screen exists to get right: telling a person what is wrong
 * in words they use, and telling them exactly what the button will and will not do.
 *
 * The effect sentences are pinned against `public.apply_reviewed_document` (0110) as it is actually
 * written. If that command's branches change and these do not, the screen starts promising
 * something the server does not do — which is worse than saying nothing, because the person will
 * have read it and believed it.
 */

const read = (over: Partial<DocumentReviewRead> = {}): DocumentReviewRead => ({
  document_id: 'd1',
  file_name: 'invoice.pdf',
  document_kind: 'invoice',
  document_type: 'invoice',
  document_date: '2026-06-15',
  file_stored: true,
  data_approved: false,
  interpretation_id: 'i1',
  supplier_resolution: null,
  order_resolution: null,
  assessment: null,
  state: 'ready_for_approval',
  ...over,
});

const assessment = (over: Record<string, unknown> = {}) => ({
  document_type: 'invoice',
  currency: 'USD',
  document_number: 'INV-1',
  document_date: '2026-06-15',
  supplier_id: 's1',
  order_id: 'o1',
  sources: { document: true, ordered: true, received: false, baseline: true },
  totals: { lines_net: 20, header_net: 20, header_vat: 3.6, header_total: 23.6, overcharge_total: 0 },
  severity: 'info' as const,
  approval_blocked: false,
  lines: [],
  order_items: [],
  findings: [],
  ...over,
});

describe('storage and approval are two sentences', () => {
  it('never says the data is approved because the file is stored', () => {
    const [stored, approved] = storageAndApprovalSentences(read());
    expect(stored).toContain('הקובץ נשמר');
    expect(approved).toContain('לא אושרו');
    // The failure this guards against is one word covering both. If they ever became the same
    // sentence, a person would walk away believing an invoice was recorded when it is queued.
    expect(stored).not.toBe(approved);
  });

  it('says so plainly once the data really was approved', () => {
    const [, approved] = storageAndApprovalSentences(read({ data_approved: true }));
    expect(approved).toContain('אושרו');
  });
});

describe('approvalEffects mirrors what apply_reviewed_document actually does', () => {
  it('promises an invoice will not receive goods', () => {
    const effects = approvalEffects('invoice', true);
    const negative = effects.filter((effect) => !effect.happens).map((effect) => effect.text);
    expect(negative.join(' ')).toContain('לא ישתנו כמויות שהתקבלו');
    expect(negative.join(' ')).toContain('לא יבוצע תשלום');
    expect(effects.some((effect) => effect.happens && effect.text.includes('התקבלה'))).toBe(true);
  });

  it('says an unlinked invoice is legitimate rather than an error', () => {
    const effects = approvalEffects('invoice', false);
    expect(effects.some((effect) => effect.text.includes('לגיטימי'))).toBe(true);
  });

  it('promises a delivery note only drafts, and names what completes it', () => {
    const effects = approvalEffects('delivery_note', true);
    expect(effects.some((effect) => effect.happens && effect.text.includes('טיוטת'))).toBe(true);
    const negative = effects.filter((effect) => !effect.happens).map((effect) => effect.text).join(' ');
    expect(negative).toContain('מלאי');
    expect(negative).toContain('אישור נפרד');
    // 0110's anchor (c) forbids this command writing a completed receipt at all.
    expect(effects.some((effect) => effect.happens && effect.text.includes('מלאי'))).toBe(false);
  });

  it('promises a receipt creates nothing', () => {
    const effects = approvalEffects('tax_receipt', false);
    const negative = effects.filter((effect) => !effect.happens).map((effect) => effect.text).join(' ');
    expect(negative).toContain('לא תיווצר חשבונית');
    expect(negative).toContain('לא תשלום');
    expect(effects.filter((effect) => effect.happens)).toHaveLength(1);
  });

  it('says an approved credit note records a received credit without offsetting a balance', () => {
    const effects = approvalEffects('credit_note', false);
    expect(effects.some((effect) => effect.happens
      && effect.text.includes('זיכוי') && effect.text.includes('התקבל'))).toBe(true);
    const negative = effects.filter((effect) => !effect.happens).map((effect) => effect.text).join(' ');
    expect(negative).toContain('לא יקוזז');
    expect(negative).toContain('לא יבוצע תשלום');
  });

  it('offers no approval path for a subtype the command does not handle', () => {
    expect(approvalEffects('price_list', false).every((effect) => !effect.happens)).toBe(true);
    expect(approvalEffects(null, false).every((effect) => !effect.happens)).toBe(true);
  });
});

describe('findings', () => {
  it('prefers the server sentence, which carries the numbers', () => {
    expect(findingLabel({ code: 'price_above_baseline', severity: 'error', message: 'המחיר גבוה ב-₪4' }))
      .toBe('המחיר גבוה ב-₪4');
  });

  it('falls back to a label, then to the code itself', () => {
    expect(findingLabel({ code: 'duplicate_document', severity: 'critical' }))
      .toBe('מסמך כפול');
    // Not "unknown error": a code a bookkeeper can read aloud to support is worth more than a
    // sentence that says nothing.
    expect(findingLabel({ code: 'some_future_code', severity: 'error' })).toBe('some_future_code');
  });

  it('puts the hardest blocker first and leaves advisories out of the work list', () => {
    const blocking = blockingFindings(assessment({
      findings: [
        { code: 'price_below_baseline', severity: 'info' },
        { code: 'price_above_baseline', severity: 'error' },
        { code: 'duplicate_document', severity: 'critical' },
        { code: 'receipt_recorded_exception', severity: 'warning' },
      ],
    }) as never);
    expect(blocking.map((finding) => finding.code)).toEqual([
      'duplicate_document', 'price_above_baseline']);
  });
});

describe('reviewedProposal', () => {
  it('sends numbers as strings, so no arithmetic happens in the browser', () => {
    const proposal = reviewedProposal(
      read({ assessment: assessment({
        lines: [{
          line_index: 0, description: 'בשר', sku: 'SKU', barcode: null, product_id: 'p1',
          product_source: 'supplier_sku', quantity: 2, unit: 'kg', unit_price: 20,
          discount_amount: 0, vat_rate: 18, line_total: 40, normalized_quantity: 2,
          normalized_unit_price: 20, baseline_price: 20, baseline_source: 'price_history',
          baseline_effective_date: '2026-01-01', overcharge_amount: null, findings: [],
        }],
      }) as never }),
      's1', 'o1', {});
    expect(proposal.lines[0].quantity).toBe('2');
    expect(proposal.lines[0].unit_price).toBe('20');
    expect(proposal.totals.total).toBe('23.6');
    expect(proposal.currency).toBe('USD');
    expect(typeof proposal.lines[0].line_total).toBe('string');
  });

  it('lets a reviewer edit win over what the machine read', () => {
    const proposal = reviewedProposal(
      read({ assessment: assessment({
        lines: [{
          line_index: 0, description: null, sku: null, barcode: null, product_id: null,
          product_source: 'unmatched', quantity: null, unit: null, unit_price: null,
          discount_amount: 0, vat_rate: null, line_total: null, normalized_quantity: null,
          normalized_unit_price: null, baseline_price: null, baseline_source: null,
          baseline_effective_date: null, overcharge_amount: null, findings: [],
        }],
      }) as never }),
      's1', null, { 0: { product_id: 'p9', quantity: '3' } });
    // The whole point of the reviewer branch in 0110: a line the matcher refuses to guess at is
    // exactly the line a person has to resolve.
    expect(proposal.lines[0].product_id).toBe('p9');
    expect(proposal.lines[0].quantity).toBe('3');
    expect(proposal.order_id).toBeNull();
  });
});

describe('an invoice may fill an empty price list, and may never rewrite a full one', () => {
  const priced = (over: Record<string, unknown>) => ({
    line_index: 0, description: 'עגבניות', sku: null, barcode: null, product_id: 'p1',
    product_source: 'catalog', quantity: 2, unit: 'ק"ג', unit_price: 12,
    discount_amount: 0, vat_rate: 18, line_total: 24, normalized_quantity: 2,
    normalized_unit_price: 12, baseline_price: null, baseline_source: null,
    baseline_effective_date: null, overcharge_amount: null, findings: [],
    ...over,
  });

  it('seeds a product that has no agreed price yet', () => {
    const rows = priceSeedRows(read({ assessment: assessment({ lines: [priced({})] }) as never }), {}, 's1');
    expect(rows).toEqual([{ supplier_id: 's1', product_id: 'p1', price: 12, available: true }]);
  });

  it('leaves an existing agreed price alone — it is the comparison the variance check needs', () => {
    // This is the assertion that keeps the feature from removing a control. If a document could
    // rewrite `baseline_price`, every invoice would agree with itself and "מחיר מעל המחיר המוסכם"
    // would never fire again.
    const rows = priceSeedRows(
      read({ assessment: assessment({ lines: [priced({ baseline_price: 9 })] }) as never }), {}, 's1');
    expect(rows).toEqual([]);
  });

  it('uses the reviewer mapping, so a line resolved by hand is priced too', () => {
    const rows = priceSeedRows(
      read({ assessment: assessment({ lines: [priced({ product_id: null })] }) as never }),
      { 0: { product_id: 'p9' } }, 's1');
    expect(rows).toEqual([{ supplier_id: 's1', product_id: 'p9', price: 12, available: true }]);
  });

  it('prefers the normalized price, because that is the number a baseline is compared against', () => {
    const rows = priceSeedRows(
      read({ assessment: assessment({ lines: [priced({ unit_price: 120, normalized_unit_price: 12 })] }) as never }),
      {}, 's1');
    expect(rows[0].price).toBe(12);
  });

  it('sends each product once, and nothing at all without a supplier or a usable price', () => {
    const twice = assessment({ lines: [priced({}), priced({ line_index: 1 })] }) as never;
    expect(priceSeedRows(read({ assessment: twice }), {}, 's1')).toHaveLength(1);
    expect(priceSeedRows(read({ assessment: twice }), {}, null)).toEqual([]);
    expect(priceSeedRows(
      read({ assessment: assessment({ lines: [priced({ unit_price: null, normalized_unit_price: null })] }) as never }),
      {}, 's1')).toEqual([]);
    // A zero is not a price a supplier agreed to. It is refused rather than written.
    expect(priceSeedRows(
      read({ assessment: assessment({ lines: [priced({ unit_price: 0, normalized_unit_price: 0 })] }) as never }),
      {}, 's1')).toEqual([]);
  });
});

describe('canSubmit errs toward letting the server decide', () => {
  it('refuses only what it can be certain about', () => {
    expect(canSubmit(read({ interpretation_id: null }), 's1')).toBe(false);
    expect(canSubmit(read(), null)).toBe(false);
    expect(canSubmit(read({ document_type: null }), 's1')).toBe(false);
  });

  it('requires an order for a delivery note, because 0110 does', () => {
    expect(canSubmit(read({
      document_type: 'delivery_note',
      assessment: assessment({ order_id: null }) as never,
    }), 's1')).toBe(false);
    expect(canSubmit(read({
      document_type: 'delivery_note',
      assessment: assessment({ order_id: 'o1' }) as never,
    }), 's1')).toBe(true);
  });

  it('keeps an unresolved credit note in review until the server names one invoice', () => {
    const unresolved = {
      ...read({ document_type: 'credit_note' }),
      credit_resolution: {
        resolved: false, reason: 'ambiguous', supplier_id: 's1', invoice_id: null,
        reference_invoice_number: 'INV-1', amount: 60, candidate_count: 2,
      },
    } as unknown as DocumentReviewRead;
    const resolved = {
      ...unresolved,
      credit_resolution: { ...unresolved.credit_resolution, resolved: true, reason: null,
        invoice_id: 'invoice-1', candidate_count: 1 },
    } as unknown as DocumentReviewRead;

    expect(canSubmit(unresolved, 's1')).toBe(false);
    expect(canSubmit(resolved, 's1')).toBe(true);
  });

  it('does not block an invoice with findings — the server is the gate, not this', () => {
    // Blocking here as well would mean two places decide, and the screen's copy would drift from
    // the command's behaviour. It exists to save a round trip, nothing more.
    expect(canSubmit(read({
      assessment: assessment({ approval_blocked: true }) as never,
    }), 's1')).toBe(true);
  });
});

describe('resolutionLabel', () => {
  it('says what the evidence was, not what the tier is called', () => {
    // The screen used to render the raw token, producing "זוהתה · by_number" on a Hebrew page.
    expect(resolutionLabel('by_number')).toBe('מספר ההזמנה מודפס על המסמך');
    expect(resolutionLabel('tax_id')).toBe('ח.פ / עוסק מורשה תואם');
  });

  it('marks the two inferred tiers as worth verifying', () => {
    // 0120 and 0090 both record that these are safe only because a person confirms them, so the
    // label has to carry that rather than presenting them as settled facts.
    expect(resolutionLabel('by_date_proximity')).toContain('כדאי לוודא');
    expect(resolutionLabel('single_open_order')).toContain('כדאי לוודא');
  });

  it('reads the comma-joined form 0106 produces when two identifiers agree', () => {
    expect(resolutionLabel('barcode,supplier_sku'))
      .toBe('ברקוד מודפס · מק"ט ספק מודפס');
  });

  it('falls back to the token, which support can read aloud, and to null for nothing', () => {
    expect(resolutionLabel('a_tier_this_build_has_not_met')).toBe('a_tier_this_build_has_not_met');
    expect(resolutionLabel(null)).toBeNull();
    expect(resolutionLabel('')).toBeNull();
  });
});

describe('grouping the same complaint about many lines', () => {
  const finding = (code: string, line: number | null, message?: string) => ({
    code, severity: 'error' as const, line_index: line, ...(message ? { message } : {}),
  });

  it('keeps every line number while saying the sentence once', () => {
    const groups = groupFindings([
      finding('product_unmatched', 0),
      finding('product_unmatched', 1),
      finding('price_above_agreement', 8),
      finding('product_unmatched', 3),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].lines).toEqual([1, 2, 4]);
    expect(groups[1].lines).toEqual([9]);
  });

  it('orders groups by first appearance, so the severity sort above it survives', () => {
    const groups = groupFindings([finding('b', 0), finding('a', 1), finding('b', 2)]);
    expect(groups.map((group) => group.finding.code)).toEqual(['b', 'a']);
  });

  it('separates two findings that share a code but not a message', () => {
    const groups = groupFindings([
      finding('line_math', 0, 'סכום השורה אינו שווה לכמות × מחיר'),
      finding('line_math', 1, 'סכום השורה חורג מהעגלה'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('holds a document-level finding with no line at all', () => {
    const groups = groupFindings([finding('supplier_missing', null)]);
    expect(groups[0].lines).toEqual([]);
  });

  it('reads consecutive lines as a range and singles as themselves', () => {
    expect(formatLineRanges([1, 2, 3, 5, 7, 8])).toBe('1–3, 5, 7–8');
    expect(formatLineRanges([4])).toBe('4');
    expect(formatLineRanges([])).toBe('');
  });

  it('sorts and de-duplicates before it counts a run', () => {
    expect(formatLineRanges([3, 1, 2, 2])).toBe('1–3');
  });
});

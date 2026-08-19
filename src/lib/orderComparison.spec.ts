import { describe, expect, it } from 'vitest';
import { compareLine, summarizeComparison, type LineComparison, type OfferQuote } from './orderComparison';

const offer = (supplierId: string, unitPrice: number, minQty: number | null = null): OfferQuote =>
  ({ supplierId, unitPrice, minQty });

/** s1 is cheapest, s2 the runner-up, s3 the outlier nobody should be measured against. */
const three: OfferQuote[] = [offer('s1', 10), offer('s2', 12), offer('s3', 30)];

describe('compareLine', () => {
  it('with a single usable offer there is nothing to compare against', () => {
    expect(compareLine(4, [offer('s1', 10)], 's1')).toEqual({
      status: 'single_offer', savedVsNext: null, extraVsCheapest: null,
    });
  });

  it('with the cheapest selected, the saving is the gap to the runner-up — not to the dearest', () => {
    const result = compareLine(4, three, 's1');
    expect(result.status).toBe('saved');
    // 4 × (12 − 10). The dearest offer would have produced 4 × (30 − 10) = 80.
    expect(result.savedVsNext).toBe(8);
    expect(result.savedVsNext).not.toBe(80);
    expect(result.extraVsCheapest).toBeNull();
  });

  it('with the dearest selected the line is overpaying, measured against the cheapest', () => {
    expect(compareLine(4, three, 's3')).toEqual({
      status: 'overpaying', savedVsNext: null, extraVsCheapest: 80,
    });
  });

  it('a runner-up at the same price is stated as such, never as a saving', () => {
    expect(compareLine(3, [offer('s1', 10), offer('s2', 10)], 's1')).toEqual({
      status: 'same_price', savedVsNext: 0, extraVsCheapest: null,
    });
    // The other half of a tie is not "overpaying by ₪0.00" — it costs exactly the same money.
    expect(compareLine(3, [offer('s1', 10), offer('s2', 10)], 's2').status).toBe('same_price');
  });

  it('an offer the quantity cannot buy is not the baseline', () => {
    // s0 is cheaper but demands 10 units; at qty 4 the real cheapest is s1, so selecting s1 saved.
    const withMinimum = [offer('s0', 5, 10), ...three];
    const result = compareLine(4, withMinimum, 's1');
    expect(result.status).toBe('saved');
    expect(result.savedVsNext).toBe(8);
    // And the same basket at a quantity that clears the minimum flips s1 into overpaying.
    expect(compareLine(10, withMinimum, 's1')).toEqual({
      status: 'overpaying', savedVsNext: null, extraVsCheapest: 50,
    });
  });

  it('no selection, no offers, or a selection outside the usable set has no basis', () => {
    const none = { status: 'no_basis', savedVsNext: null, extraVsCheapest: null };
    expect(compareLine(4, three, null)).toEqual(none);
    expect(compareLine(4, [], 's1')).toEqual(none);
    // Pinned to a supplier whose minimum the line does not meet: blocked, not comparable.
    expect(compareLine(4, [offer('s1', 10), offer('s2', 8, 10)], 's2')).toEqual(none);
  });

  it('unsorted input reaches the same answer as the screen\'s cheapest-first ordering', () => {
    expect(compareLine(4, [offer('s3', 30), offer('s2', 12), offer('s1', 10)], 's1').savedVsNext).toBe(8);
  });

  it('money stays on the integer-hundredths path', () => {
    // 2.5 × 4.03 = 10.075 → 10.08, the half-cent case orderSavings pins.
    expect(compareLine(2.5, [offer('s1', 4.03), offer('s2', 8.03)], 's1').savedVsNext).toBe(10);
  });
});

describe('summarizeComparison', () => {
  const line = (status: LineComparison['status'], savedVsNext: number | null, extraVsCheapest: number | null): LineComparison =>
    ({ status, savedVsNext, extraVsCheapest });

  it('sums savings and overpayments separately, and never nets one against the other', () => {
    expect(summarizeComparison([
      line('saved', 8, null),
      line('saved', 2.5, null),
      line('same_price', 0, null),
      line('overpaying', null, 80),
      line('overpaying', null, 0.25),
    ])).toEqual({ saved: 10.5, extra: 80.25, overpayingCount: 2 });
  });

  it('excludes an overpaying line from the saving', () => {
    const rows = [compareLine(4, three, 's1'), compareLine(4, three, 's3')];
    expect(summarizeComparison(rows)).toEqual({ saved: 8, extra: 80, overpayingCount: 1 });
  });

  it('reports no saving at all when nothing in the basket has a runner-up', () => {
    expect(summarizeComparison([
      line('single_offer', null, null),
      line('no_basis', null, null),
    ])).toEqual({ saved: null, extra: null, overpayingCount: 0 });
    expect(summarizeComparison([])).toEqual({ saved: null, extra: null, overpayingCount: 0 });
  });

  it('a basket that is everywhere tied saved a real zero, not a missing figure', () => {
    expect(summarizeComparison([line('same_price', 0, null)])).toEqual({
      saved: 0, extra: null, overpayingCount: 0,
    });
  });
});

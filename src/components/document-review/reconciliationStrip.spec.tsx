// The reconciliation ladder.
//
// Everything pinned here is a claim about what a NUMBER MEANS, because that is the only thing the
// component can get wrong in a way a reader would act on: a gap of zero says the document
// reconciles, a gap of null says one of its figures was never read, and printing the first where
// the second is true is the failure the constitution's rule about `—` versus `0` describes.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReconciliationStrip } from './ReconciliationStrip';
import type { DocumentAssessment } from './assessment';
import { LocaleProvider } from '../../lib/i18n/LocaleProvider';

type Totals = DocumentAssessment['totals'];

const RECONCILES: Totals = {
  lines_net: 100, lines_discount: 0, header_net: 100, header_vat: 18, header_total: 118,
  computed_total: 118, unexplained_gap: 0, lines_vs_header_gap: 0, overcharge_total: 0,
  line_tolerance: 0.05, document_tolerance: 1, currency: 'ILS', missing_rungs: [],
};

function assessment(totals: Partial<Totals> = {}, findings: DocumentAssessment['findings'] = []): DocumentAssessment {
  return {
    document_type: 'invoice', currency: 'ILS', document_number: 'D-1', document_date: '2026-08-01',
    supplier_id: 's-1', order_id: null,
    sources: { document: true, ordered: false, received: false, baseline: false },
    totals: { ...RECONCILES, ...totals },
    severity: 'info', approval_blocked: false, lines: [], order_items: [], findings,
  } as DocumentAssessment;
}

function show(a: DocumentAssessment | null, onGoToLines?: (lines: number[]) => void) {
  return render(
    <LocaleProvider>
      <ReconciliationStrip ladder={a} onGoToLines={onGoToLines} />
    </LocaleProvider>,
  );
}

describe('the ladder', () => {
  it('renders the rungs the server sent, in the document’s own currency', () => {
    show(assessment());
    expect(screen.getByText('Sum of lines')).toBeInTheDocument();
    expect(screen.getByText('Computed')).toBeInTheDocument();
    expect(screen.getByText('Stated total')).toBeInTheDocument();
    expect(screen.getByText('ILS')).toBeInTheDocument();
  });

  /**
   * THE RULE THIS COMPONENT EXISTS FOR. `computed_total` and `unexplained_gap` come from the
   * server, which rounds them by the currency's minor units — the same rounding that decided
   * whether to block. A component that added `header_net + header_vat` itself would be a second
   * source of truth for money and would be able to disagree with the decision.
   */
  it('never computes the ladder itself', () => {
    const text = readFileSync(
      join(process.cwd(), 'src/components/document-review/ReconciliationStrip.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(text).not.toMatch(/header_net\s*\+\s*header_vat/);
    expect(text).not.toMatch(/header_total\s*-\s*/);
    expect(text).toContain('totals.computed_total');
    expect(text).toContain('totals.unexplained_gap');
  });

  /**
   * A discount subtracts, so it is drawn negative — but the sign is produced by `fmtMoneyExact`
   * rather than typed next to it. A hand-written minus beside a currency string reorders under
   * bidi (the screenshot caught it detached from its digits) and is money shaped outside the one
   * formatter. Zero discount stays zero: `-0` is not a fact about the document.
   */
  it('draws a discount negative through the formatter, and never as minus zero', () => {
    // The formatter emits its own bidi marks (`\u200f`, `\u200e`) and a non-breaking space, which
    // is the whole reason the sign belongs inside it. Strip them to read what a person sees.
    const seen = () => (screen.getByText('Discounts').parentElement?.textContent ?? '')
      .replace(/[\u200e\u200f\u00a0]/g, ' ');

    const { rerender } = show(assessment({ lines_discount: 611.05 }));
    expect(seen()).toContain('-611.05');

    rerender(
      <LocaleProvider>
        <ReconciliationStrip ladder={assessment({ lines_discount: 0 })} />
      </LocaleProvider>,
    );
    expect(seen()).toContain('0.00');
    expect(seen()).not.toContain('-0.00');
  });

  it('says the numbers reconcile when the gap is a measured zero', () => {
    show(assessment());
    expect(screen.getByText(/reconcile within the allowed difference/)).toBeInTheDocument();
  });
});

describe('a gap that is not zero', () => {
  it('shows the amount, and the tolerance the SERVER used', () => {
    show(assessment({ unexplained_gap: 12, header_total: 130 },
      [{ code: 'header_arithmetic_discrepancy', severity: 'error' }]));
    expect(screen.getByText(/does not reconcile/)).toBeInTheDocument();
    expect(screen.getByText(/Checked against a tolerance of/)).toBeInTheDocument();
  });

  /** The classification is the server's finding code read back, not a guess about the cause. */
  it.each([
    ['header_arithmetic_discrepancy', /arithmetic gap/],
    ['header_total_differs_from_lines', /commercial gap/],
    ['credit_required', /Evidence does not match/],
  ])('classifies a %s gap from the code the server raised', (code, sentence) => {
    show(assessment({ unexplained_gap: 12 }, [{ code, severity: 'error' }]));
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  it('offers the lines the finding points at, and hands back zero-based indexes', async () => {
    const user = userEvent.setup();
    const onGoToLines = vi.fn();
    show(assessment({ unexplained_gap: 12 },
      [{ code: 'line_arithmetic_discrepancy', severity: 'error', line_index: 1 }]), onGoToLines);
    await user.click(screen.getByRole('button', { name: /Go to lines/ }));
    expect(onGoToLines).toHaveBeenCalledWith([1]);
  });

  /** A gap inside the tolerance is not an alert: the server did not block on it either. */
  it('stays quiet when the gap is inside the tolerance', () => {
    show(assessment({ unexplained_gap: 0.4 }));
    expect(screen.queryByText(/does not reconcile/)).toBeNull();
    expect(screen.getByText(/reconcile within the allowed difference/)).toBeInTheDocument();
  });
});

describe('a rung that was never read', () => {
  /**
   * The whole point. A dash makes the reader decide whether it means zero; the words do not.
   */
  it('says "not extracted" against the rung, rather than showing a zero', () => {
    show(assessment({ header_vat: null, computed_total: null, unexplained_gap: null, missing_rungs: ['header_vat'] }));
    expect(screen.getAllByText('not extracted').length).toBeGreaterThanOrEqual(1);
  });

  it('refuses to state a gap it cannot derive', () => {
    show(assessment({ header_vat: null, computed_total: null, unexplained_gap: null, missing_rungs: ['header_vat'] }));
    expect(screen.getByText('cannot be calculated')).toBeInTheDocument();
    expect(screen.queryByText(/reconcile within the allowed difference/)).toBeNull();
  });

  it('names a reading gap when nothing else explains it', () => {
    show(assessment({ unexplained_gap: 12, missing_rungs: ['header_vat'] }));
    expect(screen.getByText(/reading gap/)).toBeInTheDocument();
  });

  /** Four missing rungs is not a ladder with holes; it is no ladder. */
  it('renders nothing at all when the document produced no figures', () => {
    const { container } = show(assessment({
      lines_net: null, header_net: null, header_vat: null, header_total: null,
      computed_total: null, unexplained_gap: null,
      missing_rungs: ['lines_net', 'header_net', 'header_vat', 'header_total'],
    }));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the assessment has loaded', () => {
    const { container } = show(null);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the second ladder', () => {
  /**
   * Withholding and what actually landed are NOT extracted by anything today. A zero here would
   * claim the document was read and found to withhold nothing. Merging them into the gap above
   * would make every document in the country read "cannot be calculated".
   */
  it('reports both rungs as not extracted, and never as zero', () => {
    show(assessment());
    expect(screen.getByText('Withholding at source')).toBeInTheDocument();
    expect(screen.getByText('Actually received')).toBeInTheDocument();
    expect(screen.getAllByText('not extracted')).toHaveLength(2);
  });

  it('states in words that it does not touch the gap above', () => {
    show(assessment());
    expect(screen.getByText(/does not affect the gap above/)).toBeInTheDocument();
    // And it did not: the first ladder still reconciles.
    expect(screen.getByText(/reconcile within the allowed difference/)).toBeInTheDocument();
  });
});

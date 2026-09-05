import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrimaryDecision } from './PrimaryDecision';
import { ReconciliationStrip, type LadderSource } from './ReconciliationStrip';
import documentReviewSource from '../../pages/DocumentReview.tsx?raw';

const complete: LadderSource = {
  currency: 'ILS',
  findings: [],
  totals: {
    lines_net: 100,
    lines_discount: 0,
    header_net: 100,
    header_vat: 18,
    header_total: 118,
    computed_total: 118,
    unexplained_gap: 0,
    lines_vs_header_gap: 0,
    overcharge_total: 0,
    line_tolerance: 0.05,
    document_tolerance: 1,
    currency: 'ILS',
    missing_rungs: [],
  },
};

describe('document review layout contract', () => {
  it('gives the primary decision a visible title and visual boundary', () => {
    render(
      <PrimaryDecision label="אישור המסמך">
        <button type="button">אישור</button>
      </PrimaryDecision>,
    );
    const decision = screen.getByTestId('primary-decision');
    expect(screen.getByRole('heading', { name: 'אישור המסמך' })).toBeInTheDocument();
    expect(decision.className).toContain('bg-action-wash');
    expect(decision.className).toContain('border-action-line');
  });

  it('folds only a known, in-tolerance ladder with no missing rung', () => {
    const { container, rerender } = render(<ReconciliationStrip ladder={complete} />);
    expect(container.querySelector('details')).not.toBeNull();
    expect(container.querySelector('details')).not.toHaveAttribute('open');

    rerender(<ReconciliationStrip ladder={{
      ...complete,
      totals: {
        ...complete.totals,
        header_vat: null,
        computed_total: null,
        unexplained_gap: null,
        missing_rungs: ['header_vat'],
      },
    }} />);
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getAllByText(/לא חולץ/).length).toBeGreaterThan(0);

    rerender(<ReconciliationStrip ladder={{
      ...complete,
      totals: { ...complete.totals, unexplained_gap: 10 },
    }} />);
    expect(container.querySelector('details')).toBeNull();
  });

  it('builds the review workspace once, then places it around scan evidence by condition', () => {
    expect(documentReviewSource.match(/<DocumentReviewWorkspace/g)).toHaveLength(1);
  });
});

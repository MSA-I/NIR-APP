// What a figure is measured against.
//
// The dashboard carried three hand-carved comparisons and each spelled its own null handling.
// What is pinned here is the part that was wrong in all three: a percentage with no baseline
// stated, and a missing baseline that looked like "no change" because the chip simply vanished.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PeriodComparison, type ComparisonBasis } from './ui';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

const MTD: ComparisonBasis = {
  currentLabel: '1–17.8',
  previousLabel: '1–17.7',
  partial: true,
  sourceLabel: 'orders that were sent',
  unit: 'money',
  currency: 'ILS',
};

const WHOLE_MONTHS: ComparisonBasis = {
  currentLabel: 'August 2026',
  previousLabel: 'July 2026',
  partial: false,
  sourceLabel: 'invoices on record',
  unit: 'money',
  currency: 'ILS',
};

function show(current: number | null, previous: number | null, basis: ComparisonBasis = MTD) {
  return render(
    <LocaleProvider>
      <PeriodComparison current={current} previous={previous} basis={basis} />
    </LocaleProvider>,
  );
}

describe('PeriodComparison', () => {
  it('states the change and the two periods it is between', () => {
    show(18900, 16875);
    expect(screen.getByText('+12%')).toBeInTheDocument();
    expect(screen.getByText('1–17.8 against 1–17.7')).toBeInTheDocument();
    expect(screen.getByText('orders that were sent')).toBeInTheDocument();
  });

  it('drops the "current" half when both periods are whole', () => {
    show(18900, 16875, WHOLE_MONTHS);
    expect(screen.getByText('against July 2026')).toBeInTheDocument();
  });

  /**
   * THE FAILURE THIS EXISTS FOR. A zero, null or negative baseline has no percentage, and the old
   * code omitted the chip — which a reader takes as "no change". "No basis for comparison" is the
   * true statement, and it is the same rule the constitution states about printing `0`.
   */
  it.each([
    ['null', null],
    ['zero', 0],
    ['negative', -400],
  ])('says so out loud when the baseline is %s, and never prints 0%%', (_label, previous) => {
    const { container } = show(18900, previous);
    expect(screen.getByText('No basis for comparison')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/%/);
  });

  /** A figure that was not measured shows a dash above; a second sentence would repeat it. */
  it('renders nothing when the figure itself is unknown', () => {
    const { container } = show(null, 16875);
    expect(container).toBeEmptyDOMElement();
  });

  it('rounds rather than inventing precision, and marks a fall', () => {
    show(9000, 12000);
    expect(screen.getByText('-25%')).toBeInTheDocument();
  });

  it('reports no change as 0%, which is a measured answer and not a missing one', () => {
    show(12000, 12000);
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.queryByText('No basis for comparison')).toBeNull();
  });

  /**
   * `DESIGN.md:421-423` — a change with no business verdict is neutral ink. More purchasing is
   * neither good nor bad, and the trend hues are business claims.
   */
  it('never wears a trend hue: direction is an arrow, not a colour', () => {
    const { container } = show(18900, 16875);
    const html = container.innerHTML;
    expect(html).not.toMatch(/trend-up-fg|trend-down-fg|text-done-fg|text-alert-fg/);
    expect(html).toMatch(/text-ink-mid/);
  });

  it('puts the percent in an LTR island so RTL does not reorder the sign', () => {
    const { container } = show(18900, 16875);
    expect(container.querySelector('[dir="ltr"]')?.textContent).toBe('+12%');
  });
});

describe('the three dashboard comparisons', () => {
  const dashboard = readFileSync(join(process.cwd(), 'src/pages/Dashboard.tsx'), 'utf8');

  it('all three go through the primitive — none re-derives the arithmetic', () => {
    expect(dashboard).not.toContain('const percentDelta =');
    expect(dashboard).not.toContain('momChange');
    expect(dashboard).not.toContain('function DeltaChip');
    expect(dashboard.match(/<PeriodComparison/g) ?? []).toHaveLength(2); // two call sites, three tiles
  });

  /**
   * `DeltaChip`'s accessible sentence named a FIXED baseline. That was true for its two callers
   * and false for the third comparison on the same screen, which is exactly the kind of thing a
   * shared primitive with an argument prevents.
   */
  it('no longer asserts one fixed baseline for every comparison', () => {
    expect(dashboard).not.toContain('deltaVsPreviousMonth');
  });
});

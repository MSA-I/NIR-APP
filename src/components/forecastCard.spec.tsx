// The scheduled-payments card.
//
// Every assertion here is about the SAME failure: a partial figure read as a cash-flow forecast by
// somebody making a decision. The card can produce that failure in four ways — by showing an
// amount it should not, by showing a zero where it has nothing, by hiding how much of the debt it
// can see, or by calling itself a forecast — and each one is pinned.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForecastCard, amountCoverage, rowState, type OutlookCurrencyRow, type ScheduledPaymentsOutlook } from './ForecastCard';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';
import { he } from '../lib/i18n/dictionaries/he';
import { en } from '../lib/i18n/dictionaries/en';

function row(over: Partial<OutlookCurrencyRow> = {}): OutlookCurrencyRow {
  return {
    currency: 'ILS', amount: 42800, recordCount: 9,
    coveredCount: 9, totalCount: 23, coveredAmount: 90, uncoveredAmount: 10,
    ...over,
  };
}

function outlook(over: Partial<ScheduledPaymentsOutlook> = {}): ScheduledPaymentsOutlook {
  return {
    status: 'measured', horizonDays: 30, horizonEndsAt: '2026-09-30',
    asOf: '2026-08-31T06:00:00Z', byCurrency: [row()], undatedCommitmentsByCurrency: [],
    ...over,
  };
}

function show(value: ScheduledPaymentsOutlook | null, props: Partial<Parameters<typeof ForecastCard>[0]> = {}) {
  return render(
    <LocaleProvider>
      <ForecastCard outlook={value} currency="ILS" locale="en-IL" {...props} />
    </LocaleProvider>,
  );
}

describe('the threshold is coverage by amount, and only by amount', () => {
  /**
   * OWNER RULING #308, and the case that produced it: half the requests dated, ninety-four per
   * cent of the money. A gate on row count would have hidden an almost-exact figure.
   */
  it('shows the amount when the MONEY is covered, even though half the rows are not', () => {
    show(outlook({ byCurrency: [row({ coveredCount: 2, totalCount: 4, coveredAmount: 94, uncoveredAmount: 6 })] }));
    expect(screen.getByText(/42,800/)).toBeInTheDocument();
    expect(screen.queryByText('Not enough data yet')).toBeNull();
  });

  /** And the mirror: most rows dated, most of the money not. No amount. */
  it('withholds the amount when the rows are covered and the money is not', () => {
    show(outlook({ byCurrency: [row({ coveredCount: 9, totalCount: 10, coveredAmount: 30, uncoveredAmount: 70 })] }));
    expect(screen.getByText('Not enough data yet')).toBeInTheDocument();
    expect(screen.queryByText(/42,800/)).toBeNull();
  });

  it('places the boundary at seventy per cent of the money', () => {
    expect(rowState(row({ coveredAmount: 70, uncoveredAmount: 30 }))).toBe('measured');
    expect(rowState(row({ coveredAmount: 69.9, uncoveredAmount: 30.1 }))).toBe('below_threshold');
  });

  /** The literal, so moving the ruling is a one-line edit rather than a migration. */
  it('keeps the threshold as a named constant in this file', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/ForecastCard.tsx'), 'utf8');
    expect(source).toContain('const COVERAGE_THRESHOLD = 0.7;');
  });
});

describe('below the threshold there is a sentence, never a number', () => {
  it('shows no amount and no zero', () => {
    const { container } = show(outlook({
      byCurrency: [row({ amount: 0, recordCount: 0, coveredAmount: 10, uncoveredAmount: 90 })],
    }));
    expect(screen.getByText('Not enough data yet')).toBeInTheDocument();
    // The failure this guards: a card that renders ₪0.00 says nothing is due.
    expect(container.textContent).not.toMatch(/0\.00/);
  });

  /** And it names the one action that changes the state. */
  it('says what would make an amount appear', () => {
    show(outlook({ byCurrency: [row({ coveredAmount: 10, uncoveredAmount: 90 })] }));
    expect(screen.getByText(/add a due date to the open requests/)).toBeInTheDocument();
  });

  /** An empty cohort is not low coverage — there is nothing to be a share OF. */
  it('separates "nothing to measure" from "not enough of it"', () => {
    expect(rowState(row({ totalCount: 0, coveredAmount: 0, uncoveredAmount: 0 }))).toBe('no_data');
    expect(rowState(row({ totalCount: 3, coveredAmount: 0, uncoveredAmount: 0 }))).toBe('no_data');
    expect(amountCoverage(row({ coveredAmount: 0, uncoveredAmount: 0 }))).toBeNull();
    show(outlook({ byCurrency: [row({ totalCount: 0, coveredAmount: 0, uncoveredAmount: 0 })] }));
    expect(screen.getByText('No open requests to measure')).toBeInTheDocument();
  });
});

describe('both coverages are always on screen', () => {
  it('reports the share of the money and the share of the requests', () => {
    show(outlook({ byCurrency: [row({ coveredCount: 9, totalCount: 23, coveredAmount: 90, uncoveredAmount: 10 })] }));
    expect(screen.getByText('Coverage by amount')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('9 of 23')).toBeInTheDocument();
    expect(screen.getByText('(39%)')).toBeInTheDocument();
  });

  /** Confidence is a reading of the same evidence, not a separate opinion. */
  it('states confidence from the coverage it just reported', () => {
    show(outlook({ byCurrency: [row({ coveredAmount: 95, uncoveredAmount: 5 })] }));
    expect(screen.getByText(/most of the money carries a date/)).toBeInTheDocument();
  });

  it('says what is known and admits nothing is estimated', () => {
    show(outlook());
    expect(screen.getByText(/9 known · estimated: none/)).toBeInTheDocument();
  });
});

describe('what the card refuses to do', () => {
  /**
   * THE ACCEPTANCE CRITERION WITH THE SHARPEST EDGE. The word must not reach a reader in either
   * language — not in the card, not in a heading, not in a button, not in the "not enough" line.
   */
  it('never says the word "forecast" in any string a person can read', () => {
    for (const dictionary of [he.scheduled, en.scheduled] as Record<string, string>[]) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(`${key}: ${value}`).not.toMatch(/forecast/i);
        expect(`${key}: ${value}`).not.toContain('תחזית');
      }
    }
  });

  /** `office` is refused in words. Zeros would read as "nothing is due" (DEBT §59). */
  it('renders a refusal rather than an empty measurement', () => {
    const { container } = show({ status: 'not_permitted', reason: 'role_out_of_scope' });
    expect(screen.getByText(/does not have access to this data/)).toBeInTheDocument();
    expect(screen.getByText(/not a claim that nothing is due/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/0\.00/);
  });

  /** One currency at a time, chosen by the reader (#305), and no conversion anywhere. */
  it('renders only the currency it was asked for', () => {
    show(outlook({
      byCurrency: [row({ currency: 'ILS', amount: 42800 }), row({ currency: 'USD', amount: 999 })],
    }), { currency: 'USD' });
    expect(screen.queryByText(/42,800/)).toBeNull();
    expect(screen.getByText(/999/)).toBeInTheDocument();
  });

  /** Undated commitments sit outside the horizon, and the card says so in words. */
  it('keeps open commitments beside the figure rather than inside it', () => {
    show(outlook({ undatedCommitmentsByCurrency: [{ currency: 'ILS', amount: 2000 }] }));
    expect(screen.getByText(/outside the horizon/)).toBeInTheDocument();
    expect(screen.getByText(/42,800/)).toBeInTheDocument();
  });
});

describe('the card is always openable', () => {
  it('offers the records in every state, including below the threshold', async () => {
    const user = userEvent.setup();
    const onOpenRecords = vi.fn();
    show(outlook({ byCurrency: [row({ coveredAmount: 10, uncoveredAmount: 90 })] }), { onOpenRecords });
    await user.click(screen.getByRole('button', { name: 'Go to requests' }));
    expect(onOpenRecords).toHaveBeenCalled();
  });

  it('renders nothing before the outlook has loaded', () => {
    const { container } = show(null);
    expect(container).toBeEmptyDOMElement();
  });
});

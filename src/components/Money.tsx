/**
 * One place that knows how to draw money that may be in more than one currency.
 *
 * WHY A COMPONENT AND NOT A PATTERN PER SCREEN. `OPEN-DECISIONS #277` says a supplier who trades
 * in two currencies has two balances, managed separately. That means roughly a dozen surfaces —
 * the supplier card, the dashboard band, the payment queue, the accountant's totals — each face
 * the same three cases, and each would otherwise invent its own answer to the third one:
 *
 *   NOTHING       an em dash. Never `0`: the constitution says a metric with no data shows `—`,
 *                 because zero is itself a claim about the world ("this supplier owes nothing")
 *                 and an empty list is not that claim.
 *   ONE CURRENCY  exactly what the screen always drew — one figure with its symbol.
 *   TWO OR MORE   one line per currency, the organisation's own currency first and the rest by
 *                 ISO code. Never a total, and never a converted figure: the sum of ₪12,400 and
 *                 $3,100 is not 15,500, it is not a number at all.
 *
 * The order is derived from the data and the organisation, never from the order rows arrived in,
 * so the same balance does not reshuffle between two renders of the same screen.
 */
import { fmtMoneyExact, fmtMoneyRounded } from '../lib/format';
import type { MoneyAmount } from '../lib/types';

/**
 * The organisation's own currency first, then ISO code ascending.
 *
 * `base` is nullable because a screen can render before the organisation row has loaded; the order
 * is then plain alphabetical, which is stable and wrong about nothing.
 */
export function sortByBaseCurrency<T extends { currency: string }>(
  rows: readonly T[],
  base: string | null | undefined,
): T[] {
  return [...rows].sort((a, b) => {
    if (a.currency === b.currency) return 0;
    if (base) {
      if (a.currency === base) return -1;
      if (b.currency === base) return 1;
    }
    return a.currency < b.currency ? -1 : 1;
  });
}

/** Sum a list of per-currency amounts WITHIN each currency. There is no other kind of total. */
export function totalsByCurrency(rows: readonly MoneyAmount[]): MoneyAmount[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount);
  return [...totals].map(([currency, amount]) => ({ currency, amount }));
}

interface MoneyByCurrencyProps {
  amounts: readonly MoneyAmount[] | null | undefined;
  /** The organisation's own currency — display ORDER only, never a conversion target. */
  baseCurrency: string | null | undefined;
  /** `exact` for ledgers and detail, `rounded` for glance surfaces. Same rule as the formatters. */
  shape?: 'exact' | 'rounded';
  className?: string;
  /** What to draw when there is nothing to draw. An em dash unless a screen has a better sentence. */
  empty?: string;
}

export function MoneyByCurrency({
  amounts, baseCurrency, shape = 'exact', className, empty = '—',
}: MoneyByCurrencyProps) {
  const format = shape === 'rounded' ? fmtMoneyRounded : fmtMoneyExact;
  const rows = amounts ? sortByBaseCurrency(amounts, baseCurrency) : [];

  if (rows.length === 0) return <span className={className}>{empty}</span>;
  if (rows.length === 1) {
    return <span className={`num ${className ?? ''}`.trim()}>{format(rows[0].amount, rows[0].currency)}</span>;
  }
  // Two or more: lines, not a joined string. A reader scanning a column has to be able to see that
  // these are separate figures rather than one figure that happens to contain two symbols.
  return (
    <span className={className}>
      {rows.map((row) => (
        <span key={row.currency} className="num block">{format(row.amount, row.currency)}</span>
      ))}
    </span>
  );
}

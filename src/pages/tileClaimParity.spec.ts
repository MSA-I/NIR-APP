import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));

import { monthlySeriesHasObservation } from './Dashboard';
import { DUE_PRESSURE_STATUSES, matchesDueFilter } from './PaymentRequests';
import { lowStockCount } from './Inventory';
import { TO_REVIEW_FILTER } from './Invoices';
import { WITH_SUPPLIER_FILTER } from './Orders';

/**
 * Wave 7, item 2: a tile that says "3" must open a list holding three rows.
 *
 * Seven of the control centre's links opened a screen whose default filter held a different
 * population from the number beside them. Each case below names which side was right — measured
 * against `management_dashboard_snapshot`, which is where these counts are defined — and pins the
 * repair, because both halves are one-line edits that a later change could quietly undo.
 */

const TODAY = '2026-09-03';
const DUE_SOON = '2026-09-09'; // today + 6, the seven-day window INCLUDING today

describe('payment-request due filters exclude drafts, exactly as the snapshot does', () => {
  /**
   * `management_dashboard_snapshot` filters every due-date metric on
   * `status not in ('draft','executed','matched','cancelled')`. The list agreed in its `soon`
   * branch and disagreed in `overdue` and `today`, which used the screen's broad "active" set.
   * The dashboard was right; the list was wrong in two of its three branches.
   */
  const EXCLUDED = ['draft', 'executed', 'matched', 'cancelled'] as const;
  const ALL_STATUSES = [
    'draft', 'pending_approval', 'approved', 'sent_for_execution',
    'executed', 'matched', 'investigation', 'suspected_duplicate', 'cancelled',
  ] as const;

  it('the named set is exactly the complement of the four the server excludes', () => {
    expect([...DUE_PRESSURE_STATUSES].sort())
      .toEqual(ALL_STATUSES.filter((status) => !EXCLUDED.includes(status as never)).sort());
  });

  it.each(['overdue', 'today', 'soon'])('a draft never appears under ?due=%s', (filter) => {
    const draft = { status: 'draft' as const, due_date: filter === 'today' ? TODAY : '2026-07-30' };
    expect(matchesDueFilter(draft, filter, TODAY, DUE_SOON)).toBe(false);
  });

  it('an approved request that is genuinely late does appear', () => {
    expect(matchesDueFilter({ status: 'approved', due_date: '2026-07-20' }, 'overdue', TODAY, DUE_SOON))
      .toBe(true);
  });

  it('due today and due soon read the same statuses as overdue', () => {
    const row = { status: 'suspected_duplicate' as const, due_date: TODAY };
    expect(matchesDueFilter(row, 'today', TODAY, DUE_SOON)).toBe(true);
    expect(matchesDueFilter(row, 'soon', TODAY, DUE_SOON)).toBe(true);
    expect(matchesDueFilter(row, 'overdue', TODAY, DUE_SOON)).toBe(false);
  });

  it('an undated request is in no due window at all — it is not "not yet due"', () => {
    for (const filter of ['overdue', 'today', 'soon']) {
      expect(matchesDueFilter({ status: 'approved', due_date: null }, filter, TODAY, DUE_SOON))
        .toBe(false);
    }
  });

  it('no due filter leaves every row, drafts included', () => {
    expect(matchesDueFilter({ status: 'draft', due_date: null }, '', TODAY, DUE_SOON)).toBe(true);
  });
});

describe('"below minimum" has three states, not two', () => {
  /**
   * Wave 7, item 3. `inventory_balances` returns `is_low_stock = null` for a product that has not
   * been counted or carries no minimum, so counting `=== true` over an all-null set produced `0` —
   * "nothing needs attention" — on a business where nothing has ever been counted.
   */
  it('a measured zero survives: products have verdicts and none is low', () => {
    expect(lowStockCount([{ is_low_stock: false }, { is_low_stock: false }])).toBe(0);
  });

  it('a real count survives', () => {
    expect(lowStockCount([{ is_low_stock: true }, { is_low_stock: false }, { is_low_stock: null }]))
      .toBe(1);
  });

  it('no product carries a verdict → not measured, never zero', () => {
    expect(lowStockCount([{ is_low_stock: null }, { is_low_stock: null }])).toBeNull();
  });

  it('a failed read is not measured either', () => {
    expect(lowStockCount(null)).toBeNull();
  });

  /**
   * Finding 11 of the 03.09.2026 review asked for `—` here, and the answer is no — argued in
   * full on `lowStockCount`. The short form: the em dash marks a question this screen could not
   * answer, and an empty catalogue is one it answered. What made the original defect a lie was a
   * three-valued predicate hiding an uninspected population behind a zero; over an empty set
   * there is no population to hide, and the two segments beside this one compute a true measured
   * zero over the identical set. The one reading that would make it a false clean sheet — rows
   * WITHHELD rather than absent — is closed at the route: `inventory_balances` returns nothing to
   * a role outside `('owner','office')` and `/inventory` admits exactly those two.
   *
   * Kept as its own case, separately from the measured-zero one above, because the two are
   * arrived at for different reasons and a later edit that collapses them should fail here.
   */
  it('an empty catalogue keeps its honest zero', () => {
    expect(lowStockCount([])).toBe(0);
  });

  it('and the screen says WHICH zero it is, rather than leaving the sub-line to imply a stocked business', () => {
    const inventory = readFileSync('src/pages/Inventory.tsx', 'utf8');
    // The figure stays 0; only the sentence under it changes. Pinned as source because the whole
    // difference between "all healthy" and "nothing to check" is which key the ternary picks.
    expect(inventory).toContain('const emptyCatalogue = balances.data != null && balances.data.length === 0;');
    expect(inventory).toContain("emptyCatalogue ? t('inventory.lowStockEmptyCatalogue') : t('inventory.sub_2')");
    // And the value is still the count, not a dash smuggled in through the other side.
    expect(inventory).toContain("value={low == null ? '—' : fmtNum(low)}");
  });
});

describe('the control centre links at the population it counted', () => {
  const dashboard = readFileSync('src/pages/Dashboard.tsx', 'utf8');

  /**
   * Source assertions rather than a render, because these are literal strings in JSX and the
   * failure they guard against is a string being edited back. Each expectation carries the
   * server-side definition it mirrors.
   */
  it.each([
    // `invoices.notSent` is `review_status = 'approved' AND export_status = 'not_sent'`.
    ["'/invoices?export=not_sent&review=approved'", 'invoices awaiting the bookkeeper are approved ones'],
    // `invoices.toReview` counts received AND in_review.
    [`'/invoices?review=${TO_REVIEW_FILTER}'`, 'the review queue is two statuses, not one'],
    // `paymentRequests.drafts` counts drafts; the bare screen opens on every active request.
    ["'/payment-requests?status=draft'", 'the drafts row opens the drafts'],
    // `openOrders` is sent/confirmed/partial; `?status=open` also lists draft and ready orders.
    [`'/orders?status=${WITH_SUPPLIER_FILTER}'`, 'a commitment is an order that left the building'],
    // The tile is labelled "(30 יום)" and the fetch is bounded to thirty days.
    ["'/prices?increases=1&days=30'", 'the price-rise tile carries its own window'],
    // `openOrders.count` is what /receiving queries, and the row is about awaiting goods.
    ["to: '/receiving'", 'the goods-receipt queue opens the goods-receipt screen'],
  ])('%s — %s', (needle) => {
    expect(dashboard).toContain(needle);
  });

  it('no tile still points at the unfiltered screens that contradicted it', () => {
    expect(dashboard).not.toContain("count: queue.prDrafts, to: '/payment-requests'");
    expect(dashboard).not.toContain("count: queue.notSentToAccountant, to: '/invoices?export=not_sent'");
    expect(dashboard).not.toContain("count: queue.invoicesToReview, to: '/invoices?review=received'");
  });
});

describe('every aggregate inside the currency view is taken inside one currency', () => {
  /**
   * Wave 7, item 5 (`R4-04`). `currencyView(viewCurrency)` narrows every row set it reads through
   * `inView`. Four aggregates did not — the two weekly series behind the trend chart and its two
   * sparklines, and the two month-to-date baselines behind the comparison percentages — so they
   * summed shekels and dollars together and then printed the total under whichever currency the
   * picker was on.
   *
   * It was measurable rather than arguable: with the demo organisation's orders and payments all
   * in ILS, the trend chart's ILS and USD renderings had the SAME sha256
   * (`artifacts/w7/screenshots/r4-04-BEFORE-weekly-{ILS,USD}.png`), directly beneath the banner
   * that reads „אין המרה בין מטבעות". After the change the USD view says there is nothing to show,
   * which is the true answer.
   */
  const dashboard = readFileSync('src/pages/Dashboard.tsx', 'utf8');

  it.each([
    'weeklySeries(inView(orders).map',
    'weeklySeries(inView(payments).map',
    'inView(orders).filter((order) => inPreviousMTD',
    'inView(payments).filter((payment) => inPreviousMTD',
  ])('%s', (needle) => {
    expect(dashboard).toContain(needle);
  });

  it('and none of the four reads the unnarrowed array again', () => {
    for (const needle of [
      'weeklySeries(orders.map',
      'weeklySeries(payments.map',
      'orders.filter((order) => inPreviousMTD',
      'payments.filter((payment) => inPreviousMTD',
    ]) {
      // `inView(orders).filter(...)` contains `orders).filter(...)`, so the bare form is matched
      // only where it is NOT preceded by the narrowing call.
      const bare = dashboard.split(needle).length - 1;
      const narrowed = dashboard.split(`inView(${needle}`).length - 1;
      expect(bare - narrowed).toBe(0);
    }
  });

  it('the monthly card no longer asks about every currency at once', () => {
    // The fifth aggregate the R4-04 sweep left behind: the buckets were narrowed, the question
    // "is there anything to draw" was not. Pinned as a string because the whole defect was one
    // identifier — `invoices.length` where `monthBuckets` was meant.
    expect(dashboard).not.toContain('const monthly = invoices.length');
    expect(dashboard).toContain('const monthly = monthlySeriesHasObservation(monthBuckets)');
  });
});

describe('a currency with no invoices in the window draws nothing, not a flat zero line', () => {
  /**
   * Finding 10 of the 03.09.2026 adversarial review, and the fifth instance of the currency rule.
   *
   * `SpendBarChart` branches on `points.length`, so a four-point all-zero series is not "no data"
   * to it — it draws four month names, four gridlines and four bars of height zero. Reproduced in
   * a real browser against the local demo organisation with its USD invoices withheld from the
   * chart read: BEFORE, the USD tab rendered 4 bars and 4 axis ticks; AFTER, 0 bars and the
   * sentence „אין נתוני חשבוניות לתקופה". The ILS control is byte-identical across the two runs
   * (sha256 `107dfb40…`), which is what says the change touched only the case it aimed at.
   * `artifacts/review/shots/finding-10/`, produced by `scripts/currency-empty-series-check.cjs`.
   */
  const bucket = (count: number, total = 0) => ({ count, total });

  it('a month with invoices in it is an observation', () => {
    expect(monthlySeriesHasObservation([bucket(0), bucket(0), bucket(3), bucket(0)])).toBe(true);
  });

  it('four empty buckets are not a measurement of zero spending', () => {
    expect(monthlySeriesHasObservation([bucket(0), bucket(0), bucket(0), bucket(0)])).toBe(false);
  });

  it('an empty window is empty', () => {
    expect(monthlySeriesHasObservation([])).toBe(false);
  });

  it('invoices that sum to zero ARE an observation — count decides, never total', () => {
    // A credited-out month is a real month. The distinction is the same one /inventory makes:
    // "measured, and the answer is zero" is not "nothing was measured".
    expect(monthlySeriesHasObservation([bucket(0), bucket(2, 0), bucket(0), bucket(0)])).toBe(true);
  });
});

describe('the accountant-export status exists on a phone', () => {
  /**
   * Wave 7, item 4. `priority: 3` means "not rendered on mobile" (`ui.tsx` keeps
   * `(priority ?? 2) <= 2` in the card's detail grid). Every other priority-3 column on the
   * invoice list has a mobile home — number and supplier are the card title, payment status is
   * the trailing badge — and this one had none, so the desktop showed it on every row and the
   * phone on none. Measured before the change: 15 badges at 1440px, 0 at 390px.
   */
  const invoices = readFileSync('src/pages/Invoices.tsx', 'utf8');

  it('the export column is not hidden on mobile', () => {
    expect(invoices).toContain(
      "columns.push({ key: 'export', header: t('invoiceList.push'), priority: 2,",
    );
  });

  it('and it keeps its label, because the review badge beside it has none', () => {
    // `mobileLabel` is absent on this column, which is what makes it default to the header.
    const line = invoices.split('\n').find((row) => row.includes("key: 'export', header:"));
    expect(line).toBeDefined();
    expect(line).not.toContain('mobileLabel');
  });
});

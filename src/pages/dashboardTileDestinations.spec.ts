import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));

import {
  lateDeliveriesLink, openInvoiceBalanceLink, purchasedThisMonthLink, undatedOpenOrdersLink,
} from './Dashboard';
import { orderMatchesListFilters } from './Orders';
import { receivingMatchesStatus } from './Receiving';
import { invoiceListPredicates } from './Invoices';
import type { ServerPredicate } from '../lib/serverList';

/**
 * `DASH-03`, `DASH-04`, `DASH-05`, `DASH-06` — the tile counted one population and its link
 * opened another.
 *
 * THE ORACLE, and it is one sentence: **the rows the tile counted are exactly the rows its link
 * lands on.** Both halves are computed here from ONE fixture — the left-hand side with the
 * predicate `management_dashboard_snapshot` uses (cited per case), the right-hand side by handing
 * the link the product actually renders to the destination screen's own filter. Neither side is
 * a restatement of the other, which is what makes a disagreement mean something.
 *
 * It is set equality, never count equality. `DASH-03` is exactly why: before the fix the tile said
 * 8 and `/invoices?pay=unpaid` also returned 8 — a different 8, missing the ₪150 partially-paid
 * invoice inside the figure and holding a $300 that was not. A counter would have called that
 * green.
 *
 * The fixture is the tenant the sweep measured on 2026-09-04: nine orders awaiting receipt, of
 * which two are past their delivery date and seven never had one, and eight open ILS invoices
 * whose balances add to ₪11,581.60 beside one open $300.
 */

const TODAY = '2026-09-04';
const MONTH = '2026-09';

/* ------------------------------------------------------------------ orders */

/** `open_orders` in `0218:467`: `po.status in ('sent','confirmed','partial')`. */
const OPEN_STATUSES = ['sent', 'confirmed', 'partial'];

/** The dashboard's own `purchase_orders` read: `.not('status','in','(draft,cancelled)')`. */
const PLACED_STATUSES = ['ready', 'sent', 'confirmed', 'partial', 'received'];

interface OrderFixture {
  id: string;
  status: string;
  expected_date: string | null;
  created_at: string;
  currency: string;
}

const ORDERS: OrderFixture[] = [
  // The two the sweep found late: #11 (18.07.2026) and #12 (20.07.2026).
  { id: 'o-late-11', status: 'sent', expected_date: '2026-07-18', created_at: '2026-09-01T08:00:00Z', currency: 'ILS' },
  { id: 'o-late-12', status: 'confirmed', expected_date: '2026-07-20', created_at: '2026-09-02T08:00:00Z', currency: 'ILS' },
  // Seven open orders that never carried a delivery date. Three are partial, which is what makes
  // "דורש פעולה" five on that screen while "באיחור" is two.
  { id: 'o-undated-1', status: 'partial', expected_date: null, created_at: '2026-09-01T09:00:00Z', currency: 'ILS' },
  { id: 'o-undated-2', status: 'partial', expected_date: null, created_at: '2026-08-20T09:00:00Z', currency: 'ILS' },
  { id: 'o-undated-3', status: 'partial', expected_date: null, created_at: '2026-09-03T09:00:00Z', currency: 'ILS' },
  { id: 'o-undated-4', status: 'sent', expected_date: null, created_at: '2026-09-03T10:00:00Z', currency: 'ILS' },
  { id: 'o-undated-5', status: 'sent', expected_date: null, created_at: '2026-08-11T10:00:00Z', currency: 'ILS' },
  { id: 'o-undated-6', status: 'confirmed', expected_date: null, created_at: '2026-09-02T11:00:00Z', currency: 'ILS' },
  // Undated too, and in the other currency: `no_date` is a COUNT OF THINGS, so the snapshot takes
  // it across every currency and its link must not narrow to one.
  { id: 'o-undated-7', status: 'confirmed', expected_date: null, created_at: '2026-09-02T12:00:00Z', currency: 'USD' },
  // Placed this month but finished or not yet sent — inside "נרכש החודש", outside the receiving
  // queue.
  { id: 'o-received', status: 'received', expected_date: '2026-09-01', created_at: '2026-09-03T07:00:00Z', currency: 'ILS' },
  { id: 'o-ready', status: 'ready', expected_date: null, created_at: '2026-09-03T07:30:00Z', currency: 'ILS' },
  // A draft and a cancellation this month. `?status=all` — the link the tile used to carry —
  // holds both, and neither is money this business spent.
  { id: 'o-draft', status: 'draft', expected_date: null, created_at: '2026-09-03T07:45:00Z', currency: 'ILS' },
  { id: 'o-cancelled', status: 'cancelled', expected_date: null, created_at: '2026-09-03T07:50:00Z', currency: 'ILS' },
  // Placed this month in the other currency, and placed last month in this one. Both are outside
  // the ₪ figure, and `?status=all` showed both.
  { id: 'o-usd-month', status: 'received', expected_date: '2026-09-02', created_at: '2026-09-02T13:00:00Z', currency: 'USD' },
  { id: 'o-last-month', status: 'received', expected_date: '2026-08-30', created_at: '2026-08-28T13:00:00Z', currency: 'ILS' },
];

/* ------------------------------------------------------------------ invoices */

interface InvoiceFixture {
  id: string;
  currency: string;
  payment_status: string;
  review_status: string;
  export_status: string;
  financial_role: string;
  deleted_at: string | null;
  invoice_date: string;
  /** `balance_in_currency` from `invoice_balances_by_currency` (`0218:51-94`). */
  balance: number;
  invoice_has_duplicate: boolean;
  invoice_without_order: boolean;
}

const invoice = (id: string, over: Partial<InvoiceFixture>): InvoiceFixture => ({
  id,
  currency: 'ILS',
  payment_status: 'unpaid',
  review_status: 'approved',
  export_status: 'not_sent',
  financial_role: 'payable',
  deleted_at: null,
  invoice_date: '2026-08-15',
  balance: 0,
  invoice_has_duplicate: false,
  invoice_without_order: false,
  ...over,
});

const INVOICES: InvoiceFixture[] = [
  // The seven the destination did show: 11 + 90 + 780 + 3,540 + 4,720 + 1,650.60 + 640.
  invoice('i-1', { balance: 11 }),
  invoice('i-2', { balance: 90 }),
  invoice('i-3', { balance: 780 }),
  invoice('i-4', { balance: 3540 }),
  invoice('i-5', { balance: 4720 }),
  invoice('i-6', { balance: 1650.6 }),
  invoice('i-7', { balance: 640 }),
  // Invoice 3377, אריזות הדרום: ₪900 total, ₪150 still owed, status שולמה חלקית. It is inside the
  // ₪11,582 and was missing from `?pay=unpaid` — 11,431.60 + 150.00 is the tile exactly.
  invoice('i-3377', { payment_status: 'partial', balance: 150 }),
  // QA-USD-001: $300 open, and not a shekel of the figure the tile printed.
  invoice('i-usd', { currency: 'USD', balance: 300 }),
  // Controls: settled, soft-deleted, and a receivable. None is in either population.
  invoice('i-paid', { payment_status: 'paid', balance: 0 }),
  invoice('i-deleted', { deleted_at: '2026-08-30T00:00:00Z', balance: 400 }),
  invoice('i-receivable', { financial_role: 'receivable', balance: 500 }),
];

/* ------------------------------------------------------------------ helpers */

const ids = (rows: { id: string }[]) => [...rows.map((row) => row.id)].sort();

/** The query string the product renders, as the destination screen reads it. */
const paramsOf = (link: string) => new URLSearchParams(link.includes('?') ? link.slice(link.indexOf('?') + 1) : '');

const orderFilters = (link: string) => {
  const params = paramsOf(link);
  return {
    // `useParamState('status', 'open')` — an absent parameter IS the screen's default, and the
    // whole of `DASH-05` is that the default was not the tile's population.
    status: params.get('status') ?? 'open',
    delivery: params.get('delivery') ?? '',
    month: params.get('month') ?? '',
    currency: params.get('currency') ?? '',
  };
};

/**
 * PostgREST's semantics for the six predicate kinds `/invoices` emits, and nothing else. A kind
 * that appears here without a branch throws rather than being silently treated as "matches" —
 * a filter this evaluator did not understand would otherwise widen the destination for free.
 */
type Cell = string | number | boolean | null;
const cell = (row: InvoiceFixture, column: string): Cell =>
  (row as unknown as Record<string, Cell>)[column];

function matchesPredicate(row: InvoiceFixture, predicate: ServerPredicate): boolean {
  switch (predicate.kind) {
    case 'eq': return cell(row, predicate.column) === predicate.value;
    case 'neq': return cell(row, predicate.column) !== predicate.value;
    case 'is': return cell(row, predicate.column) === predicate.value;
    case 'in': return predicate.values.includes(cell(row, predicate.column) as string);
    case 'gte': return String(cell(row, predicate.column)) >= String(predicate.value);
    case 'lt': return String(cell(row, predicate.column)) < String(predicate.value);
    default: throw new Error(`the oracle has no reading for predicate kind "${predicate.kind}"`);
  }
}

function invoiceDestination(link: string): InvoiceFixture[] {
  const params = paramsOf(link);
  const predicates = invoiceListPredicates({
    review: params.get('review') ?? '',
    pay: params.get('pay') ?? '',
    export: params.get('export') ?? '',
    month: params.get('month') ?? '',
    attention: params.get('attention') ?? '',
    currency: params.get('currency') ?? '',
    canViewExport: true,
  });
  return INVOICES.filter((row) => predicates.every((predicate) => matchesPredicate(row, predicate)));
}

/* ------------------------------------------------------------------ the four tiles */

describe('DASH-03 — the open-invoice-balance tile opens the balance it counted', () => {
  /**
   * `invoice_balance_money` (`0218:378-382`): every row of `invoice_balances_by_currency` whose
   * `balance_in_currency > 0`, grouped by currency, and the tile reads the entry for the currency
   * the picker is on.
   */
  const counted = INVOICES.filter((row) => row.currency === 'ILS'
    && row.financial_role === 'payable' && row.deleted_at === null && row.balance > 0);

  it('the tile is the ₪11,581.60 across eight invoices the sweep measured', () => {
    expect(counted).toHaveLength(8);
    expect(counted.reduce((sum, row) => sum + row.balance, 0)).toBeCloseTo(11581.6, 2);
  });

  it('and the list its link opens holds exactly those invoices', () => {
    expect(ids(invoiceDestination(openInvoiceBalanceLink('ILS')))).toEqual(ids(counted));
  });

  it('the dollar invoice is not in the shekel figure and must not be in the shekel list', () => {
    expect(ids(invoiceDestination(openInvoiceBalanceLink('ILS')))).not.toContain('i-usd');
  });

  it('and switching the picker moves the list with it', () => {
    expect(ids(invoiceDestination(openInvoiceBalanceLink('USD')))).toEqual(['i-usd']);
  });
});

describe('DASH-04 — "N הזמנות באיחור באספקה" opens those N', () => {
  /** `open_order_metrics.late` (`0218:474`): `count(*) filter (where expected_date < p_today)`. */
  const counted = ORDERS.filter((order) => OPEN_STATUSES.includes(order.status)
    && order.expected_date != null && order.expected_date < TODAY);

  it('two of the nine orders awaiting receipt are late', () => {
    expect(ORDERS.filter((order) => OPEN_STATUSES.includes(order.status))).toHaveLength(9);
    expect(counted).toHaveLength(2);
  });

  it('and the list its link opens holds exactly those two', () => {
    const filter = paramsOf(lateDeliveriesLink()).get('status') ?? 'all';
    const landed = ORDERS
      .filter((order) => OPEN_STATUSES.includes(order.status))
      .filter((order) => receivingMatchesStatus(order, filter, TODAY));
    expect(ids(landed)).toEqual(ids(counted));
  });

  it('"דורש פעולה" is not that set — it is five, and that is why it could not carry the link', () => {
    const attention = ORDERS
      .filter((order) => OPEN_STATUSES.includes(order.status))
      .filter((order) => receivingMatchesStatus(order, 'attention', TODAY));
    expect(attention).toHaveLength(5);
  });

  it('a delivery promised for today is not late, though it does need action', () => {
    const dueToday = { status: 'confirmed', expected_date: TODAY };
    expect(receivingMatchesStatus(dueToday, 'late', TODAY)).toBe(false);
    expect(receivingMatchesStatus(dueToday, 'attention', TODAY)).toBe(true);
  });
});

describe('DASH-05 — "N הזמנות פתוחות ללא תאריך אספקה" opens those N', () => {
  /** `open_order_metrics.no_date` (`0218:473`): `count(*) filter (where expected_date is null)`. */
  const counted = ORDERS.filter((order) => OPEN_STATUSES.includes(order.status)
    && order.expected_date === null);

  it('seven open orders carry no delivery date', () => {
    expect(counted).toHaveLength(7);
  });

  it('and the list its link opens holds exactly those seven', () => {
    const landed = ORDERS.filter((order) => orderMatchesListFilters(order, orderFilters(undatedOpenOrdersLink())));
    expect(ids(landed)).toEqual(ids(counted));
  });

  it('the count is of things, so its link carries no currency', () => {
    expect(paramsOf(undatedOpenOrdersLink()).get('currency')).toBeNull();
    expect(ids(ORDERS.filter((order) => orderMatchesListFilters(order, orderFilters(undatedOpenOrdersLink())))))
      .toContain('o-undated-7');
  });
});

describe('DASH-06 — "נרכש החודש" opens the orders that make it up', () => {
  /**
   * The figure this screen computes itself: orders read with
   * `.not('status','in','(draft,cancelled)')`, narrowed to the month by `created_at` and to the
   * currency being read. Every aggregate on the control centre is taken inside one currency
   * (`#305`), so the population behind the shekel figure is a shekel population.
   */
  const counted = ORDERS.filter((order) => PLACED_STATUSES.includes(order.status)
    && order.created_at.slice(0, 7) === MONTH && order.currency === 'ILS');

  it('the month figure is neither every order nor every order this month', () => {
    expect(counted.length).toBeGreaterThan(0);
    expect(counted.length).toBeLessThan(ORDERS.length);
    expect(ids(counted)).not.toContain('o-draft');
    expect(ids(counted)).not.toContain('o-cancelled');
    expect(ids(counted)).not.toContain('o-last-month');
    expect(ids(counted)).not.toContain('o-usd-month');
  });

  it('and the list its link opens holds exactly those orders', () => {
    const landed = ORDERS.filter((order) => orderMatchesListFilters(order, orderFilters(purchasedThisMonthLink(MONTH, 'ILS'))));
    expect(ids(landed)).toEqual(ids(counted));
  });
});

describe('no link promises a narrowing its destination will ignore', () => {
  /**
   * The trap this closes is named in `Dashboard.tsx`'s own former comment: "a query parameter the
   * target silently ignores promises a filtered list and delivers every currency's invoices."
   */
  const READ_BY = {
    '/invoices': ['review', 'pay', 'export', 'month', 'attention', 'currency', 'q', 'page', 'sort'],
    '/orders': ['status', 'delivery', 'month', 'currency'],
    '/receiving': ['status', 'document'],
  } as const;

  it.each([
    openInvoiceBalanceLink('ILS'),
    lateDeliveriesLink(),
    undatedOpenOrdersLink(),
    purchasedThisMonthLink(MONTH, 'ILS'),
  ])('%s', (link) => {
    const [path, query = ''] = link.split('?');
    const read = READ_BY[path as keyof typeof READ_BY];
    expect(read, `no parameter list recorded for ${path}`).toBeDefined();
    for (const name of new URLSearchParams(query).keys()) expect(read).toContain(name);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scanAlerts } from './alerts';
import { APP_ROUTE_POLICY } from './routePolicy';
import { translateIn } from './i18n/LocaleProvider';
import type { TKey } from './i18n/t';
import type { ActiveRole } from './types';

/**
 * `DASH-01` — `/alerts` called itself the full queue of everything requiring action and listed
 * four findings, while the control centre one click away counted six attention types and
 * twenty-three open queue tasks. Only two conditions appeared on both, and every exception in the
 * tenant appeared on neither version of this screen.
 *
 * Ruling `#359` (owner, 05.09.2026) closed the narrowing branch: `/alerts` EXPANDS. So —
 *
 * THE ORACLE, in one sentence: **every standing condition the control centre counts is scanned by
 * `/alerts` too, each row carrying that condition's own figure and opening the list that
 * reproduces it.**
 *
 * It is asserted PER CONDITION and never by a count of rows, which matters more here than usual:
 * the finding IS a count disagreement, and a test that compared "how many alerts" against "how
 * many attention rows" would have gone green the moment the two totals happened to match.
 *
 * THE FIXTURE IS REAL DATA. Every figure in `PRODUCTION` was measured on 05.09.2026 against the
 * production project `rkftlbctohswhbbiaqin`, tenant `11111111-…`, by calling
 * `management_dashboard_snapshot(current_date)` on the guarded path — role `authenticated`, the
 * owner's own JWT subject — and by counting `exceptions` beside it. The evidence is
 * `docs/qa/2026-09-04/evidence/PR26-DASH-01-GAP.txt`.
 *
 * `DISTINCT` exists because the real figures are not all different — credits and open orders are
 * both 9 there, and two more conditions are both 1. A row reading its NEIGHBOUR's field would
 * survive the production fixture and die on this one.
 */

const rpc = vi.fn();
const from = vi.fn();
vi.mock('./supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
  },
}));

interface Snapshot {
  paymentRequests: { pendingApproval: number; drafts: number };
  credits: { count: number };
  invoices: { pendingApproval: number; toReview: number; notSent: number };
  openOrders: { count: number; late: number };
}

interface Tenant {
  snapshot: Snapshot | null;
  exceptions: { total: number; high: number };
  ordersSent: number;
  duplicateInvoiceGroups: number;
  priceIncreases: number;
  aboveAverageOffers: number;
  invoicesWithoutOrder: number;
  paymentsDue: { total: number; late: number };
}

/** Measured 05.09.2026 on production, tenant `11111111-…`, read as the owner. */
const PRODUCTION: Tenant = {
  snapshot: {
    paymentRequests: { pendingApproval: 2, drafts: 1 },
    credits: { count: 9 },
    invoices: { pendingApproval: 1, toReview: 5, notSent: 3 },
    openOrders: { count: 9, late: 2 },
  },
  exceptions: { total: 9, high: 3 },
  ordersSent: 4,
  duplicateInvoiceGroups: 1,
  priceIncreases: 1,
  aboveAverageOffers: 0,
  invoicesWithoutOrder: 5,
  paymentsDue: { total: 2, late: 2 },
};

/** Same shape, every figure different, so a row that reads the wrong field cannot hide. */
const DISTINCT: Tenant = {
  snapshot: {
    paymentRequests: { pendingApproval: 11, drafts: 12 },
    credits: { count: 13 },
    invoices: { pendingApproval: 14, toReview: 15, notSent: 16 },
    openOrders: { count: 17, late: 18 },
  },
  exceptions: { total: 19, high: 7 },
  ordersSent: 21,
  duplicateInvoiceGroups: 22,
  priceIncreases: 23,
  aboveAverageOffers: 24,
  invoicesWithoutOrder: 25,
  paymentsDue: { total: 26, late: 27 },
};

let tenant: Tenant = PRODUCTION;

/** A `PostgrestFilterBuilder` as far as these two scans use it: chainable, and awaitable. */
function tableQuery(table: string) {
  const filters = new Map<string, unknown>();
  const builder = {
    select: () => builder,
    in: (column: string, values: unknown[]) => { filters.set(column, values); return builder; },
    eq: (column: string, value: unknown) => { filters.set(column, value); return builder; },
    then: (resolve: (result: { count: number | null; error: null }) => unknown) => {
      if (table === 'purchase_orders') return resolve({ count: tenant.ordersSent, error: null });
      if (table === 'exceptions') {
        const high = filters.get('severity') === 'high';
        return resolve({ count: high ? tenant.exceptions.high : tenant.exceptions.total, error: null });
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return builder;
}

beforeEach(() => {
  tenant = PRODUCTION;
  from.mockReset().mockImplementation((table: string) => tableQuery(table));
  rpc.mockReset().mockImplementation(async (name: string) => {
    switch (name) {
      case 'management_dashboard_snapshot': return { data: tenant.snapshot, error: null };
      case 'p2_duplicate_invoice_group_count': return { data: tenant.duplicateInvoiceGroups, error: null };
      case 'p2_recent_price_increase_count': return { data: tenant.priceIncreases, error: null };
      case 'p2_above_average_offer_count': return { data: tenant.aboveAverageOffers, error: null };
      case 'p2_invoice_without_order_count': return { data: tenant.invoicesWithoutOrder, error: null };
      case 'p2_payment_due_counts': return { data: tenant.paymentsDue, error: null };
      default: throw new Error(`unexpected rpc ${name}`);
    }
  });
});

const byCode = async () => {
  const scan = await scanAlerts();
  return { scan, rows: new Map(scan.alerts.map((alert) => [alert.code, alert])) };
};

/**
 * The conditions the control centre counts, each named by the snapshot field the dashboard reads
 * for it and the destination its own row opens (`Dashboard.tsx:974-1005`, `Dashboard.tsx:312-327`).
 * The figure comes from the FIXTURE, never from the module under test.
 */
const CONTROL_CENTRE = [
  {
    condition: 'חריגים פתוחים',
    code: 'open_exceptions',
    severity: 'critical',
    figure: (t: Tenant) => t.exceptions.total,
    to: '/exceptions?status=open',
  },
  {
    condition: 'הזמנות באיחור באספקה',
    code: 'late_deliveries',
    severity: 'critical',
    figure: (t: Tenant) => t.snapshot!.openOrders.late,
    to: '/receiving?status=late',
  },
  {
    condition: 'חשבוניות לאישור',
    code: 'invoices_pending_approval',
    severity: 'warning',
    figure: (t: Tenant) => t.snapshot!.invoices.pendingApproval,
    to: '/invoices?review=pending_approval',
  },
  {
    condition: 'דרישות תשלום לאישור',
    code: 'payment_requests_pending_approval',
    severity: 'warning',
    figure: (t: Tenant) => t.snapshot!.paymentRequests.pendingApproval,
    to: '/payment-requests?status=pending_approval',
  },
  {
    condition: 'חשבוניות לבדיקה',
    code: 'invoices_to_review',
    severity: 'warning',
    figure: (t: Tenant) => t.snapshot!.invoices.toReview,
    to: '/invoices?review=received,in_review',
  },
  {
    condition: 'חשבוניות מאושרות שטרם נשלחו להנהלת חשבונות',
    code: 'invoices_not_sent_to_accountant',
    severity: 'warning',
    figure: (t: Tenant) => t.snapshot!.invoices.notSent,
    to: '/invoices?export=not_sent&review=approved',
  },
  {
    condition: 'טיוטות דרישות תשלום',
    code: 'payment_request_drafts',
    severity: 'info',
    figure: (t: Tenant) => t.snapshot!.paymentRequests.drafts,
    to: '/payment-requests?status=draft',
  },
  {
    condition: 'זיכויים שטרם קוזזו',
    code: 'open_credits',
    severity: 'info',
    figure: (t: Tenant) => t.snapshot!.credits.count,
    to: '/credits?status=active',
  },
  {
    condition: 'התחייבויות פתוחות',
    code: 'open_commitments',
    severity: 'info',
    figure: (t: Tenant) => t.snapshot!.openOrders.count,
    to: '/orders?status=sent,confirmed,partial',
  },
] as const;

/** The six that were already scanned. Controls: they must pass on BOTH sides of this fix. */
const ALREADY_SCANNED = [
  { code: 'duplicate_invoice', figure: (t: Tenant) => t.duplicateInvoiceGroups },
  { code: 'orders_awaiting_confirmation', figure: (t: Tenant) => t.ordersSent },
  { code: 'price_increase', figure: (t: Tenant) => t.priceIncreases },
  { code: 'invoice_without_order', figure: (t: Tenant) => t.invoicesWithoutOrder },
  { code: 'payment_due_soon', figure: (t: Tenant) => t.paymentsDue.late },
] as const;

describe('CONTROL — the five conditions /alerts already scanned (green on both sides of DASH-01)', () => {
  it.each(ALREADY_SCANNED)('$code is a row, carrying its own figure', async ({ code, figure }) => {
    const { rows } = await byCode();
    const row = rows.get(code);
    expect(row, `no row for ${code}`).toBeDefined();
    expect(row!.title.vars?.count).toBe(figure(PRODUCTION));
  });

  it('a condition that holds for nobody is no row at all — never a row reading 0', async () => {
    // `above_average_price` really is 0 in this tenant. Zero is a claim about reality and the
    // screen states it once, as "no open alert was found", instead of eleven times as a figure.
    const { rows } = await byCode();
    expect(rows.has('above_average_price')).toBe(false);
  });
});

describe('DASH-01 — every condition the control centre counts is scanned here too', () => {
  it.each(CONTROL_CENTRE)('$condition ($code)', async ({ code, severity, figure, to }) => {
    const { rows } = await byCode();
    const row = rows.get(code);
    expect(row, `the control centre counts ${code} and /alerts does not scan it`).toBeDefined();
    expect(row!.title.vars?.count).toBe(figure(PRODUCTION));
    expect(row!.severity).toBe(severity);
    expect(row!.to).toBe(to);
  });

  it.each(CONTROL_CENTRE)('$code reads its OWN field, not a neighbour\'s', async ({ code, figure }) => {
    tenant = DISTINCT;
    const { rows } = await byCode();
    expect(rows.get(code)?.title.vars?.count).toBe(figure(DISTINCT));
  });

  it('the whole scan is complete and nothing was left unmeasured', async () => {
    const { scan } = await byCode();
    expect(scan.failures).toEqual([]);
    expect(scan.complete).toBe(true);
  });
});

describe('DASH-01 — a condition with no data is silent, and one that could not be read is NAMED', () => {
  it('a control centre that counts nothing produces no row for those conditions', async () => {
    tenant = {
      ...PRODUCTION,
      snapshot: {
        paymentRequests: { pendingApproval: 0, drafts: 0 },
        credits: { count: 0 },
        invoices: { pendingApproval: 0, toReview: 0, notSent: 0 },
        openOrders: { count: 0, late: 0 },
      },
      exceptions: { total: 0, high: 0 },
    };
    const { rows, scan } = await byCode();
    for (const { code } of CONTROL_CENTRE) expect(rows.has(code), `${code} rendered a zero`).toBe(false);
    // and the absence is an absence, not a failure: nothing went unmeasured here.
    expect(scan.failures).toEqual([]);
  });

  it('a control centre the reader may not read is nine NAMED failures, not nine silent all-clears', async () => {
    // The RPC answers `null` to any role but owner/office. That is "we did not measure", and the
    // screen has a register for it — the partial-scan note. Eight conditions ride the one refused
    // call; open exceptions is read separately and still answers.
    tenant = { ...PRODUCTION, snapshot: null };
    const { rows, scan } = await byCode();
    const fromSnapshot = CONTROL_CENTRE.filter((c) => c.code !== 'open_exceptions');
    for (const { code } of fromSnapshot) expect(rows.has(code), `${code} was rendered anyway`).toBe(false);
    expect(scan.complete).toBe(false);
    expect(scan.failures.map((failure) => failure.code).sort())
      .toEqual(fromSnapshot.map((c) => c.code).sort());
    // Every failure names itself in words, so the note says WHICH conditions went unchecked.
    for (const failure of scan.failures) {
      expect(translateIn('he', failure.labelKey)).not.toBe(failure.labelKey);
      expect(translateIn('en', failure.labelKey)).not.toBe(failure.labelKey);
    }
    // The condition that does not depend on that call is unaffected — one refusal does not blank
    // the screen.
    expect(rows.get('open_exceptions')?.title.vars?.count).toBe(PRODUCTION.exceptions.total);
  });

  it('the eight snapshot conditions cost ONE call between them', async () => {
    await byCode();
    expect(rpc.mock.calls.filter(([name]) => name === 'management_dashboard_snapshot')).toHaveLength(1);
  });
});

describe('CONTROL — no row promises a destination this screen\'s readers cannot open', () => {
  /**
   * Computed from the real route table, not restated. This is the control that made the bank rows
   * stay OFF this screen: `/bank` admits owner and accountant, `/alerts` admits owner and office,
   * so a bank row here would be a dead end for the office — and widening either list to make two
   * surfaces agree is the repair this campaign forbids.
   */
  const ROLES_BY_PATH = new Map<string, readonly ActiveRole[]>(
    Object.values(APP_ROUTE_POLICY).map((entry) => [entry.path, entry.roles as readonly ActiveRole[]]),
  );
  const ALERTS_READERS = APP_ROUTE_POLICY.alerts.roles as readonly ActiveRole[];

  it('every alert lands on a route every reader of /alerts may open', async () => {
    const { scan } = await byCode();
    expect(scan.alerts.length).toBeGreaterThan(0);
    for (const alert of scan.alerts) {
      const path = alert.to.split('?')[0];
      const roles = ROLES_BY_PATH.get(path);
      expect(roles, `${alert.code} points at ${path}, which is in no route policy`).toBeDefined();
      for (const reader of ALERTS_READERS) {
        expect(roles, `${alert.code} sends ${reader} to ${path}, which ${reader} may not open`)
          .toContain(reader);
      }
    }
  });

  it('and that is a real constraint — /bank fails it, which is why bank matches stay on the dashboard', () => {
    expect(ROLES_BY_PATH.get('/bank')).not.toContain('office');
    expect(ALERTS_READERS).toContain('office');
  });
});

describe('CONTROL — severity order and wording', () => {
  it('rows arrive most severe first', async () => {
    const rank = { critical: 0, warning: 1, info: 2 };
    const { scan } = await byCode();
    const order = scan.alerts.map((alert) => rank[alert.severity]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('every row says its finding in BOTH languages, and reads correctly at one', async () => {
    const { scan } = await byCode();
    for (const alert of scan.alerts) {
      for (const locale of ['he', 'en'] as const) {
        const title = translateIn(locale, alert.title.key as TKey, alert.title.vars);
        const detail = translateIn(locale, alert.detail.key as TKey, alert.detail.vars);
        expect(title, `${alert.code} title missing in ${locale}`).not.toBe(alert.title.key);
        expect(detail, `${alert.code} detail missing in ${locale}`).not.toBe(alert.detail.key);
        expect(title, `${alert.code} left a placeholder in ${locale}`).not.toContain('{');
      }
    }
  });

  it('a new condition at one does not read "1 invoices"', () => {
    // The singular siblings, checked where they are reached: `t()` swaps them in on count === 1.
    expect(translateIn('en', 'alerts.invoicesPendingApproval_title', { count: 1 }))
      .toBe('One invoice is awaiting approval');
    expect(translateIn('he', 'alerts.openCredits_title', { count: 1 })).toBe('זיכוי אחד שטרם קוזז');
  });

  it('the screen still names what it does NOT scan, bank reconciliation included', () => {
    for (const locale of ['he', 'en'] as const) {
      const unchecked = translateIn(locale, 'alerts.text_3');
      expect(unchecked).toContain(locale === 'he' ? 'התאמות בנק' : 'bank reconciliation');
      expect(translateIn(locale, 'alerts.coverageNote')).not.toBe('alerts.coverageNote');
    }
  });
});

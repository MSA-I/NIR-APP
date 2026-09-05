import type { TKey } from './i18n/t';
import { supabase } from './supabase';
import { PRICE_INCREASE_SCOPE_DETAIL_KEY, settleAlertScans, type AlertScanDefinition } from './alertRules';
import { addCalendarDays, todayISO } from './format';

/**
 * Standing-condition scanner (סעיף 9 — מערכת התראות).
 *
 * The distinction that shapes this file: `exceptions` rows are created only at the moment
 * a user writes something (InvoiceNew, PaymentRequests, Bank), and `checks.ts` runs only
 * while a form is open. Neither ever looks at data that is already sitting in the database.
 * Every alert below is a *standing* condition on existing rows, so it needs its own pass.
 *
 * The screen remains a live scan of current truth. Warning/critical transitions are also
 * persisted by 0017 for the unread bell and selected Web Push events; informational findings
 * stay here only, and resolved conditions disappear from this scan without erasing history.
 *
 * Every query here is filtered to the caller's tenant by RLS (`org_id = auth_org()`), so no
 * org filter is written by hand.
 */

export type AlertSeverity = 'critical' | 'warning' | 'info';

/** A dictionary key and the numbers that fill it. See `Alert` for why it is not a sentence. */
export interface AlertText {
  key: string;
  vars?: Record<string, string | number>;
}

export interface Alert {
  code: string;
  severity: AlertSeverity;
  /**
   * Short headline as a KEY, not a sentence. Always carries the count — an alert with no
   * occurrences is never returned.
   *
   * This module is pure: it has no React and therefore no way to ask what language the reader is
   * in. It also runs when a screen loads and is drawn afterwards. Both point the same way — the
   * scan says WHICH finding and HOW MANY, and the screen that draws it says it in words.
   */
  title: AlertText;
  /** One line of context, including any limit on what the scan actually covered. Also a key. */
  detail: AlertText;
  /** Where clicking it goes. */
  to: string;
}

/* ---------- documented defaults (OPEN-DECISIONS.md) — not silent guesses ---------- */

/** How far above the cross-supplier average an offer must sit before it is worth surfacing.
 *  Flagging every above-average offer would flag roughly half of them. */
const ABOVE_AVG_MARGIN = 0.15;
/** Lookback for "a supplier raised a price". */
const PRICE_INCREASE_WINDOW_DAYS = 30;
/** How close a dated payment request must be before it counts as approaching. */
const DUE_SOON_DAYS = 7;

function daysAgo(n: number): string {
  return addCalendarDays(todayISO(), -n);
}

function daysAhead(n: number): string {
  return addCalendarDays(todayISO(), n);
}

/* ---------- scans ---------- */

async function rpcCount(
  request: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<number> {
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  const count = Number(data);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('count_unavailable');
  return count;
}

/** Invoices sharing a supplier + invoice number. checks.ts catches these at entry; this
 *  catches the ones already stored, including any entered before that check existed. */
async function scanDuplicateInvoices(): Promise<Alert | null> {
  const dupes = await rpcCount(supabase.rpc('p2_duplicate_invoice_group_count'));
  if (!dupes) return null;

  return {
    code: 'duplicate_invoice',
    severity: 'critical',
    title: { key: 'alerts.duplicateInvoices_title', vars: { count: dupes } },
    detail: { key: 'alerts.duplicateInvoices_detail' },
    to: '/invoices?attention=duplicates',
  };
}

/** Catalogue price rises. This scan intentionally reads the price list only; invoice line prices
 *  exist, but belong to the invoice matching flow and are outside this scanner's scope. */
async function scanPriceIncreases(): Promise<Alert | null> {
  const raised = await rpcCount(supabase.rpc('p2_recent_price_increase_count', {
    p_since: daysAgo(PRICE_INCREASE_WINDOW_DAYS),
  }));
  if (!raised) return null;

  return {
    code: 'price_increase',
    severity: 'warning',
    title: { key: 'alerts.priceIncrease_title', vars: { count: raised, days: PRICE_INCREASE_WINDOW_DAYS } },
    detail: { key: PRICE_INCREASE_SCOPE_DETAIL_KEY },
    // The window this scan measures on (p2_recent_price_increase_count reads
    // price_effective_date >= today - 30). Without it the link opens every rise the catalogue
    // still remembers, under a title that counted thirty days.
    to: '/prices?increases=1&days=30',
  };
}

/** Offers sitting materially above the average of the other suppliers for the same product.
 *  Products with a single supplier are skipped — their own price *is* the average, and a
 *  deviation of zero is not a finding. */
async function scanPricedAboveAverage(): Promise<Alert | null> {
  const over = await rpcCount(supabase.rpc('p2_above_average_offer_count', {
    p_margin: ABOVE_AVG_MARGIN,
  }));
  if (!over) return null;

  return {
    code: 'above_average_price',
    severity: 'info',
    title: { key: 'alerts.aboveAverage_title', vars: { count: over, margin: Math.round(ABOVE_AVG_MARGIN * 100) } },
    detail: { key: 'alerts.aboveAverage_detail' },
    to: '/prices',
  };
}

/** Invoices with no linked purchase order. A direct purchase legitimately has none, so this
 *  is information, not a fault. */
async function scanInvoicesWithoutOrder(): Promise<Alert | null> {
  const orphans = await rpcCount(supabase.rpc('p2_invoice_without_order_count'));
  if (!orphans) return null;

  return {
    code: 'invoice_without_order',
    severity: 'info',
    title: { key: 'alerts.invoiceWithoutOrder_title', vars: { count: orphans } },
    detail: { key: 'alerts.invoiceWithoutOrder_detail' },
    to: '/invoices?attention=without-order',
  };
}

/** Dated payment requests coming due.
 *
 *  Scope limit, stated in `detail` on purpose: invoices have no due_date column and
 *  suppliers.payment_terms is free text nobody parses, so the only date the system holds is
 *  the one a user typed into a payment request — an optional field that is usually empty.
 *  A manager who reads this as "everything due soon" would be wrong, so the alert says so. */
async function scanPaymentsDueSoon(): Promise<Alert | null> {
  const today = todayISO();
  const { data, error } = await supabase.rpc('p2_payment_due_counts', {
    p_today: today,
    p_until: daysAhead(DUE_SOON_DAYS),
  });
  if (error) throw new Error(error.message);
  const counts = data as { total?: unknown; late?: unknown } | null;
  const total = Number(counts?.total);
  const late = Number(counts?.late);
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(late) || late < 0 || late > total) {
    throw new Error('due_counts_unavailable');
  }
  if (!total) return null;

  return {
    code: 'payment_due_soon',
    severity: late ? 'critical' : 'warning',
    title: late
      ? { key: 'alerts.paymentDue_late', vars: { count: late } }
      : { key: 'alerts.paymentDue_soon', vars: { count: total, days: DUE_SOON_DAYS } },
    detail: { key: 'alerts.paymentDue_detail' },
    to: '/payment-requests?status=active&due=soon',
  };
}

/* ---------- not implemented, and why ----------
 *
 * Three conditions are absent rather than stubbed, and none of them may be shown as "0" — zero is
 * a claim about reality (CLAUDE.md:31). The screen names all three in words (`alerts.text_3`),
 * because a manager who reads this page as complete would stop looking elsewhere.
 *
 * מלאי נמוך      — nothing in the schema holds a stock quantity. products.min_stock is
 *                   marked "reserved for future inventory module" and received_qty only ever
 *                   counts goods in, never out, so there is no level to compare a threshold
 *                   against (OPEN-DECISIONS.md:17, PROGRESS.md:142).
 * חריגה בתקציב   — there is no budget table or column anywhere. Spend per category is
 *                   already computed in Dashboard.tsx; the target is missing, and it is a
 *                   business input, not something to derive.
 * התאמות בנק     — the data exists and the control centre counts it. What is missing is a
 *                   DESTINATION this screen's readers can reach: `/bank` admits owner and
 *                   accountant, `/alerts` admits owner and office, and widening either list so
 *                   that two surfaces agree is a privilege leak wearing the costume of a fix.
 *                   The count stays on the control centre, and this screen says so.
 */

// Phase 3.3 — remind about orders that were sent to a supplier but not yet confirmed as received.
// (An in-app reminder; a proactive WhatsApp/push reminder waits on the WhatsApp Business API.)
async function scanOrdersAwaitingConfirmation(): Promise<Alert | null> {
  const { count, error } = await supabase
    .from('purchase_orders')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'sent');
  if (error) throw new Error(error.message);
  const total = count ?? 0;
  if (!total) return null;
  return {
    code: 'orders_awaiting_confirmation',
    severity: 'warning',
    title: { key: 'alerts.ordersAwaiting_title', vars: { count: total } },
    detail: { key: 'alerts.ordersAwaiting_detail' },
    to: '/orders?status=sent',
  };
}

/* ---------- the control centre's conditions, read from the control centre's own model ---------- */

/**
 * `DASH-01`, ruling `#359` (owner, 05.09.2026): `/alerts` EXPANDS to cover what the control centre
 * counts. The cheap branch — reword the subtitle so it describes only the six scans above — was
 * weighed and rejected, because it turns a decision screen into an operational one and sends the
 * manager to three places to find out what is burning. That is constitution §12's own test.
 *
 * The sweep of 04.09.2026 measured the divergence it closes: `/dashboard` counted six attention
 * types and twenty-three open queue tasks, `/alerts` listed four findings, and only two conditions
 * appeared on both. Open exceptions — every one in the tenant — appeared on no version of this
 * screen at all.
 *
 * These conditions are read from `management_dashboard_snapshot`, THE SAME SERVER-SIDE READ MODEL
 * the control centre draws from, rather than re-derived here from the same tables. Two browser-side
 * copies of one predicate is how two screens come to answer differently about one business; a
 * single definition is the only arrangement under which they cannot (`summary.ts` says the same
 * about the business summary, for the same reason).
 *
 * NOTHING IS WIDENED, and that was a constraint rather than a happy outcome. The RPC serves `owner`
 * and `office` — exactly the two roles `routePolicy.ts` admits through the `/alerts` guard — it
 * narrows payment requests to the reader's own unit scope, and RLS scopes it to the caller's tenant
 * like every other query in this file. To any other role it answers `null`, which becomes a NAMED
 * FAILURE below and never a row of zeros.
 *
 * THE ONE CONDITION THE CONTROL CENTRE COUNTS AND THIS SCREEN STILL DOES NOT is bank reconciliation
 * (`snapshot.bank`). `/bank` is an owner+accountant route; `/alerts` is an owner+office one. A row
 * here would be a dead end for half of this screen's readers, and widening either role list to make
 * two numbers agree is the one repair this campaign forbids. The screen names the omission in words
 * instead (`alerts.text_3`).
 */
interface ControlCentreSnapshot {
  /** `payment_request_metrics` (`0218:385-407`), narrowed by `auth_scopes()`. */
  paymentRequests: { pendingApproval: number; drafts: number };
  /** `credit_metrics` (`0218:422-426`): `status in ('open','requested','received')`. */
  credits: { count: number };
  /** `invoice_metrics` (`0218:441-451`): payable, not soft-deleted. */
  invoices: { pendingApproval: number; toReview: number; notSent: number };
  /** `open_order_metrics` (`0218:470-476`): `status in ('sent','confirmed','partial')`. */
  openOrders: { count: number; late: number };
}

async function readControlCentre(): Promise<ControlCentreSnapshot> {
  const { data, error } = await supabase.rpc('management_dashboard_snapshot', { p_today: todayISO() });
  if (error) throw new Error(error.message);
  // `null` is the RPC's answer to a role it does not serve. That is "not measured", not "nothing
  // is open" — every condition below then arrives as a named failure and the screen says the scan
  // was partial, instead of eleven silent all-clears (CLAUDE.md:31).
  if (!data) throw new Error('control_centre_unavailable');
  return data as ControlCentreSnapshot;
}

/** One `Promise` per `scanAlerts()` call, so eleven findings cost one round trip. */
function memoize<T>(factory: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= factory());
}

interface ControlCentreAlertDefinition {
  code: string;
  labelKey: TKey;
  severity: AlertSeverity;
  /** The snapshot field. Named, not recomputed — the citation is in `ControlCentreSnapshot`. */
  read: (snapshot: ControlCentreSnapshot) => unknown;
  title: TKey;
  detail: TKey;
  /** The route the control centre's own row for this condition opens, so both land on one list. */
  to: string;
}

const CONTROL_CENTRE_ALERTS: readonly ControlCentreAlertDefinition[] = [
  {
    code: 'late_deliveries',
    labelKey: 'alerts.scan_late_deliveries',
    severity: 'critical',
    read: (snapshot) => snapshot.openOrders.late,
    title: 'alerts.lateDeliveries_title',
    detail: 'alerts.lateDeliveries_detail',
    // `DASH-04` settled this destination: `?status=late` on `/receiving`, and NOT `?status=attention`,
    // which is the wider set that also holds every partial receipt and every delivery due today.
    to: '/receiving?status=late',
  },
  {
    code: 'invoices_pending_approval',
    labelKey: 'alerts.scan_invoices_pending_approval',
    severity: 'warning',
    read: (snapshot) => snapshot.invoices.pendingApproval,
    title: 'alerts.invoicesPendingApproval_title',
    detail: 'alerts.invoicesPendingApproval_detail',
    to: '/invoices?review=pending_approval',
  },
  {
    code: 'payment_requests_pending_approval',
    labelKey: 'alerts.scan_payment_requests_pending_approval',
    severity: 'warning',
    read: (snapshot) => snapshot.paymentRequests.pendingApproval,
    title: 'alerts.paymentRequestsPendingApproval_title',
    detail: 'alerts.paymentRequestsPendingApproval_detail',
    to: '/payment-requests?status=pending_approval',
  },
  {
    code: 'invoices_to_review',
    labelKey: 'alerts.scan_invoices_to_review',
    severity: 'warning',
    read: (snapshot) => snapshot.invoices.toReview,
    title: 'alerts.invoicesToReview_title',
    detail: 'alerts.invoicesToReview_detail',
    // Both states the figure counts. The control centre's queue row carries the same pair — one of
    // them alone was a link opening a shorter list than the number above it.
    to: '/invoices?review=received,in_review',
  },
  {
    code: 'invoices_not_sent_to_accountant',
    labelKey: 'alerts.scan_invoices_not_sent_to_accountant',
    severity: 'warning',
    read: (snapshot) => snapshot.invoices.notSent,
    title: 'alerts.invoicesNotSent_title',
    detail: 'alerts.invoicesNotSent_detail',
    to: '/invoices?export=not_sent&review=approved',
  },
  {
    code: 'payment_request_drafts',
    labelKey: 'alerts.scan_payment_request_drafts',
    severity: 'info',
    read: (snapshot) => snapshot.paymentRequests.drafts,
    title: 'alerts.paymentRequestDrafts_title',
    detail: 'alerts.paymentRequestDrafts_detail',
    to: '/payment-requests?status=draft',
  },
  {
    code: 'open_credits',
    labelKey: 'alerts.scan_open_credits',
    severity: 'info',
    read: (snapshot) => snapshot.credits.count,
    title: 'alerts.openCredits_title',
    detail: 'alerts.openCredits_detail',
    to: '/credits?status=active',
  },
  {
    code: 'open_commitments',
    labelKey: 'alerts.scan_open_commitments',
    severity: 'info',
    read: (snapshot) => snapshot.openOrders.count,
    title: 'alerts.openCommitments_title',
    detail: 'alerts.openCommitments_detail',
    to: '/orders?status=sent,confirmed,partial',
  },
];

/** Same guard `rpcCount` applies: a figure that is not a whole non-negative number is no figure. */
function snapshotCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('count_unavailable');
  return count;
}

function controlCentreScan(
  definition: ControlCentreAlertDefinition,
  snapshot: () => Promise<ControlCentreSnapshot>,
): AlertScanDefinition<Alert, TKey> {
  return {
    code: definition.code,
    labelKey: definition.labelKey,
    run: async () => {
      const count = snapshotCount(definition.read(await snapshot()));
      if (!count) return null;
      return {
        code: definition.code,
        severity: definition.severity,
        title: { key: definition.title, vars: { count } },
        detail: { key: definition.detail },
        to: definition.to,
      };
    },
  };
}

/** Open exceptions, the one control-centre condition the snapshot does not carry.
 *
 *  Same predicate as the dashboard's own read — `status in ('open','in_progress')`, RLS-scoped —
 *  and `?status=open` on `/exceptions` is that pair rather than the literal `open` state
 *  (`Exceptions.tsx:109`), so the number and the list it opens are one set. Two HEAD counts: no
 *  row crosses the wire, and the high-severity subset rides the detail line the way the control
 *  centre's row carries it as a hint. */
async function countOpenExceptions(severity?: 'high'): Promise<number> {
  let query = supabase.from('exceptions').select('id', { count: 'exact', head: true })
    .in('status', ['open', 'in_progress']);
  if (severity) query = query.eq('severity', severity);
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return snapshotCount(count ?? 0);
}

async function scanOpenExceptions(): Promise<Alert | null> {
  const [total, high] = await Promise.all([countOpenExceptions(), countOpenExceptions('high')]);
  if (!total) return null;
  return {
    code: 'open_exceptions',
    severity: 'critical',
    title: { key: 'alerts.openExceptions_title', vars: { count: total } },
    detail: high
      ? { key: 'alerts.openExceptions_detailHigh', vars: { count: high } }
      : { key: 'alerts.openExceptions_detail' },
    to: '/exceptions?status=open',
  };
}

const SCANS: readonly AlertScanDefinition<Alert, TKey>[] = [
  { code: 'duplicate_invoice', labelKey: 'alerts.scan_duplicate_invoice', run: scanDuplicateInvoices },
  { code: 'open_exceptions', labelKey: 'alerts.scan_open_exceptions', run: scanOpenExceptions },
  { code: 'orders_awaiting_confirmation', labelKey: 'alerts.scan_orders_awaiting_confirmation', run: scanOrdersAwaitingConfirmation },
  { code: 'price_increase', labelKey: 'alerts.scan_price_increase', run: scanPriceIncreases },
  { code: 'above_average_price', labelKey: 'alerts.scan_above_average_price', run: scanPricedAboveAverage },
  { code: 'invoice_without_order', labelKey: 'alerts.scan_invoice_without_order', run: scanInvoicesWithoutOrder },
  { code: 'payment_due_soon', labelKey: 'alerts.scan_payment_due_soon', run: scanPaymentsDueSoon },
];

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Runs every scan and returns only the conditions that actually hold, most severe first.
 * A scan that finds nothing contributes nothing — the caller renders an empty list as
 * "אין התראות", never as a row of zeros.
 *
 * One failing scan does not blank the rest: a tenant whose price list is empty should still
 * see its duplicate invoices.
 */
export interface AlertScanResult {
  alerts: Alert[];
  complete: boolean;
  failures: { code: string; labelKey: TKey }[];
}

export async function scanAlerts(): Promise<AlertScanResult> {
  /* The shared read is created here and memoized, so the eight control-centre conditions cost one
     round trip between them. Each still fails on its OWN: when the RPC is refused or errors, every
     condition that depended on it is named separately in `failures`, because a reader has to know
     WHICH conditions went unchecked — "the scan was partial" without the list is the shape of
     answer this screen exists to replace. */
  const controlCentre = memoize(readControlCentre);
  const result = await settleAlertScans([
    ...SCANS,
    ...CONTROL_CENTRE_ALERTS.map((definition) => controlCentreScan(definition, controlCentre)),
  ]);
  result.alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return result;
}

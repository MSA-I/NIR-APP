import { supabase } from './supabase';
import { settleAlertScans } from './alertRules';
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

export interface Alert {
  code: string;
  severity: AlertSeverity;
  /** Short headline. Always carries the count — an alert with no occurrences is never returned. */
  title: string;
  /** One line of context, including any limit on what the scan actually covered. */
  detail: string;
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
    title: `${dupes} מספרי חשבונית מופיעים יותר מפעם אחת`,
    detail: 'אותו ספק, אותו מספר חשבונית — חשד לחיוב כפול',
    to: '/invoices',
  };
}

/** Catalogue price rises. Note the scope limit in `detail`: there is no invoice_items table,
 *  so this sees the price list, never what a supplier actually billed. */
async function scanPriceIncreases(): Promise<Alert | null> {
  const raised = await rpcCount(supabase.rpc('p2_recent_price_increase_count', {
    p_since: daysAgo(PRICE_INCREASE_WINDOW_DAYS),
  }));
  if (!raised) return null;

  return {
    code: 'price_increase',
    severity: 'warning',
    title: `${raised} מחירים עלו ב-${PRICE_INCREASE_WINDOW_DAYS} הימים האחרונים`,
    detail: 'לפי המחירון. מה שנגבה בפועל בחשבונית אינו נמדד — לחשבונית אין שורות פריטים',
    to: '/prices',
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
    title: `${over} הצעות מחיר גבוהות מהממוצע ביותר מ-${Math.round(ABOVE_AVG_MARGIN * 100)}%`,
    detail: 'נמדד רק על מוצרים שיש להם שני ספקים ומעלה',
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
    title: `${orphans} חשבוניות ללא הזמנת רכש מקושרת`,
    detail: 'רכישה ישירה יכולה להיות כזו כדין — שווה לוודא שלא נשמט קישור',
    to: '/invoices',
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
      ? `${late} דרישות תשלום עברו את מועד הפירעון`
      : `${total} דרישות תשלום לפירעון תוך ${DUE_SOON_DAYS} ימים`,
    detail: 'מכסה רק דרישות תשלום שהוזן להן תאריך. לחשבוניות אין מועד פירעון במערכת',
    to: '/payment-requests',
  };
}

/* ---------- not implemented, and why ----------
 *
 * Two of the seven alerts the client asked for have no data behind them. They are absent
 * rather than stubbed, and they must not be shown as "0" — zero is a claim about reality
 * (CLAUDE.md:31).
 *
 * מלאי נמוך      — nothing in the schema holds a stock quantity. products.min_stock is
 *                   marked "reserved for future inventory module" and received_qty only ever
 *                   counts goods in, never out, so there is no level to compare a threshold
 *                   against (OPEN-DECISIONS.md:17, PROGRESS.md:142).
 * חריגה בתקציב   — there is no budget table or column anywhere. Spend per category is
 *                   already computed in Dashboard.tsx; the target is missing, and it is a
 *                   business input, not something to derive.
 */

const SCANS = [
  { code: 'duplicate_invoice', label: 'חשבוניות כפולות', run: scanDuplicateInvoices },
  { code: 'price_increase', label: 'עליות מחיר', run: scanPriceIncreases },
  { code: 'above_average_price', label: 'מחירים מעל הממוצע', run: scanPricedAboveAverage },
  { code: 'invoice_without_order', label: 'חשבוניות ללא הזמנה', run: scanInvoicesWithoutOrder },
  { code: 'payment_due_soon', label: 'מועדי תשלום', run: scanPaymentsDueSoon },
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
  failures: { code: string; label: string }[];
}

export async function scanAlerts(): Promise<AlertScanResult> {
  const result = await settleAlertScans(SCANS);
  result.alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return result;
}

import { supabase } from './supabase';
import { unwrap } from './useQuery';
import { countDuplicateKeys, countAboveAverage } from './alertRules';
import { toLocalISO, todayISO } from './format';

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

/** Payment requests that still represent money owed. Excludes cancelled and already-matched. */
const PR_ACTIVE = ['draft', 'pending_approval', 'approved', 'sent_for_execution'];

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toLocalISO(d);
}

function daysAhead(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toLocalISO(d);
}

/* ---------- scans ---------- */

/** Invoices sharing a supplier + invoice number. checks.ts catches these at entry; this
 *  catches the ones already stored, including any entered before that check existed. */
async function scanDuplicateInvoices(): Promise<Alert | null> {
  // ponytail: grouped client-side. Fine at a few thousand invoices; move to an RPC with
  // `group by` if a tenant's invoice table outgrows a single page fetch.
  const rows = unwrap(await supabase.from('invoices')
    .select('supplier_id, invoice_number').is('deleted_at', null)) as
    { supplier_id: string; invoice_number: string }[];

  const dupes = countDuplicateKeys(rows);
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
  const rows = unwrap(await supabase.from('supplier_products')
    .select('current_price, previous_price')
    .not('previous_price', 'is', null)
    .gte('price_effective_date', daysAgo(PRICE_INCREASE_WINDOW_DAYS))) as
    { current_price: number; previous_price: number }[];

  const raised = rows.filter((r) => r.current_price > r.previous_price);
  if (!raised.length) return null;

  return {
    code: 'price_increase',
    severity: 'warning',
    title: `${raised.length} מחירים עלו ב-${PRICE_INCREASE_WINDOW_DAYS} הימים האחרונים`,
    detail: 'לפי המחירון. מה שנגבה בפועל בחשבונית אינו נמדד — לחשבונית אין שורות פריטים',
    to: '/prices',
  };
}

/** Offers sitting materially above the average of the other suppliers for the same product.
 *  Products with a single supplier are skipped — their own price *is* the average, and a
 *  deviation of zero is not a finding. */
async function scanPricedAboveAverage(): Promise<Alert | null> {
  const rows = unwrap(await supabase.from('supplier_products')
    .select('product_id, current_price').eq('available', true)) as
    { product_id: string; current_price: number }[];

  const over = countAboveAverage(rows, ABOVE_AVG_MARGIN);
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
  const [invoices, links] = await Promise.all([
    supabase.from('invoices').select('id').is('deleted_at', null).then(unwrap) as Promise<{ id: string }[]>,
    supabase.from('invoice_order_links').select('invoice_id').then(unwrap) as Promise<{ invoice_id: string }[]>,
  ]);

  const linked = new Set(links.map((l) => l.invoice_id));
  const orphans = invoices.filter((i) => !linked.has(i.id)).length;
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
  const rows = unwrap(await supabase.from('payment_requests')
    .select('id, due_date')
    .not('due_date', 'is', null)
    .lte('due_date', daysAhead(DUE_SOON_DAYS))
    .in('status', PR_ACTIVE)) as { id: string; due_date: string }[];

  if (!rows.length) return null;

  const today = todayISO();
  const late = rows.filter((r) => r.due_date < today).length;

  return {
    code: 'payment_due_soon',
    severity: late ? 'critical' : 'warning',
    title: late
      ? `${late} דרישות תשלום עברו את מועד הפירעון`
      : `${rows.length} דרישות תשלום לפירעון תוך ${DUE_SOON_DAYS} ימים`,
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
  scanDuplicateInvoices,
  scanPriceIncreases,
  scanPricedAboveAverage,
  scanInvoicesWithoutOrder,
  scanPaymentsDueSoon,
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
export async function scanAlerts(): Promise<Alert[]> {
  const settled = await Promise.allSettled(SCANS.map((s) => s()));
  return settled
    .flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

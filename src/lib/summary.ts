import { supabase } from './supabase';
import { unwrap } from './useQuery';
import { scanAlerts, type Alert } from './alerts';

/**
 * Business summary (סעיף 10).
 *
 * The client asked for an "AI Assistant" that answers, at a button press: how many invoices
 * came in this week, what is awaiting approval, what payments are expected, which suppliers
 * raised prices, which exceptions need attention, and what to do about it.
 *
 * Every one of those is a query. The original spec also lists "Advanced AI recommendations"
 * as explicitly out of MVP scope, so this is deliberately a plain data function — no model,
 * no API key, no per-call cost. The "recommendations" line is the alert scan, which is the
 * honest version of the same idea: conditions that actually hold, not generated prose.
 *
 * ponytail: swap in a language model only when the questions stop being countable.
 */

export type SummaryUnit = 'count' | 'currency';

export interface SummaryLine {
  key: string;
  label: string;
  /** null means "no data behind this figure" and must render as `—`. Zero is a real zero. */
  value: number | null;
  unit: SummaryUnit;
  to: string;
}

const WEEK_DAYS = 7;
const PRICE_INCREASE_WINDOW_DAYS = 30;
const PR_ACTIVE = ['draft', 'pending_approval', 'approved', 'sent_for_execution'];

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export interface Summary {
  lines: SummaryLine[];
  alerts: Alert[];
  generatedAt: Date;
}

export async function buildSummary(): Promise<Summary> {
  const [received, awaitingApproval, expected, raisedPrices, openExceptions, alerts] = await Promise.all([
    // 1. invoices received this week
    supabase.from('invoices').select('id', { count: 'exact', head: true })
      .is('deleted_at', null).gte('received_date', daysAgo(WEEK_DAYS))
      .then((r) => r.count ?? null),

    // 2. invoices awaiting approval.
    //    Reads invoices.review_status literally, because the line says "חשבוניות".
    //    Dashboard.tsx:124 counts `received|in_review` for its own card, which is a different
    //    set — that divergence is open decision #1 in docs/NIR-PLAN.md and is owned by the
    //    sections 1-6 work. When it is settled, this constant follows it rather than forking
    //    a third interpretation.
    supabase.from('invoices').select('id', { count: 'exact', head: true })
      .is('deleted_at', null).eq('review_status', 'pending_approval')
      .then((r) => r.count ?? null),

    // 3. money committed on active payment requests
    supabase.from('payment_requests').select('amount').in('status', PR_ACTIVE)
      .then((r) => {
        const rows = unwrap(r) as { amount: number }[];
        return rows.reduce((s, x) => s + x.amount, 0);
      }),

    // 4. distinct suppliers who raised a catalogue price in the window
    supabase.from('supplier_products').select('supplier_id, current_price, previous_price')
      .not('previous_price', 'is', null)
      .gte('price_effective_date', daysAgo(PRICE_INCREASE_WINDOW_DAYS))
      .then((r) => {
        const rows = unwrap(r) as { supplier_id: string; current_price: number; previous_price: number }[];
        return new Set(rows.filter((x) => x.current_price > x.previous_price).map((x) => x.supplier_id)).size;
      }),

    // 5. exceptions still needing a decision
    supabase.from('exceptions').select('id', { count: 'exact', head: true })
      .in('status', ['open', 'in_progress'])
      .then((r) => r.count ?? null),

    scanAlerts(),
  ]);

  const lines: SummaryLine[] = [
    { key: 'received_week', label: `חשבוניות שנקלטו ב-${WEEK_DAYS} הימים האחרונים`, value: received, unit: 'count', to: '/invoices' },
    { key: 'awaiting_approval', label: 'חשבוניות הממתינות לאישור', value: awaitingApproval, unit: 'count', to: '/invoices' },
    { key: 'expected_payments', label: 'סכום פתוח בדרישות תשלום', value: expected, unit: 'currency', to: '/payment-requests' },
    { key: 'suppliers_raised', label: `ספקים שהעלו מחיר ב-${PRICE_INCREASE_WINDOW_DAYS} הימים האחרונים`, value: raisedPrices, unit: 'count', to: '/prices' },
    { key: 'open_exceptions', label: 'חריגים פתוחים', value: openExceptions, unit: 'count', to: '/exceptions' },
  ];

  return { lines, alerts, generatedAt: new Date() };
}

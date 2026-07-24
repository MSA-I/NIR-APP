import { supabase } from './supabase';
import { scanAlerts, type Alert } from './alerts';
import { addCalendarDays, todayISO } from './format';
import { readExactCount } from './queryResult';

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

function daysAgo(n: number): string {
  return addCalendarDays(todayISO(), -n);
}

async function rpcNumber(
  request: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<number> {
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  const value = Number(data);
  if (!Number.isFinite(value) || value < 0) throw new Error('metric_unavailable');
  return value;
}

export interface Summary {
  lines: SummaryLine[];
  alerts: Alert[];
  complete: boolean;
  failures: { code: string; label: string }[];
  generatedAt: Date;
}

export async function buildSummary(): Promise<Summary> {
  const definitions: (Omit<SummaryLine, 'value'> & { run: () => Promise<number> })[] = [
    // 1. invoices received this week
    { key: 'received_week', label: `חשבוניות שנקלטו ב-${WEEK_DAYS} הימים האחרונים`, unit: 'count', to: '/invoices', run: () => readExactCount(
      supabase.from('invoices').select('id', { count: 'exact', head: true })
        .is('deleted_at', null).gte('received_date', daysAgo(WEEK_DAYS)),
    ) },

    // 2. invoices awaiting approval.
    //    Reads invoices.review_status literally, because the line says "חשבוניות".
    //    Dashboard.tsx:124 counts `received|in_review` for its own card, which is a different
    //    set — that divergence is open decision #1 in docs/NIR-PLAN.md and is owned by the
    //    sections 1-6 work. When it is settled, this constant follows it rather than forking
    //    a third interpretation.
    { key: 'awaiting_approval', label: 'חשבוניות הממתינות לאישור', unit: 'count', to: '/invoices', run: () => readExactCount(
      supabase.from('invoices').select('id', { count: 'exact', head: true })
        .is('deleted_at', null).eq('review_status', 'pending_approval'),
    ) },

    // 3. money committed on active payment requests
    { key: 'expected_payments', label: 'סכום פתוח בדרישות תשלום', unit: 'currency', to: '/payment-requests', run: () => rpcNumber(
      supabase.rpc('p2_active_payment_request_total'),
    ) },

    // 4. distinct suppliers who raised a catalogue price in the window
    { key: 'suppliers_raised', label: `ספקים שהעלו מחיר ב-${PRICE_INCREASE_WINDOW_DAYS} הימים האחרונים`, unit: 'count', to: '/prices', run: () => rpcNumber(
      supabase.rpc('p2_suppliers_with_price_increase_since', {
        p_since: daysAgo(PRICE_INCREASE_WINDOW_DAYS),
      }),
    ) },

    // 5. exceptions still needing a decision
    { key: 'open_exceptions', label: 'חריגים פתוחים', unit: 'count', to: '/exceptions', run: () => readExactCount(
      supabase.from('exceptions').select('id', { count: 'exact', head: true }).in('status', ['open', 'in_progress']),
    ) },
  ];
  const [settled, alertScan] = await Promise.all([
    Promise.allSettled(definitions.map((definition) => definition.run())),
    scanAlerts(),
  ]);
  const failures: { code: string; label: string }[] = [...alertScan.failures];
  const lines = definitions.map(({ run: _run, ...definition }, index): SummaryLine => {
    const result = settled[index];
    if (result.status === 'fulfilled') return { ...definition, value: result.value };
    failures.push({ code: definition.key, label: definition.label });
    return { ...definition, value: null };
  });

  return { lines, alerts: alertScan.alerts, complete: failures.length === 0, failures, generatedAt: new Date() };
}

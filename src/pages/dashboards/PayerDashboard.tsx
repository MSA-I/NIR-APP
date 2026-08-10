import { Link } from 'react-router';
import { Banknote, TriangleAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useQuery } from '../../lib/useQuery';
import { fetchAll } from '../../lib/supabasePaging';
import { readExactCount } from '../../lib/queryResult';
import { DOMAIN } from '../../lib/query/keys';
import { AttentionZone, SkeletonCards, ErrorNote, Note, type AttentionItem } from '../../components/ui';
import { Scorecard, type ScoreItem } from '../../components/supplier-metrics';
import { SpendBarChart, money } from '../../components/charts';
import { addCalendarDays, fmtMonth, fmtMoneyExact, monthlyBuckets, shiftCalendarMonth, todayISO } from '../../lib/format';
import { DashboardFrame, ChartCard } from './parts';

type QueueRow = { due_date: string | null; amount: number };
type Payment = { amount: number; paid_date: string };

/** The payer's queue: what has been approved and is waiting to move, or has been sent to move. */
const PENDING_STATUSES = ['approved', 'sent_for_execution'];

/**
 * Reads a scalar aggregate RPC. Same shape and same refusal as `summary.ts:39-47`: a value that is
 * not a finite non-negative number is a failed metric, not a zero.
 */
async function readServerAmount(
  request: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<number> {
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  const value = Number(data);
  if (!Number.isFinite(value) || value < 0) throw new Error('metric_unavailable');
  return value;
}

/**
 * Payer control room (execution keyhole). RLS narrows the payer to its own approved-request queue and
 * its own executed payments — nothing else. Two charts is the honest ceiling for that data; there is
 * no third series to draw without inventing it (CLAUDE.md).
 *
 * ── The aggregation shape (PLAN-10 §3, the proof-of-pattern slice of the dashboard debt) ──
 *
 * This screen used to be two `fetchAll` scans feeding one `try`: any single failure produced one
 * error note and no numbers at all. It is now a set of INDEPENDENT metrics settled with
 * `Promise.allSettled`, exactly the `summary.ts:93-105` contract:
 *
 *   * every metric has a Hebrew name, and a failed metric is reported by that name;
 *   * a failed metric renders `—`, never `0` — zero is a claim about the business (CLAUDE.md);
 *   * one failure never blanks the rest, and `complete: false` says the picture is partial.
 *
 * What moved to the server, and what deliberately did not:
 *
 *   moved  · the three DECISION counts (overdue / due today / waiting) are `count: 'exact', head:
 *            true` reads — the row bodies never cross the wire, and they survive a failure of the
 *            amount read below, which is the whole point of splitting them out: a payer who cannot
 *            see sums must still be told that three transfers are late.
 *   moved  · the waiting TOTAL is `p2_active_payment_request_total()` (0024:371), a server sum.
 *   stayed · the per-due-bucket sums and the four-month executed series still read rows, because
 *            **no aggregate RPC in 0068-0070 groups an amount by due bucket or by month**, and this
 *            wave does not invent a migration to get one (PLAN-10 §1: the dashboard aggregation debt
 *            is a wave of its own, ~20-25 RPCs and four frozen business decisions). `fetchAll` is
 *            the documented right tool while the whole set genuinely is the answer
 *            (`supabasePaging.ts:6-8`); each of the two reads is now its own settled metric, so one
 *            failing leaves the other, and the counts, on screen.
 */
export default function PayerDashboard() {
  const today = todayISO();
  const { data, loading, error } = useQuery(async () => {
    const monthKey = today.slice(0, 7);
    const chartsFrom = `${shiftCalendarMonth(monthKey, -3)}-01`;
    const weekEnd = addCalendarDays(today, 7);

    /** A fresh builder per call — a PostgREST builder is single-use. */
    const queue = () => supabase.from('payment_requests')
      .select('id', { count: 'exact', head: true }).in('status', PENDING_STATUSES);

    const settled = await Promise.allSettled([
      readExactCount(queue().lt('due_date', today)),
      readExactCount(queue().eq('due_date', today)),
      readExactCount(queue()),
      // Correct here because of two facts, and only here: `RoleDashboard.tsx:17` renders this screen
      // for the `payer` role alone, and `payment_requests_select` (0034:421-430) hides `draft` and
      // `pending_approval` from a payer — so the RPC's wider status list intersects with the payer's
      // RLS projection to exactly PENDING_STATUSES. Rendering this component for another role would
      // silently fold drafts into the figure.
      readServerAmount(supabase.rpc('p2_active_payment_request_total')),
      fetchAll((from, to) => supabase.from('payment_requests')
        .select('due_date, amount').in('status', PENDING_STATUSES).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('payments')
        .select('amount, paid_date').gte('paid_date', chartsFrom).lte('paid_date', today).order('id').range(from, to)),
    ] as const);

    const failures: { code: string; label: string }[] = [];
    const take = <T,>(result: PromiseSettledResult<T>, code: string, label: string): T | null => {
      if (result.status === 'fulfilled') return result.value;
      failures.push({ code, label });
      return null;
    };
    const overdueCount = take(settled[0], 'overdue_count', 'מספר התשלומים באיחור');
    const dueTodayCount = take(settled[1], 'due_today_count', 'מספר התשלומים לביצוע היום');
    const pendingCount = take(settled[2], 'pending_count', 'מספר ההעברות הממתינות');
    const pendingTotal = take(settled[3], 'pending_total', 'סך ההעברות הממתינות');
    // The same double cast the previous version used: without generated DB types supabase-js infers
    // an awkward structural type from a select string, so the row shape is asserted at the boundary.
    const queueRaw = take(settled[4], 'due_amounts', 'סכומי ההעברות לפי מועד');
    const paymentRaw = take(settled[5], 'executed_payments', 'ההעברות שבוצעו');
    const queueRows = queueRaw === null ? null : (queueRaw as unknown as QueueRow[]);
    const paymentRows = paymentRaw === null ? null : (paymentRaw as unknown as Payment[]);

    const isOverdue = (r: QueueRow) => !!r.due_date && r.due_date < today;
    const isDueToday = (r: QueueRow) => r.due_date === today;
    const isDueWeek = (r: QueueRow) => !!r.due_date && r.due_date > today && r.due_date <= weekEnd;
    const isLater = (r: QueueRow) => !r.due_date || r.due_date > weekEnd;

    /** null when the row read failed, and null when there is nothing in the bucket — a dash either
     *  way, which is what this tile has always shown rather than ₪0.00 for an empty bucket. */
    const bucketAmount = (match: (row: QueueRow) => boolean): number | null => {
      if (queueRows === null) return null;
      const rows = queueRows.filter(match);
      return rows.length ? rows.reduce((sum, row) => sum + (row.amount ?? 0), 0) : null;
    };
    const overdueAmount = bucketAmount(isOverdue);
    const dueTodayAmount = bucketAmount(isDueToday);

    const paymentsThisMonth = paymentRows?.filter((p) => p.paid_date.slice(0, 7) === monthKey) ?? [];
    const paidMonth = paymentsThisMonth.length ? paymentsThisMonth.reduce((s, p) => s + p.amount, 0) : null;

    const kpis: ScoreItem[] = [
      { label: 'לביצוע היום', value: fmtMoneyExact(dueTodayAmount), tone: dueTodayCount ? 'await' : 'idle' },
      { label: 'באיחור', value: fmtMoneyExact(overdueAmount), tone: overdueCount ? 'alert' : 'idle' },
      // The measured count decides between "nothing waiting" (dash, as before) and a real sum; the
      // sum itself is the server's. Neither half is invented and neither is a substituted zero.
      { label: 'סה״כ ממתין לביצוע', value: fmtMoneyExact(pendingCount === 0 ? null : pendingTotal) },
      { label: 'בוצע החודש', value: fmtMoneyExact(paidMonth), tone: paidMonth ? 'done' : 'idle' },
    ];

    // count === null lands in AttentionZone's neutral "—" tier: an unmeasured row can never be
    // read as an all-clear (ui.tsx:224-227).
    const attention: AttentionItem[] = [
      { key: 'overdue', label: 'תשלומים באיחור', count: overdueCount, amount: overdueAmount, tone: 'alert', to: '/pay', clearLabel: 'אין תשלומים באיחור' },
      { key: 'today', label: 'תשלומים לביצוע היום', count: dueTodayCount, amount: dueTodayAmount, tone: 'await', to: '/pay', clearLabel: 'אין תשלומים להיום' },
      { key: 'pending', label: 'ממתינים לביצוע העברה', count: pendingCount, amount: pendingTotal, tone: 'idle', to: '/pay', clearLabel: 'אין העברות ממתינות' },
    ];

    // ── charts
    const monthly = paymentRows === null ? [] : monthlyBuckets(
      paymentRows.map((p) => ({ date: p.paid_date, value: p.amount })), { monthKey, months: 4 },
    ).map((b) => ({ key: fmtMonth(`${b.key}-01`), label: b.count ? money(b.total) : '', total: b.total }));

    const dueBuckets = queueRows === null || queueRows.length === 0
      ? []
      : [
          { name: 'באיחור', total: overdueAmount ?? 0 },
          { name: 'היום', total: dueTodayAmount ?? 0 },
          { name: 'השבוע', total: bucketAmount(isDueWeek) ?? 0 },
          { name: 'בהמשך', total: bucketAmount(isLater) ?? 0 },
        ].map((b) => ({ key: b.name, label: b.total ? money(b.total) : '', total: b.total }));

    // An empty chart must not claim "no transfers" when the truth is "not loaded".
    const monthlyEmpty = paymentRows === null
      ? 'לא ניתן לטעון את ההעברות שבוצעו' : 'לא בוצעו העברות בתקופה';
    const dueEmpty = queueRows === null
      ? 'לא ניתן לטעון את סכומי ההמתנה' : 'אין העברות ממתינות';

    return {
      kpis, attention, monthly, dueBuckets, monthlyEmpty, dueEmpty,
      complete: failures.length === 0, failures,
    };
    // `[]` for deps and a real key: in cached mode the deps are ignored and the key is what
    // identifies the entry, so the calendar day belongs IN the key — yesterday's buckets must not be
    // served to today's payer (the Bank.tsx:128-131 idiom).
  }, [], [DOMAIN.dashboard, 'payer', today]);

  if (loading) return <SkeletonCards count={4} cols={4} title />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return null;

  return (
    <DashboardFrame title="מרכז הבקרה — ביצוע העברות" actions={
      <Link to="/pay" className="btn-primary"><Banknote size={16} /> לביצוע העברות</Link>
    }>
      {/* A refetch that fails after the first success keeps the figures on screen, but it says so —
          silently showing values from a minute ago is how a stale money figure becomes a decision. */}
      {error && <ErrorNote message={error} />}
      {!data.complete && (
        <Note tone="alert" role="alert">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            התמונה חלקית: {data.failures.map((failure) => failure.label).join(', ')} לא נטענו.
            מה שכן נמדד מוצג; מדד שלא נטען מסומן ב־—, ולא באפס.
          </span>
        </Note>
      )}
      <AttentionZone items={data.attention} />
      <Scorecard items={data.kpis} />
      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="העברות שבוצעו לפי חודש" subtitle="סך ההעברות שביצעת בארבעת החודשים האחרונים">
          <SpendBarChart points={data.monthly}
            ariaLabel={`העברות שבוצעו לפי חודש: ${data.monthly.map((p) => `${p.key} ${p.label || 'אין העברות'}`).join(', ')}`}
            emptyMessage={data.monthlyEmpty} />
        </ChartCard>
        <ChartCard title="ממתין לביצוע לפי מועד" subtitle="סכומי ההעברות הממתינות, לפי מועד הפירעון">
          <SpendBarChart points={data.dueBuckets} maxBarSize={64}
            ariaLabel={`ממתין לביצוע לפי מועד: ${data.dueBuckets.map((p) => `${p.key} ${p.label || 'אין'}`).join(', ')}`}
            emptyMessage={data.dueEmpty} />
        </ChartCard>
      </div>
    </DashboardFrame>
  );
}

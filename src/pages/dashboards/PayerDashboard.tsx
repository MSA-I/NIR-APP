import { Link } from 'react-router-dom';
import { Banknote } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useQuery } from '../../lib/useQuery';
import { fetchAll } from '../../lib/supabasePaging';
import { AttentionZone, SkeletonCards, ErrorNote, type AttentionItem } from '../../components/ui';
import { Scorecard, type ScoreItem } from '../../components/supplier-metrics';
import { SpendBarChart, money } from '../../components/charts';
import { addCalendarDays, fmtMonth, fmtMoney, monthlyBuckets, shiftCalendarMonth, todayISO } from '../../lib/format';
import { DashboardFrame, ChartCard } from './parts';

type Pr = { status: string; due_date: string | null; amount: number };
type Payment = { amount: number; paid_date: string };

/**
 * Payer control room (execution keyhole). RLS narrows the payer to its own approved-request queue and
 * its own executed payments — nothing else. Two charts is the honest ceiling for that data; there is
 * no third series to draw without inventing it (CLAUDE.md).
 */
export default function PayerDashboard() {
  const { data, loading, error } = useQuery(async () => {
    const today = todayISO();
    const monthKey = today.slice(0, 7);
    const chartsFrom = `${shiftCalendarMonth(monthKey, -3)}-01`;
    const weekEnd = addCalendarDays(today, 7);

    const [prsRes, paymentsRes] = await Promise.all([
      fetchAll((from, to) => supabase.from('payment_requests').select('status, due_date, amount').in('status', ['approved', 'sent_for_execution']).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('payments').select('amount, paid_date').gte('paid_date', chartsFrom).lte('paid_date', today).order('id').range(from, to)),
    ]);

    const prs = prsRes as unknown as Pr[];
    const payments = paymentsRes as unknown as Payment[];
    const sum = (list: Pr[]) => list.reduce((s, r) => s + (r.amount ?? 0), 0);

    const overdue = prs.filter((r) => r.due_date && r.due_date < today);
    const dueToday = prs.filter((r) => r.due_date === today);
    const dueWeek = prs.filter((r) => r.due_date && r.due_date > today && r.due_date <= weekEnd);
    const later = prs.filter((r) => !r.due_date || r.due_date > weekEnd);

    const paymentsThisMonth = payments.filter((p) => p.paid_date.slice(0, 7) === monthKey);
    const paidMonth = paymentsThisMonth.length ? paymentsThisMonth.reduce((s, p) => s + p.amount, 0) : null;

    const kpis: ScoreItem[] = [
      { label: 'לביצוע היום', value: fmtMoney(dueToday.length ? sum(dueToday) : null), tone: dueToday.length ? 'amber' : 'slate' },
      { label: 'באיחור', value: fmtMoney(overdue.length ? sum(overdue) : null), tone: overdue.length ? 'red' : 'slate' },
      { label: 'סה״כ ממתין לביצוע', value: fmtMoney(prs.length ? sum(prs) : null) },
      { label: 'בוצע החודש', value: fmtMoney(paidMonth), tone: paidMonth ? 'green' : 'slate' },
    ];

    const attention: AttentionItem[] = [
      { key: 'overdue', label: 'תשלומים באיחור', count: overdue.length, amount: sum(overdue), tone: 'alert', to: '/pay', clearLabel: 'אין תשלומים באיחור' },
      { key: 'today', label: 'תשלומים לביצוע היום', count: dueToday.length, amount: sum(dueToday), tone: 'await', to: '/pay', clearLabel: 'אין תשלומים להיום' },
      { key: 'pending', label: 'ממתינים לביצוע העברה', count: prs.length, amount: sum(prs), tone: 'idle', to: '/pay', clearLabel: 'אין העברות ממתינות' },
    ];

    // ── charts
    const monthly = monthlyBuckets(payments.map((p) => ({ date: p.paid_date, value: p.amount })), { monthKey, months: 4 })
      .map((b) => ({ key: fmtMonth(`${b.key}-01`), label: b.count ? money(b.total) : '', total: b.total }));

    const dueBuckets = prs.length
      ? [
          { name: 'באיחור', total: sum(overdue) },
          { name: 'היום', total: sum(dueToday) },
          { name: 'השבוע', total: sum(dueWeek) },
          { name: 'בהמשך', total: sum(later) },
        ].map((b) => ({ key: b.name, label: b.total ? money(b.total) : '', total: b.total }))
      : [];

    return { kpis, attention, monthly, dueBuckets };
  });

  if (loading) return <SkeletonCards count={4} cols={4} title />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  return (
    <DashboardFrame title="מרכז הבקרה — ביצוע העברות" actions={
      <Link to="/pay" className="btn-primary"><Banknote size={16} /> לביצוע העברות</Link>
    }>
      <Scorecard items={data.kpis} />
      <AttentionZone items={data.attention} />
      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="העברות שבוצעו לפי חודש" subtitle="סך ההעברות שביצעת בארבעת החודשים האחרונים">
          <SpendBarChart points={data.monthly}
            ariaLabel={`העברות שבוצעו לפי חודש: ${data.monthly.map((p) => `${p.key} ${p.label || 'אין העברות'}`).join(', ')}`}
            emptyMessage="לא בוצעו העברות בתקופה" />
        </ChartCard>
        <ChartCard title="ממתין לביצוע לפי מועד" subtitle="סכומי ההעברות הממתינות, לפי מועד הפירעון">
          <SpendBarChart points={data.dueBuckets} maxBarSize={64}
            ariaLabel={`ממתין לביצוע לפי מועד: ${data.dueBuckets.map((p) => `${p.key} ${p.label || 'אין'}`).join(', ')}`}
            emptyMessage="אין העברות ממתינות" />
        </ChartCard>
      </div>
    </DashboardFrame>
  );
}

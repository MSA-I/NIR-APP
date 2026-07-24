import { Link } from 'react-router-dom';
import { Camera, ReceiptText, ShieldCheck } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useQuery } from '../../lib/useQuery';
import { fetchAll } from '../../lib/supabasePaging';
import { SkeletonCards, ErrorNote } from '../../components/ui';
import { Scorecard, type ScoreItem } from '../../components/supplier-metrics';
import { ComparisonLineChart, SpendBarChart, type LinePoint } from '../../components/charts';
import { chartTheme } from '../../lib/theme';
import { fmtDate, fmtMonth, fmtNum, monthlyBuckets, shiftCalendarMonth, todayISO } from '../../lib/format';
import { DashboardFrame, ChartCard } from './parts';

type Product = { available: boolean | null; price_effective_date: string | null };
type History = { effective_date: string };
// Live schema (differs from migration 0026): a monthly price-list submission, valued by row composition.
type Submission = { effective_month: string; row_count: number; created_count: number; updated_count: number; unchanged_count: number; submitted_at: string };

/**
 * Supplier control room. RLS exposes only this supplier's own catalog, price history and monthly
 * price-list submissions — nothing about the buying org. Counts render as counts (fmtNum), never ₪.
 */
export default function SupplierDashboard() {
  const { data, loading, error } = useQuery(async () => {
    const today = todayISO();
    const monthKey = today.slice(0, 7);

    const [productsRes, historyRes, submissionsRes] = await Promise.all([
      fetchAll((from, to) => supabase.from('supplier_products').select('available, price_effective_date').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('price_history').select('effective_date').gte('effective_date', `${shiftCalendarMonth(monthKey, -5)}-01`).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('supplier_price_submissions').select('effective_month, row_count, created_count, updated_count, unchanged_count, submitted_at').order('effective_month').range(from, to)),
    ]);

    const products = productsRes as unknown as Product[];
    const history = historyRes as unknown as History[];
    const submissions = submissionsRes as unknown as Submission[];

    const last = submissions[submissions.length - 1];
    const submitted = !!last && last.effective_month.slice(0, 7) === monthKey;
    const updatedThisMonth = history.filter((h) => h.effective_date.slice(0, 7) === monthKey).length;

    const kpis: ScoreItem[] = [
      { label: 'מוצרים במחירון', value: fmtNum(products.length) },
      { label: 'זמינים', value: fmtNum(products.filter((p) => p.available).length) },
      { label: 'עודכנו החודש', value: fmtNum(updatedThisMonth) },
      { label: 'הגשה אחרונה', value: last ? fmtMonth(last.effective_month) : '—', sub: last ? `${last.row_count} שורות` : undefined, numeric: false },
    ];

    // ── charts
    const changes = monthlyBuckets(history.map((h) => ({ date: h.effective_date, value: 1 })), { monthKey, months: 6 })
      .map((b) => ({ key: fmtMonth(`${b.key}-01`), label: b.count ? fmtNum(b.total) : '', total: b.total }));

    const intake: LinePoint[] = submissions.slice(-6).map((s) => ({
      x: fmtMonth(s.effective_month),
      created: s.created_count,
      updated: s.updated_count,
    }));

    return { kpis, submitted, lastDate: last?.submitted_at ?? null, changes, intake };
  });

  if (loading) return <SkeletonCards count={4} cols={4} title />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  const t = chartTheme();

  return (
    <DashboardFrame title="מרכז הבקרה — ספק" actions={
      <Link to="/my-prices" className="btn-primary"><Camera size={16} /> הגשת מחירון חודשי</Link>
    }>
      <div className={`card card-pad flex items-start gap-3 ${data.submitted ? '' : 'border-await-line'}`}>
        {data.submitted
          ? <ShieldCheck size={20} className="text-done-solid shrink-0" />
          : <ReceiptText size={20} className="text-await-fg shrink-0" />}
        <div>
          <div className="text-sm font-medium text-ink-body">
            {data.submitted ? 'המחירון לחודש הנוכחי הוגש' : 'טרם הוגש מחירון לחודש הנוכחי'}
          </div>
          <div className="text-xs text-ink-muted mt-0.5">
            {data.lastDate ? `הגשה אחרונה: ${fmtDate(data.lastDate)}` : 'עדיין לא הוגשו מחירונים'}
          </div>
        </div>
      </div>
      <Scorecard items={data.kpis} />
      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="שינויי מחיר לפי חודש" subtitle="כמה מחירים עודכנו בכל חודש (ששת החודשים האחרונים)">
          <SpendBarChart points={data.changes} valueFormatter={fmtNum}
            ariaLabel={`שינויי מחיר לפי חודש: ${data.changes.map((p) => `${p.key} ${p.label || 'אין'}`).join(', ')}`}
            emptyMessage="אין שינויי מחיר בתקופה" />
        </ChartCard>
        <ChartCard title="הרכב הגשות" subtitle="מחירים חדשים מול מחירים שעודכנו בכל הגשה">
          <ComparisonLineChart points={data.intake} xKey="x" legend valueFormatter={fmtNum}
            series={[{ key: 'created', name: 'חדשים', color: t.bars[0] }, { key: 'updated', name: 'עודכנו', color: t.bars[2], dashed: true }]}
            ariaLabel="מחירים חדשים מול מעודכנים, לפי הגשה"
            emptyMessage="אין היסטוריית הגשות" />
        </ChartCard>
      </div>
    </DashboardFrame>
  );
}

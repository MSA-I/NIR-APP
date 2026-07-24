import { Link } from 'react-router-dom';
import { PackageCheck, ShoppingCart } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useQuery } from '../../lib/useQuery';
import { fetchAll } from '../../lib/supabasePaging';
import { AttentionZone, SkeletonCards, ErrorNote, type AttentionItem } from '../../components/ui';
import { Scorecard, fmtPct, fmtLeadDays, type ScoreItem, type ScoreTone } from '../../components/supplier-metrics';
import { CategoryDonut, ComparisonLineChart, SpendBarChart, money, type LinePoint } from '../../components/charts';
import { chartTheme } from '../../lib/theme';
import { topCategoriesWithOther } from '../../lib/dashboardSeries';
import {
  addCalendarDays, dateStartInstant, fmtMonth, fmtMoney, fmtNum, monthlyBuckets, shiftCalendarMonth,
  startOfCalendarWeek, todayISO, weeklyBuckets,
} from '../../lib/format';
import { DashboardFrame, ChartCard } from './parts';

type OrderItem = { qty: number; unit_price: number };
type OpenPo = { status: string; expected_date: string | null; items: { qty: number; unit_price: number; received_qty: number }[] };
type RecentOrder = { created_at: string; items: OrderItem[] };
type PoItem = { qty: number; unit_price: number; product: { category: { name: string } | null } | null; order: { created_at: string } };
type Receipt = { received_at: string; items: { qty_received: number; order_item: { unit_price: number } | null }[] };
type Metric = { on_time_pct: number | null; otd_samples: number; avg_lead_days: number | null; lead_samples: number };

const orderValue = (items: OrderItem[]) => items.reduce((s, i) => s + i.qty * i.unit_price, 0);

// A supplier's on-time rate needs ≥5 samples to be claimed (mirrors Suppliers.tsx / Analytics.tsx).
function otdTone(pct: number | null): ScoreTone {
  if (pct == null) return 'slate';
  if (pct >= 90) return 'green';
  if (pct >= 75) return 'amber';
  return 'red';
}

/**
 * Kitchen control room (procurement/receiving). Every query is RLS-scoped to what kitchen may read:
 * purchase orders + items, goods receipts, supplier balances and the supplier_metrics view. No
 * finance tables. Empty sources render "—" / an empty-state, never a fabricated 0 (CLAUDE.md).
 */
export default function KitchenDashboard() {
  const { data, loading, error } = useQuery(async () => {
    const now = new Date();
    const today = todayISO();
    const monthKey = today.slice(0, 7);
    const monthStart = `${monthKey}-01`;
    const monthStartTs = dateStartInstant(monthStart);
    const eightWeeksAgoTs = dateStartInstant(addCalendarDays(startOfCalendarWeek(today), -7 * 7));
    const chartsFromTs = dateStartInstant(`${shiftCalendarMonth(monthKey, -3)}-01`);
    const nowISO = now.toISOString();

    const [openRes, ordersRes, poItemsRes, receiptsRes, supBalRes, metricsRes] = await Promise.all([
      fetchAll((from, to) => supabase.from('purchase_orders').select('status, expected_date, items:purchase_order_items(qty, unit_price, received_qty)').in('status', ['sent', 'confirmed', 'partial']).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('purchase_orders').select('created_at, items:purchase_order_items(qty, unit_price)').gte('created_at', chartsFromTs).lte('created_at', nowISO).not('status', 'in', '(draft,cancelled)').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('purchase_order_items').select('qty, unit_price, product:products(category:categories(name)), order:purchase_orders!inner(created_at, status)').gte('order.created_at', monthStartTs).lte('order.created_at', nowISO).not('order.status', 'in', '(draft,cancelled)').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('goods_receipts').select('received_at, items:goods_receipt_items(qty_received, order_item:purchase_order_items(unit_price))').gte('received_at', eightWeeksAgoTs).lte('received_at', nowISO).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('supplier_balances').select('open_balance').gt('open_balance', 0).order('supplier_id').range(from, to)),
      fetchAll((from, to) => supabase.from('supplier_metrics').select('on_time_pct, otd_samples, avg_lead_days, lead_samples').order('supplier_id').range(from, to)),
    ]);

    const openPos = openRes as unknown as OpenPo[];
    const orders = ordersRes as unknown as RecentOrder[];
    const poItems = poItemsRes as unknown as PoItem[];
    const receipts = receiptsRes as unknown as Receipt[];
    const supBal = supBalRes as unknown as { open_balance: number }[];
    const metrics = metricsRes as unknown as Metric[];

    // ── KPIs
    const ordersThisMonth = orders.filter((o) => o.created_at.slice(0, 7) === monthKey);
    const purchasedMonth = ordersThisMonth.length ? ordersThisMonth.reduce((s, o) => s + orderValue(o.items), 0) : null;
    const remaining = openPos.reduce((s, o) => s + o.items.reduce((t, i) => t + Math.max(0, (i.qty - i.received_qty) * i.unit_price), 0), 0);
    const openValue = openPos.length ? remaining : null;
    const openBalance = supBal.length ? supBal.reduce((s, b) => s + b.open_balance, 0) : null;

    // on-time %: sample-weighted across suppliers that have a measurable rate; null when none do.
    const otdSuppliers = metrics.filter((m) => m.on_time_pct != null && m.otd_samples > 0);
    const otdSamples = otdSuppliers.reduce((s, m) => s + m.otd_samples, 0);
    const otdPct = otdSamples ? otdSuppliers.reduce((s, m) => s + m.on_time_pct! * m.otd_samples, 0) / otdSamples : null;
    const leadSuppliers = metrics.filter((m) => m.avg_lead_days != null && m.lead_samples > 0);
    const leadSamples = leadSuppliers.reduce((s, m) => s + m.lead_samples, 0);
    const avgLead = leadSamples ? leadSuppliers.reduce((s, m) => s + m.avg_lead_days! * m.lead_samples, 0) / leadSamples : null;

    const kpis: ScoreItem[] = [
      { label: 'נרכש החודש', value: fmtMoney(purchasedMonth) },
      { label: 'פתוח לקבלה', value: fmtMoney(openValue), tone: openValue ? 'amber' : 'slate' },
      { label: 'הזמנות פתוחות', value: fmtNum(openPos.length) },
      { label: 'יתרת ספקים פתוחה', value: fmtMoney(openBalance) },
      { label: 'עמידה בזמנים', value: fmtPct(otdPct), tone: otdTone(otdPct) },
      { label: 'ימי אספקה ממוצעים', value: fmtLeadDays(avgLead) },
    ];

    // ── attention (unchanged behavior from the old text dashboard)
    const late = openPos.filter((o) => o.expected_date && o.expected_date < today).length;
    const dueToday = openPos.filter((o) => o.expected_date === today).length;
    const attention: AttentionItem[] = [
      { key: 'late', label: 'הזמנות באיחור באספקה', count: late, tone: 'alert', to: '/receiving', clearLabel: 'אין הזמנות באיחור' },
      { key: 'today', label: 'לקבלה היום', count: dueToday, tone: 'await', to: '/receiving', clearLabel: 'אין קבלות מתוכננות להיום' },
      { key: 'open', label: 'הזמנות פתוחות לקבלת סחורה', count: openPos.length, tone: 'idle', to: '/receiving', clearLabel: 'אין הזמנות פתוחות' },
    ];

    // ── charts
    const monthly = monthlyBuckets(orders.map((o) => ({ date: o.created_at, value: orderValue(o.items) })), { monthKey, months: 4 })
      .map((b) => ({ key: fmtMonth(`${b.key}-01`), label: b.count ? money(b.total) : '', total: b.total }));

    const byCat = new Map<string, number>();
    for (const it of poItems) {
      const cat = it.product?.category?.name ?? 'ללא קטגוריה';
      byCat.set(cat, (byCat.get(cat) ?? 0) + it.qty * it.unit_price);
    }
    const categories = topCategoriesWithOther([...byCat.entries()].map(([name, total]) => ({ name, total })));
    const categoryTotal = categories.reduce((s, c) => s + c.total, 0);

    const receiptValue = (r: Receipt) => r.items.reduce((s, i) => s + i.qty_received * (i.order_item?.unit_price ?? 0), 0);
    const orderedW = weeklyBuckets(orders.map((o) => ({ date: o.created_at, value: orderValue(o.items) })), { todayISO: today });
    const receivedW = weeklyBuckets(receipts.map((r) => ({ date: r.received_at, value: receiptValue(r) })), { todayISO: today });
    const weekly: LinePoint[] = orderedW.map((p, i) => ({
      week: p.week,
      ordered: p.count > 0 ? p.total : null,
      received: (receivedW[i]?.count ?? 0) > 0 ? receivedW[i].total : null,
    }));

    return { kpis, attention, monthly, categories, categoryTotal, weekly };
  });

  if (loading) return <SkeletonCards count={6} cols={6} title />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  const t = chartTheme();

  return (
    <DashboardFrame title="מרכז הבקרה — מטבח" actions={<>
      <Link to="/orders/new" className="btn-primary"><ShoppingCart size={16} /> הזמנה חדשה</Link>
      <Link to="/receiving" className="btn-secondary"><PackageCheck size={16} /> קבלת סחורה</Link>
    </>}>
      <Scorecard items={data.kpis} />
      <AttentionZone items={data.attention} />
      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="רכש לפי חודש" subtitle="שווי ההזמנות שנפתחו בארבעת החודשים האחרונים">
          <SpendBarChart points={data.monthly}
            ariaLabel={`רכש לפי חודש: ${data.monthly.map((p) => `${p.key} ${p.label || 'אין רכש'}`).join(', ')}`}
            emptyMessage="אין נתוני רכש לתקופה" />
        </ChartCard>
        <ChartCard title="תמהיל רכש החודש" subtitle="ארבע הקטגוריות הגדולות וכל היתר">
          <CategoryDonut slices={data.categories} total={data.categoryTotal}
            ariaLabel={`תמהיל רכש לפי קטגוריה, סה״כ ${fmtMoney(data.categoryTotal)}`}
            emptyMessage="אין רכש החודש" />
        </ChartCard>
        <ChartCard title="רכש מול קבלות" subtitle="שמונה השבועות האחרונים" className="lg:col-span-2">
          <ComparisonLineChart points={data.weekly} xKey="week" legend
            series={[{ key: 'ordered', name: 'הוזמן', color: t.bars[0] }, { key: 'received', name: 'התקבל', color: t.bars[2], dashed: true }]}
            ariaLabel="השוואת שווי הזמנות שנפתחו מול סחורה שהתקבלה, שמונה שבועות"
            emptyMessage="אין רכש או קבלות בשמונת השבועות האחרונים" />
        </ChartCard>
      </div>
    </DashboardFrame>
  );
}

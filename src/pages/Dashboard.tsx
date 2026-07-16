import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList } from 'recharts';
import { TrendingUp, ChevronLeft } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { PageLoader, KpiCard, StatusBadge, ErrorNote } from '../components/ui';
import { EXCEPTION_TYPE, SEVERITY } from '../lib/status';
import { fmtMoney, fmtMoneyExact, fmtMonth } from '../lib/format';

// single-hue magnitude palette (dataviz rule: identity sits on the axis, color encodes nothing else)
const BAR_COLOR = '#4f46e5';
const money = (v: number) => `₪${Math.round(v).toLocaleString('he-IL')}`;

export default function Dashboard() {
  const navigate = useNavigate();

  const { data, loading, error } = useQuery(async () => {
    const now = new Date();
    const monthStart = `${now.toISOString().slice(0, 7)}-01`;
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay());
    const weekStartISO = weekStart.toISOString().slice(0, 10);
    const todayISO = now.toISOString().slice(0, 10);
    const chartsFrom = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString().slice(0, 10);

    const [ordersRes, invoicesRes, paymentsRes, balancesRes, prRes, exceptionsRes, creditsRes, bankRes, supBalRes, suppliersRes, poItemsRes, priceUpRes, reqItemsRes, spRes] = await Promise.all([
      supabase.from('purchase_orders').select('id, created_at, status, items:purchase_order_items(qty, unit_price)').gte('created_at', monthStart).not('status', 'in', '(draft,cancelled)'),
      supabase.from('invoices').select('id, supplier_id, invoice_date, total_amount, review_status, payment_status, export_status').is('deleted_at', null).gte('invoice_date', chartsFrom),
      supabase.from('payments').select('amount, paid_date').gte('paid_date', monthStart),
      supabase.from('invoice_balances').select('balance'),
      supabase.from('payment_requests').select('id, status'),
      supabase.from('exceptions').select('*, supplier:suppliers(name)').in('status', ['open', 'in_progress']).order('created_at', { ascending: false }),
      supabase.from('credit_requests').select('amount, status').in('status', ['open', 'requested', 'received']),
      supabase.from('bank_transactions').select('id, status'),
      supabase.from('supplier_balances').select('*').gt('open_balance', 0),
      supabase.from('suppliers').select('id, name'),
      supabase.from('purchase_order_items').select('qty, unit_price, product:products(category:categories(name)), order:purchase_orders!inner(created_at, status)').gte('order.created_at', chartsFrom),
      supabase.from('supplier_products').select('current_price, previous_price, price_effective_date, product:products(name), supplier:suppliers(name)').order('price_effective_date', { ascending: false }),
      supabase.from('purchase_request_items').select('qty, unit_price, product_id, request:purchase_requests!inner(created_at, status)').gte('request.created_at', monthStart).eq('request.status', 'split'),
      supabase.from('supplier_products').select('product_id, current_price').eq('available', true),
    ]);

    const orders = unwrap(ordersRes) as { created_at: string; items: { qty: number; unit_price: number }[] }[];
    const invoices = unwrap(invoicesRes) as { supplier_id: string; invoice_date: string; total_amount: number; review_status: string; payment_status: string; export_status: string }[];
    const payments = unwrap(paymentsRes) as { amount: number }[];
    const balances = unwrap(balancesRes) as { balance: number }[];
    const prs = unwrap(prRes) as { status: string }[];
    const exceptions = unwrap(exceptionsRes) as ({ id: string; type: string; severity: 'low' | 'medium' | 'high'; title: string; created_at: string; supplier: { name: string } | null })[];
    const credits = unwrap(creditsRes) as { amount: number }[];
    const bank = unwrap(bankRes) as { status: string }[];
    const supBal = unwrap(supBalRes) as { supplier_id: string; open_balance: number }[];
    const suppliers = new Map((unwrap(suppliersRes) as { id: string; name: string }[]).map((s) => [s.id, s.name]));
    const poItems = unwrap(poItemsRes) as { qty: number; unit_price: number; product: { category: { name: string } | null } | null; order: { created_at: string } }[];
    const priceRows = unwrap(priceUpRes) as { current_price: number; previous_price: number | null; price_effective_date: string; product: { name: string }; supplier: { name: string } }[];
    const reqItems = unwrap(reqItemsRes) as { qty: number; unit_price: number | null; product_id: string }[];
    const offers = unwrap(spRes) as { product_id: string; current_price: number }[];

    const orderValue = (o: { items: { qty: number; unit_price: number }[] }) => o.items.reduce((s, i) => s + i.qty * i.unit_price, 0);
    const purchasedToday = orders.filter((o) => o.created_at.slice(0, 10) === todayISO).reduce((s, o) => s + orderValue(o), 0);
    const purchasedWeek = orders.filter((o) => o.created_at.slice(0, 10) >= weekStartISO).reduce((s, o) => s + orderValue(o), 0);
    const purchasedMonth = orders.reduce((s, o) => s + orderValue(o), 0);
    const paidMonth = payments.reduce((s, p) => s + p.amount, 0);
    const openBalance = balances.reduce((s, b) => s + Math.max(0, b.balance), 0);
    const awaitingApproval = prs.filter((p) => p.status === 'pending_approval').length;
    const suspectedDup = exceptions.filter((e) => ['duplicate_invoice', 'duplicate_payment'].includes(e.type)).length;
    const unmatchedBank = bank.filter((b) => b.status === 'unmatched').length;
    const unmatchedInvoices = invoices.filter((i) => i.payment_status !== 'paid' && i.review_status === 'approved').length;
    const openCreditsSum = credits.reduce((s, c) => s + c.amount, 0);
    const notSentToAccountant = invoices.filter((i) => i.export_status === 'not_sent' && i.review_status === 'approved').length;

    // estimated savings this month: chosen price vs the most expensive available offer
    const maxOffer = new Map<string, number>();
    for (const o of offers) maxOffer.set(o.product_id, Math.max(maxOffer.get(o.product_id) ?? 0, o.current_price));
    const savings = reqItems.reduce((s, it) => {
      if (it.unit_price == null) return s;
      const max = maxOffer.get(it.product_id) ?? it.unit_price;
      return s + Math.max(0, (max - it.unit_price) * it.qty);
    }, 0);

    // monthly expense chart (invoices by month, last 4)
    const byMonth = new Map<string, number>();
    for (const inv of invoices) {
      const m = inv.invoice_date.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) ?? 0) + inv.total_amount);
    }
    const monthly = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([m, total]) => ({ month: fmtMonth(`${m}-01`), total: Math.round(total) }));
    const monthKeys = [...byMonth.keys()].sort();
    const curMonthTotal = byMonth.get(monthKeys[monthKeys.length - 1]) ?? 0;
    const prevMonthTotal = byMonth.get(monthKeys[monthKeys.length - 2]) ?? 0;
    const momChange = prevMonthTotal ? ((curMonthTotal - prevMonthTotal) / prevMonthTotal) * 100 : null;

    // by category (PO items, current month)
    const byCat = new Map<string, number>();
    for (const it of poItems) {
      if (it.order.created_at < monthStart) continue;
      const cat = it.product?.category?.name ?? 'ללא קטגוריה';
      byCat.set(cat, (byCat.get(cat) ?? 0) + it.qty * it.unit_price);
    }
    const categories = [...byCat.entries()].map(([name, total]) => ({ name, total: Math.round(total) })).sort((a, b) => b.total - a.total);

    // by supplier (invoices, current month)
    const bySup = new Map<string, number>();
    for (const inv of invoices) {
      if (inv.invoice_date < monthStart) continue;
      const name = suppliers.get(inv.supplier_id) ?? '—';
      bySup.set(name, (bySup.get(name) ?? 0) + inv.total_amount);
    }
    const topSuppliers = [...bySup.entries()].map(([name, total]) => ({ name, total: Math.round(total) })).sort((a, b) => b.total - a.total).slice(0, 7);

    const priceIncreases = priceRows
      .filter((r) => r.previous_price != null && r.current_price > r.previous_price)
      .map((r) => ({ ...r, pct: ((r.current_price - r.previous_price!) / r.previous_price!) * 100 }))
      .sort((a, b) => b.pct - a.pct).slice(0, 6);

    const topBalances = supBal.sort((a, b) => b.open_balance - a.open_balance).slice(0, 6)
      .map((b) => ({ name: suppliers.get(b.supplier_id) ?? '—', balance: b.open_balance }));

    return {
      kpis: { purchasedToday, purchasedWeek, purchasedMonth, paidMonth, openBalance, awaitingApproval, suspectedDup, unmatchedBank, unmatchedInvoices, openCreditsSum, savings, notSentToAccountant },
      monthly, momChange, categories, topSuppliers, priceIncreases, topBalances,
      exceptions: exceptions.slice(0, 6),
      queueCounts: {
        receiving: (unwrap(await supabase.from('purchase_orders').select('id').in('status', ['sent', 'confirmed', 'partial'])) as unknown[]).length,
        invoicesToReview: invoices.filter((i) => ['received', 'in_review'].includes(i.review_status)).length,
        prDrafts: prs.filter((p) => ['draft'].includes(p.status)).length,
        highExceptions: exceptions.filter((e) => e.severity === 'high').length,
      },
    };
  });

  if (loading) return <PageLoader />;
  if (error || !data) return <ErrorNote message={error ?? 'שגיאה'} />;
  const k = data.kpis;

  return (
    <div className="space-y-5">
      <h1 className="page-title">דשבורד ניהולי</h1>

      {/* KPI row 1 — purchasing & money movement */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <KpiCard title="נרכש היום" value={fmtMoney(k.purchasedToday)} onClick={() => navigate('/orders')} />
        <KpiCard title="נרכש השבוע" value={fmtMoney(k.purchasedWeek)} onClick={() => navigate('/orders')} />
        <KpiCard title="נרכש החודש" value={fmtMoney(k.purchasedMonth)} onClick={() => navigate('/orders')} />
        <KpiCard title="שולם לספקים החודש" value={fmtMoney(k.paidMonth)} tone="green" onClick={() => navigate('/payments')} />
        <KpiCard title="יתרת חשבוניות פתוחות" value={fmtMoney(k.openBalance)} tone="amber" onClick={() => navigate('/invoices?pay=unpaid')} />
      </div>

      {/* KPI row 2 — control & risk */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <KpiCard title="דרישות ממתינות לאישור" value={String(k.awaitingApproval)} tone={k.awaitingApproval ? 'amber' : 'slate'} onClick={() => navigate('/payment-requests')} />
        <KpiCard title="חשדות לכפילות" value={String(k.suspectedDup)} tone={k.suspectedDup ? 'red' : 'slate'} onClick={() => navigate('/exceptions')} />
        <KpiCard title="תנועות בנק לא מותאמות" value={String(k.unmatchedBank)} tone={k.unmatchedBank ? 'amber' : 'slate'} onClick={() => navigate('/bank?status=unmatched')} />
        <KpiCard title="זיכויים פתוחים" value={fmtMoney(k.openCreditsSum)} tone="blue" onClick={() => navigate('/credits')} />
        <KpiCard title="חיסכון משוער מהשוואת מחירים" value={fmtMoney(k.savings)} tone="green" sub="החודש, מול ההצעה היקרה ביותר" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card card-pad">
          <div className="flex items-center justify-between mb-1">
            <h2 className="section-title">הוצאות רכש לפי חודש</h2>
            {data.momChange != null && (
              <span className={`text-xs font-medium ${data.momChange > 0 ? 'text-rose-600' : 'text-emerald-600'}`} dir="ltr">
                {data.momChange > 0 ? '+' : ''}{data.momChange.toFixed(0)}% מול חודש קודם
              </span>
            )}
          </div>
          <div dir="ltr" className="h-56">
            <ResponsiveContainer>
              <BarChart data={data.monthly} margin={{ top: 20, left: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip formatter={(v) => money(Number(v))} labelStyle={{ fontFamily: 'Heebo' }} />
                <Bar dataKey="total" name="סה״כ" fill={BAR_COLOR} radius={[4, 4, 0, 0]} maxBarSize={56}>
                  <LabelList dataKey="total" position="top" formatter={(v: number) => money(v)} style={{ fontSize: 11, fill: '#475569' }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card card-pad">
          <h2 className="section-title mb-1">הוצאות לפי קטגוריה (החודש)</h2>
          <div dir="ltr" className="h-56">
            <ResponsiveContainer>
              <BarChart data={data.categories} layout="vertical" margin={{ left: 8, right: 56 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" orientation="right" width={78} tick={{ fontSize: 12, fill: '#334155' }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v) => money(Number(v))} />
                <Bar dataKey="total" name="סה״כ" fill={BAR_COLOR} radius={[4, 0, 0, 4]} maxBarSize={22}>
                  <LabelList dataKey="total" position="left" formatter={(v: number) => money(v)} style={{ fontSize: 11, fill: '#475569' }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card card-pad">
          <h2 className="section-title mb-1">הוצאות לפי ספק (החודש)</h2>
          <div dir="ltr" className="h-64">
            <ResponsiveContainer>
              <BarChart data={data.topSuppliers} layout="vertical" margin={{ left: 8, right: 56 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" orientation="right" width={130} tick={{ fontSize: 11, fill: '#334155' }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v) => money(Number(v))} />
                <Bar dataKey="total" name="סה״כ" fill={BAR_COLOR} radius={[4, 0, 0, 4]} maxBarSize={20}>
                  <LabelList dataKey="total" position="left" formatter={(v: number) => money(v)} style={{ fontSize: 11, fill: '#475569' }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card card-pad">
          <h2 className="section-title mb-2 flex items-center gap-1.5"><TrendingUp size={16} className="text-rose-500" /> מוצרים שהתייקרו לאחרונה</h2>
          {data.priceIncreases.length ? (
            <ul className="divide-y divide-slate-100">
              {data.priceIncreases.map((p, i) => (
                <li key={i} className="flex items-center justify-between py-2 text-sm cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded" onClick={() => navigate('/prices')}>
                  <span>
                    <span className="font-medium text-slate-800">{p.product.name}</span>
                    <span className="text-slate-400 text-xs ms-2">{p.supplier.name}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-slate-400 num">₪{p.previous_price!.toFixed(2)} ← ₪{p.current_price.toFixed(2)}</span>
                    <span className="badge-red" dir="ltr">+{p.pct.toFixed(1)}%</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : <div className="text-sm text-slate-400 py-6 text-center">אין התייקרויות אחרונות</div>}
        </div>
      </div>

      {/* Operational sections */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card card-pad">
          <div className="flex items-center justify-between mb-2">
            <h2 className="section-title">חריגים פתוחים</h2>
            <button className="btn-ghost py-1! text-xs" onClick={() => navigate('/exceptions')}>לכל החריגים <ChevronLeft size={13} /></button>
          </div>
          {data.exceptions.length ? (
            <ul className="divide-y divide-slate-100">
              {data.exceptions.map((e) => (
                <li key={e.id} className="py-2 text-sm cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded" onClick={() => navigate('/exceptions')}>
                  <div className="flex items-center gap-2">
                    <StatusBadge meta={SEVERITY[e.severity]} />
                    <span className="text-xs text-slate-400">{EXCEPTION_TYPE[e.type]}</span>
                  </div>
                  <div className="text-slate-700 truncate mt-0.5">{e.title}</div>
                </li>
              ))}
            </ul>
          ) : <div className="text-sm text-emerald-600 py-6 text-center">אין חריגים פתוחים 🎉</div>}
        </div>

        <div className="card card-pad">
          <div className="flex items-center justify-between mb-2">
            <h2 className="section-title">ספקים עם יתרה פתוחה</h2>
            <button className="btn-ghost py-1! text-xs" onClick={() => navigate('/suppliers')}>לכל הספקים <ChevronLeft size={13} /></button>
          </div>
          {data.topBalances.length ? (
            <ul className="divide-y divide-slate-100">
              {data.topBalances.map((b, i) => (
                <li key={i} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-slate-700">{b.name}</span>
                  <span className="font-semibold num text-amber-700">{fmtMoneyExact(b.balance)}</span>
                </li>
              ))}
            </ul>
          ) : <div className="text-sm text-slate-400 py-6 text-center">אין יתרות פתוחות</div>}
        </div>

        <div className="card card-pad">
          <h2 className="section-title mb-2">משימות לפי תפקיד</h2>
          <ul className="space-y-2 text-sm">
            <TaskLine label="הזמנות ממתינות לקבלת סחורה (ניר)" count={data.queueCounts.receiving} onClick={() => navigate('/receiving')} />
            <TaskLine label="חשבוניות לבדיקה (מזכירות)" count={data.queueCounts.invoicesToReview} onClick={() => navigate('/invoices?review=received')} />
            <TaskLine label="טיוטות דרישת תשלום (מזכירות)" count={data.queueCounts.prDrafts} onClick={() => navigate('/payment-requests')} />
            <TaskLine label="דרישות לאישור הנהלה" count={k.awaitingApproval} onClick={() => navigate('/payment-requests')} />
            <TaskLine label="חריגים בחומרה גבוהה (הנהלה)" count={data.queueCounts.highExceptions} onClick={() => navigate('/exceptions')} />
            <TaskLine label="חשבוניות שטרם הועברו לרו״ח" count={k.notSentToAccountant} onClick={() => navigate('/reports')} />
          </ul>
        </div>
      </div>
    </div>
  );
}

function TaskLine({ label, count, onClick }: { label: string; count: number; onClick: () => void }) {
  return (
    <li className="flex items-center justify-between cursor-pointer hover:bg-slate-50 -mx-2 px-2 py-1.5 rounded" onClick={onClick}>
      <span className="text-slate-600">{label}</span>
      <span className={`badge ${count > 0 ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-500'}`}>{count}</span>
    </li>
  );
}

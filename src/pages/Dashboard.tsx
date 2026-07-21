import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList } from 'recharts';
import { TrendingUp, ChevronLeft, RotateCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { PageLoader, StatusBadge, Note, AttentionZone, StatTile, TaskLine, type AttentionItem } from '../components/ui';
import { EXCEPTION_TYPE, SEVERITY } from '../lib/status';
import { fmtMoney, fmtMoneyExact, fmtMonth, toLocalISO } from '../lib/format';

// single-hue magnitude palette (dataviz rule: identity sits on the axis, color encodes nothing else)
const BAR_COLOR = '#4f46e5';
const money = (v: number) => `₪${Math.round(v).toLocaleString('he-IL')}`;
// compact ₪ for dense axes (the 8-bar weekly series): full labels overlap at that count.
const moneyShort = (v: number) => (Math.abs(v) >= 1000 ? `₪${(v / 1000).toLocaleString('he-IL', { maximumFractionDigits: 1 })}k` : `₪${Math.round(v)}`);
// "עודכן ב-HH:MM" freshness stamp — the screen promises real-time, so it says when it last read.
const timeFmt = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' });

// Week bucketing for the weekly-purchasing chart. Local-day helper is shared (toLocalISO).
const pad = (n: number) => String(n).padStart(2, '0');
const startOfWeek = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; };

export default function Dashboard() {
  const { data, loading, error, refetch, fetching } = useQuery(async () => {
    const now = new Date();
    const todayISO = toLocalISO(now);
    const monthStart = `${todayISO.slice(0, 7)}-01`;
    const monthKey = todayISO.slice(0, 7); // YYYY-MM, for /payments?month=
    const eightWeeksAgo = new Date(startOfWeek(now)); eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 7 * 7);
    const eightWeeksISO = toLocalISO(eightWeeksAgo);
    const last30d = new Date(now); last30d.setDate(now.getDate() - 30);
    const last30dISO = toLocalISO(last30d);
    const chartsFrom = toLocalISO(new Date(now.getFullYear(), now.getMonth() - 3, 1));

    const [
      ordersRes, invoicesRes, paymentsRes, balancesRes, prRes, exceptionsRes, creditsRes,
      bankRes, supBalRes, suppliersRes, poItemsRes, priceUpRes, reqItemsRes, offersRes, openPoRes,
    ] = await Promise.all([
      // recent orders (8 weeks) — purchased today/week/month + the weekly series. created_at is the
      // time axis, non-draft/cancelled the filter, at snapshot prices (OPEN-DECISIONS #4, locked).
      supabase.from('purchase_orders').select('id, created_at, status, items:purchase_order_items(qty, unit_price)').gte('created_at', eightWeeksISO).not('status', 'in', '(draft,cancelled)'),
      supabase.from('invoices').select('id, supplier_id, invoice_date, received_date, total_amount, review_status, payment_status, export_status').is('deleted_at', null).gte('invoice_date', chartsFrom),
      supabase.from('payments').select('amount, paid_date').gte('paid_date', monthStart),
      supabase.from('invoice_balances').select('balance'),
      supabase.from('payment_requests').select('id, status, due_date, amount'),
      supabase.from('exceptions').select('*, supplier:suppliers(name)').in('status', ['open', 'in_progress']).order('created_at', { ascending: false }),
      supabase.from('credit_requests').select('amount, status').in('status', ['open', 'requested', 'received']),
      supabase.from('bank_transactions').select('id, status'),
      supabase.from('supplier_balances').select('*').gt('open_balance', 0),
      supabase.from('suppliers').select('id, name'),
      supabase.from('purchase_order_items').select('qty, unit_price, product:products(category:categories(name)), order:purchase_orders!inner(created_at, status)').gte('order.created_at', chartsFrom),
      // price increases — now bounded to the last 30 days (was a full unbounded scan): matches the
      // "מוצרים שהתייקרו לאחרונה" label and the alerts window (OPEN-DECISIONS #26).
      supabase.from('supplier_products').select('current_price, previous_price, price_effective_date, product:products(id, name), supplier:suppliers(name)').gte('price_effective_date', last30dISO).not('previous_price', 'is', null).order('price_effective_date', { ascending: false }),
      supabase.from('purchase_request_items').select('qty, unit_price, product_id, request:purchase_requests!inner(created_at, status)').gte('request.created_at', monthStart).eq('request.status', 'split'),
      // available offers for the savings estimate — kept minimal (2 cols) but cannot be date-bounded:
      // savings needs the max CURRENT available offer per product regardless of when it was set.
      supabase.from('supplier_products').select('product_id, current_price').eq('available', true),
      // open commitments — any date, so a PO sent months ago that is still open still counts. Also
      // serves the "awaiting goods receipt" queue, replacing the old serial round-trip.
      supabase.from('purchase_orders').select('id, status, items:purchase_order_items(qty, unit_price, received_qty)').in('status', ['sent', 'confirmed', 'partial']),
    ]);

    const orders = unwrap(ordersRes) as { created_at: string; items: { qty: number; unit_price: number }[] }[];
    const invoices = unwrap(invoicesRes) as { supplier_id: string; invoice_date: string; received_date: string; total_amount: number; review_status: string; payment_status: string; export_status: string }[];
    const payments = unwrap(paymentsRes) as { amount: number }[];
    const balances = unwrap(balancesRes) as { balance: number }[];
    const prs = unwrap(prRes) as { status: string; due_date: string | null; amount: number }[];
    const exceptions = unwrap(exceptionsRes) as ({ id: string; type: string; severity: 'low' | 'medium' | 'high'; title: string; created_at: string; supplier: { name: string } | null })[];
    const credits = unwrap(creditsRes) as { amount: number }[];
    const bank = unwrap(bankRes) as { status: string }[];
    const supBal = unwrap(supBalRes) as { supplier_id: string; open_balance: number }[];
    const suppliers = new Map((unwrap(suppliersRes) as { id: string; name: string }[]).map((s) => [s.id, s.name]));
    const poItems = unwrap(poItemsRes) as { qty: number; unit_price: number; product: { category: { name: string } | null } | null; order: { created_at: string } }[];
    const priceRows = unwrap(priceUpRes) as { current_price: number; previous_price: number | null; price_effective_date: string; product: { id: string; name: string }; supplier: { name: string } }[];
    const reqItems = unwrap(reqItemsRes) as { qty: number; unit_price: number | null; product_id: string }[];
    const offers = unwrap(offersRes) as { product_id: string; current_price: number }[];
    const openPos = unwrap(openPoRes) as { items: { qty: number; unit_price: number; received_qty: number }[] }[];

    const orderValue = (o: { items: { qty: number; unit_price: number }[] }) => o.items.reduce((s, i) => s + i.qty * i.unit_price, 0);

    // ── money strip (context). Every value is `number | null`: null when its source set is
    // empty, so an empty org shows "—", never a fake "0" (CLAUDE.md:31,37). A measured 0 (there
    // ARE rows this period, they just sum to 0) is legitimate and kept as a number.
    const hasOrders = orders.length > 0;
    const purchasedMonth = hasOrders ? orders.filter((o) => o.created_at.slice(0, 10) >= monthStart).reduce((s, o) => s + orderValue(o), 0) : null;
    const paidMonth = payments.length ? payments.reduce((s, p) => s + p.amount, 0) : null;
    const openBalance = balances.length ? balances.reduce((s, b) => s + Math.max(0, b.balance), 0) : null;

    // ── attention counts. A count of 0 is a real "all clear" (rendered in tier B as "✓ אין…").
    // `null` is reserved for what genuinely cannot be measured.
    const invoicesPendingApproval = invoices.filter((i) => i.review_status === 'pending_approval').length;
    const prPendingApproval = prs.filter((p) => p.status === 'pending_approval').length;

    // Payments due/overdue can ONLY come from payment_requests that carry a MANUAL due_date —
    // invoices have no due_date and suppliers.payment_terms is free text nobody parses. If not one
    // active request has a due date, we cannot claim anything about what is due/overdue → null (—),
    // never 0 (which would falsely assert "nothing is overdue"). See OPEN-DECISIONS #27.
    const activeDueDated = prs.filter((p) => p.due_date && !['executed', 'matched', 'cancelled'].includes(p.status));
    const canMeasureDue = activeDueDated.length > 0;
    const paymentsOverdue = canMeasureDue ? activeDueDated.filter((p) => p.due_date! < todayISO).length : null;
    const paymentsDueToday = canMeasureDue ? activeDueDated.filter((p) => p.due_date! === todayISO).length : null;

    const highExceptions = exceptions.filter((e) => e.severity === 'high').length;
    const suspectedDup = exceptions.filter((e) => ['duplicate_invoice', 'duplicate_payment'].includes(e.type)).length;
    // aligned with Reports.tsx:95 (unmatched || suggested) — both screens now agree (OPEN-DECISIONS #4 / plan).
    const unmatchedBank = bank.filter((b) => ['unmatched', 'suggested'].includes(b.status)).length;

    const openCreditsSum = credits.length ? credits.reduce((s, c) => s + c.amount, 0) : null;

    const committedSum = openPos.length ? openPos.reduce((s, o) => s + o.items.reduce((t, i) => t + i.qty * i.unit_price, 0), 0) : null;
    const remainingSum = openPos.reduce((s, o) => s + o.items.reduce((t, i) => t + Math.max(0, (i.qty - i.received_qty) * i.unit_price), 0), 0);

    // ── estimated savings this month: chosen price vs the most expensive available offer.
    const maxOffer = new Map<string, number>();
    for (const o of offers) maxOffer.set(o.product_id, Math.max(maxOffer.get(o.product_id) ?? 0, o.current_price));
    const savings = reqItems.length ? reqItems.reduce((s, it) => {
      if (it.unit_price == null) return s;
      const max = maxOffer.get(it.product_id) ?? it.unit_price;
      return s + Math.max(0, (max - it.unit_price) * it.qty);
    }, 0) : null;

    // ── price increases (from the 30-day set). The attention metric is SUPPLIERS, not products.
    const priceIncreases = priceRows
      .filter((r) => r.previous_price != null && r.current_price > r.previous_price)
      .map((r) => ({ ...r, pct: ((r.current_price - r.previous_price!) / r.previous_price!) * 100 }))
      .sort((a, b) => b.pct - a.pct);
    const priceIncreaseSuppliers = new Set(priceIncreases.map((r) => r.supplier.name)).size;

    // ── monthly expense chart (invoices by month) + MoM change. The one place the old code got
    // the null-contract right (momChange), kept as the template.
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

    // ── weekly purchasing series (Nir §8, new): 8 local-week buckets of order value.
    const weekBuckets = Array.from({ length: 8 }, (_, idx) => {
      const ws = new Date(startOfWeek(now)); ws.setDate(ws.getDate() - (7 - idx) * 7);
      return { key: toLocalISO(ws), week: `${pad(ws.getDate())}/${pad(ws.getMonth() + 1)}`, total: 0 };
    });
    const weekByKey = new Map(weekBuckets.map((b) => [b.key, b]));
    for (const o of orders) {
      const b = weekByKey.get(toLocalISO(startOfWeek(new Date(o.created_at))));
      if (b) b.total += Math.round(orderValue(o));
    }
    const weekly = weekBuckets.map(({ week, total }) => ({ week, total }));

    // ── by category (PO items, current month) — kept but demoted.
    const byCat = new Map<string, number>();
    for (const it of poItems) {
      if (it.order.created_at < monthStart) continue;
      const cat = it.product?.category?.name ?? 'ללא קטגוריה';
      byCat.set(cat, (byCat.get(cat) ?? 0) + it.qty * it.unit_price);
    }
    const categories = [...byCat.entries()].map(([name, total]) => ({ name, total: Math.round(total) })).sort((a, b) => b.total - a.total);

    // supplier open balances — id is KEPT so each row can link to /suppliers/:id (was dropped).
    const topBalances = supBal.sort((a, b) => b.open_balance - a.open_balance).slice(0, 6)
      .map((b) => ({ id: b.supplier_id, name: suppliers.get(b.supplier_id) ?? '—', balance: b.open_balance }));

    // ── "דורש טיפול היום", ordered by business importance (Nir §3).
    // Tones use section 6's semantic vocabulary: await=ממתין · alert=דחוף · info=מידע · idle=ניטרלי.
    const attention: AttentionItem[] = [
      { key: 'inv-approval', label: 'חשבוניות הממתינות לאישור', count: invoicesPendingApproval, tone: 'await', to: '/invoices?review=pending_approval', clearLabel: 'אין חשבוניות לאישור' },
      { key: 'pr-approval', label: 'דרישות תשלום הממתינות לאישור', count: prPendingApproval, tone: 'await', to: '/payment-requests?status=pending_approval', clearLabel: 'אין דרישות לאישור' },
      { key: 'pay-overdue', label: 'דרישות תשלום באיחור', count: paymentsOverdue, tone: 'alert', to: '/payment-requests?due=overdue', clearLabel: 'אין תשלומים באיחור' },
      { key: 'pay-today', label: 'תשלומים לביצוע היום', count: paymentsDueToday, tone: 'await', to: '/payment-requests?due=today', clearLabel: 'אין תשלומים להיום' },
      { key: 'exceptions', label: 'חריגים פתוחים', count: exceptions.length, tone: 'alert', to: '/exceptions?status=open', hint: highExceptions ? `${highExceptions} בחומרה גבוהה` : undefined, clearLabel: 'אין חריגים פתוחים' },
      { key: 'credits', label: 'זיכויים פתוחים', count: credits.length, amount: openCreditsSum, tone: 'info', to: '/credits?status=active', clearLabel: 'אין זיכויים פתוחים' },
      { key: 'commitments', label: 'התחייבויות רכש פתוחות', count: openPos.length, amount: committedSum, tone: 'idle', to: '/orders?status=open', hint: remainingSum > 0 ? `נותר לקבלה ${fmtMoney(remainingSum)}` : undefined, clearLabel: 'אין התחייבויות פתוחות' },
      { key: 'price-increases', label: 'ספקים שהעלו מחירים (30 יום)', count: priceIncreaseSuppliers, tone: 'await', to: '/prices?increases=1', clearLabel: 'אין שינויי מחירים' },
    ];

    return {
      fetchedAt: new Date(),   // query-completion time → drives the "עודכן ב-" stamp
      attention,
      money: { openBalance, paidMonth, purchasedMonth, monthKey },
      monthly, weekly, momChange, categories, savings,
      priceIncreases: priceIncreases.slice(0, 6),
      topBalances,
      exceptions: exceptions.slice(0, 6),
      meta: { suspectedDup, unmatchedBank },
      queue: {
        receiving: openPos.length,
        invoicesToReview: invoices.filter((i) => ['received', 'in_review'].includes(i.review_status)).length,
        prDrafts: prs.filter((p) => p.status === 'draft').length,
        prPendingApproval,
        highExceptions,
        notSentToAccountant: invoices.filter((i) => i.export_status === 'not_sent' && i.review_status === 'approved').length,
      },
    };
  });

  if (loading) return <PageLoader />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">דשבורד ניהולי</h1>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          {data?.fetchedAt && <span>עודכן ב-<span className="num">{timeFmt.format(data.fetchedAt)}</span></span>}
          <button className="btn-ghost py-1! px-2!" onClick={() => void refetch()} disabled={fetching}
            aria-label="רענון נתוני הדשבורד" title="רענון">
            <RotateCw size={15} className={fetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Truth-reporting (CLAUDE.md): a failed load/refetch shows an inline note WITH retry and keeps
          whatever data we still hold on screen — it never blanks the sections that did load. */}
      {error && (
        <Note tone="alert" className="flex items-center justify-between gap-3">
          <span>{error}</span>
          <button className="btn-ghost py-1! shrink-0 whitespace-nowrap" onClick={() => void refetch()}>נסה שוב</button>
        </Note>
      )}

      {data && (<>
      {/* Nir §1–3 — the control center. totalLabel scopes the summed ₪ as workload, not net debt. */}
      <AttentionZone items={data.attention} totalLabel="סה״כ בטיפול" />

      {/* thin money strip — context, all navigable. `sub` carries a short plain-Hebrew gloss of
          each term (StatTile has no title-tooltip prop; `sub` is the visible, readable equivalent). */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile title="יתרת חשבוניות פתוחות" value={fmtMoney(data.money.openBalance)} tone="await" to="/invoices?pay=unpaid"
          sub="סך החוב לספקים על חשבוניות שטרם שולמו במלואן" />
        <StatTile title="שולם לספקים החודש" value={fmtMoney(data.money.paidMonth)} tone="done" to={`/payments?month=${data.money.monthKey}`}
          sub="סך התשלומים שיצאו לספקים החודש" />
        <StatTile title="נרכש החודש" value={fmtMoney(data.money.purchasedMonth)} to="/orders?status=all"
          sub={data.savings != null
            ? `חיסכון משוער החודש: ההפרש מול המחיר היקר ביותר שהוצע — ${fmtMoney(data.savings)}`
            : 'שווי ההזמנות שנוצרו החודש (במחירי ההזמנה)'} />
      </div>

      {/* operational detail — exceptions + recent price increases */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card card-pad">
          <div className="flex items-center justify-between mb-2">
            <h2 className="section-title">חריגים פתוחים</h2>
            <Link to="/exceptions?status=open" className="btn-ghost py-1! text-xs">לכל החריגים <ChevronLeft size={13} /></Link>
          </div>
          {data.exceptions.length ? (
            <ul className="divide-y divide-slate-100">
              {data.exceptions.map((e) => (
                <li key={e.id}>
                  <Link to={`/exceptions?id=${e.id}`} className="block py-2 text-sm -mx-2 px-2 rounded-lg hover:bg-slate-50">
                    <div className="flex items-center gap-2">
                      <StatusBadge meta={SEVERITY[e.severity]} />
                      <span className="text-xs text-slate-500">{EXCEPTION_TYPE[e.type]}</span>
                    </div>
                    <div className="text-slate-700 truncate mt-0.5">{e.title}</div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <div className="text-sm text-done-fg py-6 text-center">אין חריגים פתוחים כרגע</div>}
          {/* folded risk hints (Nir §1: duplicate suspicions, unmatched bank movements).
              Shown only when > 0 — a risk indicator printing "0" is the fake-zero the plan forbids;
              the count-0 "all clear" is already carried by AttentionZone tier B. */}
          {(data.meta.suspectedDup > 0 || data.meta.unmatchedBank > 0) && (
            <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {data.meta.suspectedDup > 0 && (
                <Link to="/exceptions?type=duplicate_invoice,duplicate_payment" className="text-slate-500 hover:text-slate-700">חשד לכפילות: <span className="num font-medium">{data.meta.suspectedDup}</span></Link>
              )}
              {data.meta.unmatchedBank > 0 && (
                <Link to="/bank?status=unmatched" className="text-slate-500 hover:text-slate-700">תנועות בנק לא מותאמות: <span className="num font-medium">{data.meta.unmatchedBank}</span></Link>
              )}
            </div>
          )}
        </div>

        <div className="card card-pad">
          <div className="flex items-center justify-between mb-2">
            <h2 className="section-title flex items-center gap-1.5"><TrendingUp size={16} className="text-trend-up-fg" /> מוצרים שהתייקרו לאחרונה</h2>
            <Link to="/prices?increases=1" className="btn-ghost py-1! text-xs">לכל המחירונים <ChevronLeft size={13} /></Link>
          </div>
          {data.priceIncreases.length ? (
            <ul className="divide-y divide-slate-100">
              {data.priceIncreases.map((p, i) => (
                <li key={i}>
                  <Link to={`/prices?product=${p.product.id}`} className="flex items-center justify-between py-2 text-sm -mx-2 px-2 rounded-lg hover:bg-slate-50">
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-slate-800">{p.product.name}</span>
                      <span className="text-slate-500 text-xs ms-2">{p.supplier.name}</span>
                    </span>
                    <span className="flex items-center gap-3 shrink-0">
                      {/* explicit direction (מ־… ל־…): "₪X ← ₪Y" is ambiguous in RTL */}
                      <span className="text-xs text-slate-500">מ־<span className="num">₪{p.previous_price!.toFixed(2)}</span> ל־<span className="num">₪{p.current_price.toFixed(2)}</span></span>
                      {/* fix: text in the darker alert-fg (contrast); arrow keeps the lighter trend hue */}
                      <span className="inline-flex items-center gap-1 text-alert-fg font-medium num" dir="ltr"><TrendingUp size={13} className="text-trend-up-fg" />+{p.pct.toFixed(1)}%</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <div className="text-sm text-slate-500 py-6 text-center">אין התייקרויות אחרונות</div>}
        </div>
      </div>

      {/* suppliers with open balance + tasks by role */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card card-pad">
          <div className="flex items-center justify-between mb-2">
            <h2 className="section-title">ספקים עם יתרה פתוחה</h2>
            <Link to="/suppliers?balance=open" className="btn-ghost py-1! text-xs">לכל הספקים <ChevronLeft size={13} /></Link>
          </div>
          {data.topBalances.length ? (
            <ul className="divide-y divide-slate-100">
              {data.topBalances.map((b) => (
                <li key={b.id}>
                  <Link to={`/suppliers/${b.id}`} className="flex items-center justify-between py-2 text-sm -mx-2 px-2 rounded-lg hover:bg-slate-50">
                    <span className="text-slate-700">{b.name}</span>
                    <span className="font-semibold num text-await-fg">{fmtMoneyExact(b.balance)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <div className="text-sm text-slate-500 py-6 text-center">אין יתרות פתוחות</div>}
        </div>

        <div className="card card-pad">
          <h2 className="section-title mb-2">משימות לפי תפקיד</h2>
          <ul className="space-y-1 text-sm">
            <TaskLine label="הזמנות ממתינות לקבלת סחורה (ניר)" count={data.queue.receiving} to="/orders?status=open" />
            <TaskLine label="חשבוניות לבדיקה (מזכירות)" count={data.queue.invoicesToReview} to="/invoices?review=received" />
            <TaskLine label="טיוטות דרישת תשלום (מזכירות)" count={data.queue.prDrafts} to="/payment-requests" />
            <TaskLine label="דרישות לאישור הנהלה" count={data.queue.prPendingApproval} to="/payment-requests?status=pending_approval" />
            <TaskLine label="חריגים בחומרה גבוהה (הנהלה)" count={data.queue.highExceptions} to="/exceptions?status=open&severity=high" />
            <TaskLine label="חשבוניות שטרם הועברו לרו״ח" count={data.queue.notSentToAccountant} to="/invoices?export=not_sent" />
          </ul>
        </div>
      </div>

      {/* trends — moved to the bottom */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card card-pad">
          <div className="flex items-center justify-between mb-1">
            <h2 className="section-title" title="סכום החשבוניות שהתקבלו בכל חודש">הוצאות רכש לפי חודש</h2>
            {data.momChange != null && (
              // trend text in the darker -fg pair for contrast (was rose-500/emerald-500, too light)
              <span className={`text-xs font-medium ${data.momChange > 0 ? 'text-alert-fg' : 'text-done-fg'}`} dir="ltr">
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
                <Bar dataKey="total" name="סה״כ" fill={BAR_COLOR} radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
                  <LabelList dataKey="total" position="top" formatter={(v: number) => money(v)} style={{ fontSize: 11, fill: '#475569' }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card card-pad">
          <h2 className="section-title mb-1" title="שווי ההזמנות שנוצרו בכל שבוע (במחירי ההזמנה)">רכש לפי שבוע (8 שבועות אחרונים)</h2>
          <div dir="ltr" className="h-56">
            <ResponsiveContainer>
              <BarChart data={data.weekly} margin={{ top: 20, left: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="week" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip formatter={(v) => money(Number(v))} labelStyle={{ fontFamily: 'Heebo' }} />
                {/* value labels so the week series reads at a glance like the monthly chart; compact
                    ₪ format because 8 full labels overlap (moneyShort) */}
                <Bar dataKey="total" name="סה״כ" fill={BAR_COLOR} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false}>
                  <LabelList dataKey="total" position="top" formatter={(v: number) => moneyShort(v)} style={{ fontSize: 10, fill: '#475569' }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card card-pad lg:col-span-2">
          <h2 className="section-title mb-1" title="פילוח הרכש של החודש לפי קטגוריית מוצר">הוצאות לפי קטגוריה (החודש)</h2>
          {data.categories.length ? (
            // height tracks row count so a short list does not trail off into empty space
            <div dir="ltr" style={{ height: Math.min(240, Math.max(96, data.categories.length * 34 + 16)) }}>
              <ResponsiveContainer>
                <BarChart data={data.categories} layout="vertical" margin={{ left: 8, right: 56 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" orientation="right" width={90} tick={{ fontSize: 12, fill: '#334155' }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v) => money(Number(v))} />
                  <Bar dataKey="total" name="סה״כ" fill={BAR_COLOR} radius={[4, 0, 0, 4]} maxBarSize={22} isAnimationActive={false}>
                    <LabelList dataKey="total" position="left" formatter={(v: number) => money(v)} style={{ fontSize: 11, fill: '#475569' }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <div className="text-sm text-slate-500 py-6 text-center">אין רכש החודש</div>}
        </div>
      </div>
      </>)}
    </div>
  );
}

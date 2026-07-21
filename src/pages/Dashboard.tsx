import { Link } from 'react-router-dom';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Area, AreaChart, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList } from 'recharts';
import { Banknote, ChevronLeft, ReceiptText, RotateCw, ShoppingCart, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { Skeleton, StatusBadge, Note, AttentionZone, TaskLine, type AttentionItem } from '../components/ui';
import { EXCEPTION_TYPE, SEVERITY } from '../lib/status';
import { fmtMoney, fmtMoneyExact, fmtMonth, toLocalISO } from '../lib/format';
import { chartTheme } from '../lib/theme';

const money = (v: number) => `₪${Math.round(v).toLocaleString('he-IL')}`;
// audit round 2: glance values are whole-shekel by convention — the three money-strip tiles round to
// whole ₪ so they read consistently at a glance (₪8,131 not ₪14,842.6). Tables elsewhere keep exact
// amounts; format.ts is untouched. null stays null → "—", never a fake rounded 0 (CLAUDE.md:37).
const glanceMoney = (v: number | null) => fmtMoney(v == null ? null : Math.round(v));
// compact ₪ for dense axes (the 8-bar weekly series): full labels overlap at that count.
const moneyShort = (v: number) => (Math.abs(v) >= 1000 ? `₪${(v / 1000).toLocaleString('he-IL', { maximumFractionDigits: 1 })}k` : `₪${Math.round(v)}`);
// "עודכן ב-HH:MM" freshness stamp — the screen promises real-time, so it says when it last read.
const timeFmt = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' });

type WeeklyPoint = { week: string; total: number; count: number };

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reduced;
}

function TrendSparkline({ points, label }: { points: WeeklyPoint[]; label: string }) {
  const gradientId = `dashboardSpark${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const t = chartTheme();
  const ariaLabel = `${label}: ${points.map((point) => `${point.week} ${money(point.total)}`).join(', ')}`;

  return (
    <ChartViewport className="h-8" label={ariaLabel}>
      {(animation) => (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={t.bar} stopOpacity={0.16} />
                <stop offset="100%" stopColor={t.bar} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="linear"
              dataKey="total"
              stroke={t.bar}
              strokeWidth={1.5}
              fill={`url(#${gradientId})`}
              dot={false}
              isAnimationActive={animation.active}
              animationDuration={500}
              animationEasing="ease-out"
              onAnimationEnd={animation.finish}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </ChartViewport>
  );
}

function DeltaChip({ value }: { value: number }) {
  const rounded = Math.round(value);
  const Icon = rounded > 0 ? TrendingUp : rounded < 0 ? TrendingDown : null;
  return (
    <span
      className="ms-auto inline-flex items-center gap-1 rounded-full bg-idle-soft px-2 py-0.5 text-xs font-medium text-idle-on-soft"
      title="מול אותם ימים בחודש הקודם"
    >
      {Icon && <Icon size={12} aria-hidden="true" />}
      <span className="num" dir="ltr">{rounded > 0 ? '+' : ''}{rounded}%</span>
      <span className="sr-only">מול אותם ימים בחודש הקודם</span>
    </span>
  );
}

function ChartViewport({ className, label, style, children }: {
  className: string;
  label: string;
  style?: CSSProperties;
  children: (animation: { active: boolean; finish: () => void }) => ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => reducedMotion || !('IntersectionObserver' in window));
  const [finished, setFinished] = useState(() => reducedMotion || !('IntersectionObserver' in window));

  useEffect(() => {
    if (reducedMotion || !('IntersectionObserver' in window)) {
      setVisible(true);
      setFinished(true);
      return;
    }
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { threshold: 0.18 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [reducedMotion]);

  return (
    <div ref={ref} dir="ltr" className={className} style={style} role="img" aria-label={label}>
      {visible
        ? children({ active: !finished && !reducedMotion, finish: () => setFinished(true) })
        : <span className="sr-only">{label}</span>}
    </div>
  );
}

// One segment of the money band. Segments live in a single .card and separate with logical
// borders (border-t stacked / border-s side-by-side) — never divide-x, which is physical
// left/right and breaks under RTL (see supplier-metrics.tsx).
function BandStat({ title, value, tone = 'idle', to, sub, icon: Icon, spark, sparkLabel, aux, delta }: {
  title: string;
  value: number | null;
  tone?: 'done' | 'await' | 'idle';
  to: string;
  sub: string;
  icon: LucideIcon;
  spark?: WeeklyPoint[];
  sparkLabel?: string;
  aux?: string;
  delta?: number | null;
}) {
  const toneCls = { done: 'text-done-fg', await: 'text-await-fg', idle: 'text-ink' }[tone];
  const chipCls = {
    done: 'bg-done-wash text-done-fg',
    await: 'bg-await-wash text-await-fg',
    idle: 'bg-idle-wash text-idle-fg',
  }[tone];
  const hasSpark = spark != null && spark.filter((point) => point.count > 0).length >= 2;

  return (
    <Link
      to={to}
      className="block min-h-11 border-t border-line-soft px-4 py-3.5 transition-colors first:border-t-0 hover:bg-surface-sunken active:bg-action-wash/70 sm:border-s sm:border-t-0 sm:px-5 sm:first:border-s-0"
    >
      <div className="flex items-center gap-2">
        <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${chipCls}`} aria-hidden="true">
          <Icon size={16} />
        </span>
        <span className="text-xs font-medium text-ink-muted">{title}</span>
        {delta != null && <DeltaChip value={delta} />}
      </div>
      <div className={`mt-2 text-2xl font-semibold num ${toneCls}`} dir="ltr">{glanceMoney(value)}</div>
      <div className="mt-2 h-12">
        {hasSpark && spark && sparkLabel ? (
          <>
            <div className="flex items-center justify-between text-xs text-ink-muted">
              <span>מגמה</span><span>8 שבועות</span>
            </div>
            <TrendSparkline points={spark} label={sparkLabel} />
          </>
        ) : aux ? (
          <div className="flex h-full items-center text-xs text-ink-muted">{aux}</div>
        ) : spark ? (
          <div className="flex h-full items-center text-xs text-ink-muted">אין מספיק נתונים למגמה</div>
        ) : null}
      </div>
      <div className="mt-1 text-xs text-ink-muted">{sub}</div>
    </Link>
  );
}

// Week bucketing for the weekly-purchasing chart. Local-day helper is shared (toLocalISO).
const pad = (n: number) => String(n).padStart(2, '0');
const startOfWeek = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; };
const localDateKey = (value: string) => value.includes('T') ? toLocalISO(new Date(value)) : value.slice(0, 10);
const timelineDate = (value: string) => value.includes('T') ? new Date(value) : new Date(`${value.slice(0, 10)}T00:00:00`);

// audit round 2: the loading state was <PageLoader/> — a centred spinner that collapses the page
// height and jumps when data lands, exactly what ui.tsx warns against on a known layout (and this is
// the flagship screen). This mirrors the above-the-fold shape instead: header, the "דורש טיפול" card,
// the money strip, and the first pair of detail cards. One role="status" region with a single "טוען"
// for screen readers — SkeletonRegion is not exported, so we compose the house pattern from Skeleton.
function DashboardSkeleton() {
  return (
    <div role="status" aria-busy="true" className="dashboard-depth space-y-5">
      <span className="sr-only">טוען</span>

      {/* header: page title + freshness stamp */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-24" />
      </div>

      {/* AttentionZone card: header + dense rows (badge · label · amount) */}
      <div className="card card-pad">
        <div className="flex items-center justify-between mb-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
        <div className="divide-y divide-line-soft">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 py-2.5">
              <Skeleton className="h-6 w-8 rounded-full" />
              <Skeleton className={`h-4 ${['w-56', 'w-44', 'w-64', 'w-48'][i]}`} />
              <Skeleton className="h-4 w-16 ms-auto" />
            </div>
          ))}
        </div>
      </div>

      {/* money band: one card, three segments (title · value · sub) */}
      <div className="card grid grid-cols-1 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="px-4 py-3.5 sm:px-5 border-t sm:border-t-0 sm:border-s border-line-soft first:border-t-0 sm:first:border-s-0">
            <div className="flex items-center gap-2">
              <Skeleton className="size-8 rounded-lg" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-7 w-28 mt-2" />
            <Skeleton className="h-12 w-full mt-2" />
            <Skeleton className="h-3 w-40 mt-2" />
          </div>
        ))}
      </div>

      {/* first pair of detail cards (חריגים · התייקרויות) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="card card-pad">
            <div className="flex items-center justify-between mb-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-24" />
            </div>
            <div className="divide-y divide-line-soft">
              {Array.from({ length: 4 }, (_, r) => (
                <div key={r} className="flex items-center justify-between py-2.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { data, loading, error, refetch, fetching } = useQuery(async () => {
    const now = new Date();
    const todayISO = toLocalISO(now);
    const monthStart = `${todayISO.slice(0, 7)}-01`;
    const monthStartTimestamp = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthKey = todayISO.slice(0, 7); // YYYY-MM, for /payments?month=
    const eightWeeksAgo = new Date(startOfWeek(now)); eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 7 * 7);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthStartISO = toLocalISO(prevMonthStart);
    const trendStart = prevMonthStart < eightWeeksAgo ? prevMonthStart : eightWeeksAgo;
    const trendFromISO = toLocalISO(trendStart);
    const trendFromTimestamp = trendStart.toISOString();
    const last30d = new Date(now); last30d.setDate(now.getDate() - 30);
    const last30dISO = toLocalISO(last30d);
    const chartsStart = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const chartsFrom = toLocalISO(chartsStart);
    const chartsFromTimestamp = chartsStart.toISOString();

    const [
      ordersRes, invoicesRes, paymentsRes, balancesRes, prRes, exceptionsRes, creditsRes,
      bankRes, supBalRes, suppliersRes, poItemsRes, priceUpRes, reqItemsRes, offersRes, openPoRes,
    ] = await Promise.all([
      // recent orders (8 weeks) — purchased today/week/month + the weekly series. created_at is the
      // time axis, non-draft/cancelled the filter, at snapshot prices (OPEN-DECISIONS #4, locked).
      supabase.from('purchase_orders').select('id, created_at, status, items:purchase_order_items(qty, unit_price)').gte('created_at', trendFromTimestamp).lte('created_at', now.toISOString()).not('status', 'in', '(draft,cancelled)'),
      supabase.from('invoices').select('id, supplier_id, invoice_date, received_date, total_amount, review_status, payment_status, export_status').is('deleted_at', null).gte('invoice_date', chartsFrom),
      supabase.from('payments').select('amount, paid_date').gte('paid_date', trendFromISO).lte('paid_date', todayISO),
      supabase.from('invoice_balances').select('balance'),
      supabase.from('payment_requests').select('id, status, due_date, amount'),
      supabase.from('exceptions').select('*, supplier:suppliers(name)').in('status', ['open', 'in_progress']).order('created_at', { ascending: false }),
      supabase.from('credit_requests').select('amount, status').in('status', ['open', 'requested', 'received']),
      supabase.from('bank_transactions').select('id, status'),
      supabase.from('supplier_balances').select('*').gt('open_balance', 0),
      supabase.from('suppliers').select('id, name'),
      supabase.from('purchase_order_items').select('qty, unit_price, product:products(category:categories(name)), order:purchase_orders!inner(created_at, status)').gte('order.created_at', chartsFromTimestamp).lte('order.created_at', now.toISOString()).not('order.status', 'in', '(draft,cancelled)'),
      // price increases — now bounded to the last 30 days (was a full unbounded scan): matches the
      // "מוצרים שהתייקרו לאחרונה" label and the alerts window (OPEN-DECISIONS #26).
      supabase.from('supplier_products').select('current_price, previous_price, price_effective_date, product:products(id, name), supplier:suppliers(name)').gte('price_effective_date', last30dISO).not('previous_price', 'is', null).order('price_effective_date', { ascending: false }),
      supabase.from('purchase_request_items').select('qty, unit_price, product_id, request:purchase_requests!inner(created_at, status)').gte('request.created_at', monthStartTimestamp).lte('request.created_at', now.toISOString()).eq('request.status', 'split'),
      // available offers for the savings estimate — kept minimal (2 cols) but cannot be date-bounded:
      // savings needs the max CURRENT available offer per product regardless of when it was set.
      supabase.from('supplier_products').select('product_id, current_price').eq('available', true),
      // open commitments — any date, so a PO sent months ago that is still open still counts. Also
      // serves the "awaiting goods receipt" queue, replacing the old serial round-trip.
      supabase.from('purchase_orders').select('id, status, items:purchase_order_items(qty, unit_price, received_qty)').in('status', ['sent', 'confirmed', 'partial']),
    ]);

    const orders = unwrap(ordersRes) as { created_at: string; items: { qty: number; unit_price: number }[] }[];
    const invoices = unwrap(invoicesRes) as { supplier_id: string; invoice_date: string; received_date: string; total_amount: number; review_status: string; payment_status: string; export_status: string }[];
    const payments = unwrap(paymentsRes) as { amount: number; paid_date: string }[];
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
    const ordersThisMonth = orders.filter((o) => {
      const date = localDateKey(o.created_at);
      return date >= monthStart && date <= todayISO;
    });
    const paymentsThisMonth = payments.filter((p) => {
      const date = localDateKey(p.paid_date);
      return date >= monthStart && date <= todayISO;
    });
    const purchasedMonth = ordersThisMonth.length ? ordersThisMonth.reduce((s, o) => s + orderValue(o), 0) : null;
    const paidMonth = paymentsThisMonth.length ? paymentsThisMonth.reduce((s, p) => s + p.amount, 0) : null;
    const openBalance = balances.length ? balances.reduce((s, b) => s + Math.max(0, b.balance), 0) : null;
    const openInvoiceCount = balances.filter((b) => b.balance > 0).length;

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

    // ── monthly expense chart (invoices by calendar month) + MoM change. Calendar buckets stay
    // consecutive even when a month has no invoices; an entirely empty source stays empty.
    const byMonth = new Map<string, number>();
    for (const inv of invoices) {
      const m = inv.invoice_date.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) ?? 0) + inv.total_amount);
    }
    const monthBuckets = Array.from({ length: 4 }, (_, idx) => {
      const date = new Date(now.getFullYear(), now.getMonth() - (3 - idx), 1);
      const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
      return { key, month: fmtMonth(`${key}-01`), total: Math.round(byMonth.get(key) ?? 0) };
    });
    const monthly = invoices.length ? monthBuckets.map(({ month, total }) => ({ month, total })) : [];
    const currentMonthKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const previousMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonthKey = `${previousMonthDate.getFullYear()}-${pad(previousMonthDate.getMonth() + 1)}`;
    const curMonthTotal = byMonth.get(currentMonthKey) ?? 0;
    const prevMonthTotal = byMonth.get(previousMonthKey) ?? 0;
    const momChange = prevMonthTotal > 0 ? ((curMonthTotal - prevMonthTotal) / prevMonthTotal) * 100 : null;

    // ── weekly magnitude series: buckets carry a row count so an artificial zero bucket is never
    // mistaken for an observed point. The same helper powers purchases and supplier payments.
    const weeklySeries = (rows: { date: string; value: number }[]): WeeklyPoint[] => {
      const buckets = Array.from({ length: 8 }, (_, idx) => {
        const ws = new Date(startOfWeek(now)); ws.setDate(ws.getDate() - (7 - idx) * 7);
        return { key: toLocalISO(ws), week: `${pad(ws.getDate())}/${pad(ws.getMonth() + 1)}`, total: 0, count: 0 };
      });
      const byWeek = new Map(buckets.map((bucket) => [bucket.key, bucket]));
      for (const row of rows) {
        const bucket = byWeek.get(toLocalISO(startOfWeek(timelineDate(row.date))));
        if (!bucket) continue;
        bucket.total += row.value;
        bucket.count += 1;
      }
      return buckets.map(({ week, total, count }) => ({ week, total: Math.round(total), count }));
    };
    const weekly = weeklySeries(orders.map((order) => ({ date: order.created_at, value: orderValue(order) })));
    const paidWeekly = weeklySeries(payments.map((payment) => ({ date: payment.paid_date, value: payment.amount })));

    // MTD is compared with the same number of calendar days in the previous month. Missing/zero
    // baseline means "not measurable", so the delta is omitted rather than rendered as 0%.
    const previousMonthLength = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const previousCutoffISO = toLocalISO(new Date(
      now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), previousMonthLength),
    ));
    const inPreviousMTD = (date: string) => {
      const key = localDateKey(date);
      return key >= prevMonthStartISO && key <= previousCutoffISO;
    };
    const purchasedPreviousMTD = orders.filter((order) => inPreviousMTD(order.created_at))
      .reduce((sum, order) => sum + orderValue(order), 0);
    const paidPreviousMTD = payments.filter((payment) => inPreviousMTD(payment.paid_date))
      .reduce((sum, payment) => sum + payment.amount, 0);
    const percentDelta = (current: number | null, previous: number) => (
      current == null || previous <= 0 ? null : ((current - previous) / previous) * 100
    );
    const purchasedDelta = percentDelta(purchasedMonth, purchasedPreviousMTD);
    const paidDelta = percentDelta(paidMonth, paidPreviousMTD);

    // ── by category (PO items, current month) — kept but demoted.
    const byCat = new Map<string, number>();
    for (const it of poItems) {
      const orderDate = localDateKey(it.order.created_at);
      if (orderDate < monthStart || orderDate > todayISO) continue;
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
      { key: 'pay-overdue', label: 'דרישות תשלום באיחור', count: paymentsOverdue, tone: 'alert', to: '/payment-requests?due=overdue', hint: paymentsOverdue == null ? 'לא הוגדרו תאריכי יעד' : undefined, clearLabel: 'אין תשלומים באיחור' },
      { key: 'pay-today', label: 'תשלומים לביצוע היום', count: paymentsDueToday, tone: 'await', to: '/payment-requests?due=today', hint: paymentsDueToday == null ? 'לא הוגדרו תאריכי יעד' : undefined, clearLabel: 'אין תשלומים להיום' },
      { key: 'exceptions', label: 'חריגים פתוחים', count: exceptions.length, tone: 'alert', to: '/exceptions?status=open', hint: highExceptions ? `${highExceptions} בחומרה גבוהה` : undefined, clearLabel: 'אין חריגים פתוחים' },
      { key: 'credits', label: 'זיכויים פתוחים', count: credits.length, amount: openCreditsSum, tone: 'info', to: '/credits?status=active', clearLabel: 'אין זיכויים פתוחים' },
      { key: 'commitments', label: 'התחייבויות רכש פתוחות', count: openPos.length, amount: committedSum, tone: 'idle', to: '/orders?status=open', hint: remainingSum > 0 ? `נותר לקבלה ${fmtMoney(remainingSum)}` : undefined, clearLabel: 'אין התחייבויות פתוחות' },
      { key: 'price-increases', label: 'ספקים שהעלו מחירים (30 יום)', count: priceIncreaseSuppliers, tone: 'await', to: '/prices?increases=1', clearLabel: 'אין שינויי מחירים' },
    ];

    return {
      fetchedAt: new Date(),   // query-completion time → drives the "עודכן ב-" stamp
      attention,
      money: { openBalance, openInvoiceCount, paidMonth, paidDelta, purchasedMonth, purchasedDelta, monthKey },
      monthly, weekly, paidWeekly, momChange, categories, savings,
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

  if (loading) return <DashboardSkeleton />;

  const t = chartTheme();

  return (
    <div className="dashboard-depth space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">דשבורד ניהולי</h1>
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <span aria-live="polite" aria-atomic="true">
            {data?.fetchedAt && (
              <span key={data.fetchedAt.getTime()} className="freshness-settle">
                עודכן ב-<span className="num">{timeFmt.format(data.fetchedAt)}</span>
              </span>
            )}
          </span>
          <button className="btn-ghost min-h-11 min-w-11 p-2!" onClick={() => void refetch()} disabled={fetching}
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
          <button className="btn-ghost min-h-11 shrink-0 whitespace-nowrap" onClick={() => void refetch()}>נסה שוב</button>
        </Note>
      )}

      {data && (<div className="dash-enter space-y-5">
      {/* Nir §1–3 — the control center. totalLabel scopes the summed ₪ as workload, not net debt. */}
      <div><AttentionZone items={data.attention} totalLabel="סה״כ בטיפול" /></div>

      {/* money band — one ledger strip with three navigable segments, not three identical
          tiles. `sub` carries a short plain-Hebrew gloss of each term. */}
      <div className="card grid grid-cols-1 sm:grid-cols-3">
        <BandStat title="יתרת חשבוניות פתוחות" value={data.money.openBalance} tone="await" to="/invoices?pay=unpaid"
          icon={ReceiptText} aux={data.money.openBalance == null ? 'אין נתונים זמינים' : `${data.money.openInvoiceCount} חשבוניות פתוחות`}
          sub="סך החוב לספקים על חשבוניות שטרם שולמו במלואן" />
        <BandStat title="שולם לספקים החודש" value={data.money.paidMonth} tone="done" to={`/payments?month=${data.money.monthKey}`}
          icon={Banknote} spark={data.paidWeekly} sparkLabel="תשלומים לספקים בשמונה השבועות האחרונים" delta={data.money.paidDelta}
          sub="סך התשלומים שיצאו לספקים החודש" />
        <BandStat title="נרכש החודש" value={data.money.purchasedMonth} to="/orders?status=all"
          icon={ShoppingCart} spark={data.weekly} sparkLabel="רכש בשמונה השבועות האחרונים" delta={data.money.purchasedDelta}
          sub={data.savings != null
            ? `חיסכון משוער החודש: ההפרש מול המחיר היקר ביותר שהוצע — ${fmtMoney(data.savings)}`
            : 'שווי ההזמנות שנוצרו החודש (במחירי ההזמנה)'} />
      </div>

      {/* operational detail — exceptions + recent price increases */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card card-pad">
          <div className="flex items-center justify-between mb-2">
            <h2 className="section-title">חריגים פתוחים</h2>
            <Link to="/exceptions?status=open" className="btn-ghost min-h-11 text-xs">לכל החריגים <ChevronLeft size={13} /></Link>
          </div>
          {data.exceptions.length ? (
            <ul className="divide-y divide-line-soft">
              {data.exceptions.map((e) => (
                <li key={e.id}>
                  <Link to={`/exceptions?id=${e.id}`} className="block min-h-11 py-2 text-sm -mx-2 px-2 rounded-lg hover:bg-surface-sunken active:bg-action-wash/70 transition-colors">
                    <div className="flex items-center gap-2">
                      <StatusBadge meta={SEVERITY[e.severity]} />
                      <span className="text-xs text-ink-muted">{EXCEPTION_TYPE[e.type]}</span>
                    </div>
                    <div className="text-ink-mid truncate mt-0.5">{e.title}</div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <div className="text-sm text-done-fg py-6 text-center">אין חריגים פתוחים כרגע</div>}
          {/* folded risk hints (Nir §1: duplicate suspicions, unmatched bank movements).
              Shown only when > 0 — a risk indicator printing "0" is the fake-zero the plan forbids;
              the count-0 "all clear" is already carried by AttentionZone tier B. */}
          {(data.meta.suspectedDup > 0 || data.meta.unmatchedBank > 0) && (
            <div className="mt-3 pt-3 border-t border-line-soft flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {data.meta.suspectedDup > 0 && (
                <Link to="/exceptions?type=duplicate_invoice,duplicate_payment" className="inline-flex min-h-11 items-center text-ink-muted hover:text-ink-mid active:text-ink">חשד לכפילות: <span className="num font-medium">{data.meta.suspectedDup}</span></Link>
              )}
              {data.meta.unmatchedBank > 0 && (
                <Link to="/bank?status=unmatched" className="inline-flex min-h-11 items-center text-ink-muted hover:text-ink-mid active:text-ink">תנועות בנק לא מותאמות: <span className="num font-medium">{data.meta.unmatchedBank}</span></Link>
              )}
            </div>
          )}
        </div>

        <div className="card card-pad">
          <div className="flex items-center justify-between mb-2">
            <h2 className="section-title flex items-center gap-1.5"><TrendingUp size={16} className="text-trend-up-fg" /> מוצרים שהתייקרו לאחרונה</h2>
            <Link to="/prices?increases=1" className="btn-ghost min-h-11 text-xs">לכל המחירונים <ChevronLeft size={13} /></Link>
          </div>
          {data.priceIncreases.length ? (
            <ul className="divide-y divide-line-soft">
              {data.priceIncreases.map((p, i) => (
                <li key={i}>
                  <Link to={`/prices?product=${p.product.id}`} className="flex min-h-11 items-center justify-between py-2 text-sm -mx-2 px-2 rounded-lg hover:bg-surface-sunken active:bg-action-wash/70 transition-colors">
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-ink-body">{p.product.name}</span>
                      <span className="text-ink-muted text-xs ms-2">{p.supplier.name}</span>
                    </span>
                    <span className="flex items-center gap-3 shrink-0">
                      {/* explicit direction (מ־… ל־…): "₪X ← ₪Y" is ambiguous in RTL */}
                      <span className="text-xs text-ink-muted">מ־<span className="num">₪{p.previous_price!.toFixed(2)}</span> ל־<span className="num">₪{p.current_price.toFixed(2)}</span></span>
                      {/* fix: text in the darker alert-fg (contrast); arrow keeps the lighter trend hue */}
                      <span className="inline-flex items-center gap-1 text-alert-fg font-medium num" dir="ltr"><TrendingUp size={13} className="text-trend-up-fg" />+{p.pct.toFixed(1)}%</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <div className="text-sm text-ink-muted py-6 text-center">אין התייקרויות אחרונות</div>}
        </div>
      </div>

      {/* suppliers with open balance + tasks by role */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card card-pad">
          <div className="flex items-center justify-between mb-2">
            <h2 className="section-title">ספקים עם יתרה פתוחה</h2>
            <Link to="/suppliers?balance=open" className="btn-ghost min-h-11 text-xs">לכל הספקים <ChevronLeft size={13} /></Link>
          </div>
          {data.topBalances.length ? (
            <ul className="divide-y divide-line-soft">
              {data.topBalances.map((b) => (
                <li key={b.id}>
                  <Link to={`/suppliers/${b.id}`} className="flex min-h-11 items-center justify-between py-2 text-sm -mx-2 px-2 rounded-lg hover:bg-surface-sunken active:bg-action-wash/70 transition-colors">
                    <span className="text-ink-mid">{b.name}</span>
                    <span className="font-semibold num text-await-fg">{fmtMoneyExact(b.balance)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <div className="text-sm text-ink-muted py-6 text-center">אין יתרות פתוחות</div>}
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
          {data.monthly.length ? (
            <ChartViewport className="h-56"
              label={`הוצאות רכש לפי חודש: ${data.monthly.map((m) => `${m.month} ${money(m.total)}`).join(', ')}`}>
              {(animation) => (
                <ResponsiveContainer>
                  <BarChart data={data.monthly} margin={{ top: 20, left: 8, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={t.grid} />
                    <XAxis dataKey="month" tick={{ fontSize: 12, fill: t.tick }} axisLine={false} tickLine={false} />
                    <YAxis hide />
                    <Tooltip formatter={(v) => money(Number(v))} isAnimationActive={animation.active} />
                    <Bar dataKey="total" name="סה״כ" fill={t.bar} radius={[4, 4, 0, 0]} maxBarSize={56}
                      isAnimationActive={animation.active} animationDuration={550} animationEasing="ease-out" onAnimationEnd={animation.finish}>
                      <LabelList dataKey="total" position="top" formatter={(v: number) => money(v)} style={{ fontSize: 12, fill: t.label }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartViewport>
          ) : <div className="text-sm text-ink-muted py-6 text-center">אין נתוני חשבוניות לתקופה</div>}
        </div>

        <div className="card card-pad">
          <h2 className="section-title mb-1" title="שווי ההזמנות שנוצרו בכל שבוע (במחירי ההזמנה)">רכש לפי שבוע (8 שבועות אחרונים)</h2>
          {data.weekly.some((point) => point.count > 0) ? (
            <ChartViewport className="h-56"
              label={`רכש לפי שבוע: ${data.weekly.map((w) => `${w.week} ${money(w.total)}`).join(', ')}`}>
              {(animation) => (
                <ResponsiveContainer>
                  <BarChart data={data.weekly} margin={{ top: 20, left: 8, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={t.grid} />
                    <XAxis dataKey="week" tick={{ fontSize: 12, fill: t.tick }} axisLine={false} tickLine={false} />
                    <YAxis hide />
                    <Tooltip formatter={(v) => money(Number(v))} isAnimationActive={animation.active} />
                    <Bar dataKey="total" name="סה״כ" fill={t.bar} radius={[4, 4, 0, 0]} maxBarSize={40}
                      isAnimationActive={animation.active} animationDuration={550} animationEasing="ease-out" onAnimationEnd={animation.finish}>
                      <LabelList dataKey="total" position="top" formatter={(v: number) => moneyShort(v)} style={{ fontSize: 12, fill: t.label }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartViewport>
          ) : <div className="text-sm text-ink-muted py-6 text-center">אין רכש בשמונת השבועות האחרונים</div>}
        </div>

        <div className="card card-pad lg:col-span-2">
          <h2 className="section-title mb-1" title="פילוח הרכש של החודש לפי קטגוריית מוצר">הוצאות לפי קטגוריה (החודש)</h2>
          {data.categories.length ? (
            <ChartViewport
              className=""
              style={{ height: Math.min(240, Math.max(96, data.categories.length * 34 + 16)) }}
              label={`הוצאות לפי קטגוריה: ${data.categories.slice(0, 12).map((c) => `${c.name} ${money(c.total)}`).join(', ')}`}
            >
              {(animation) => (
                <ResponsiveContainer>
                  <BarChart data={data.categories} layout="vertical" margin={{ left: 72, right: 48 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={t.grid} />
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" orientation="right" width={90} tick={{ fontSize: 12, fill: t.tickStrong }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={(v) => money(Number(v))} isAnimationActive={animation.active} />
                    <Bar dataKey="total" name="סה״כ" fill={t.bar} radius={[4, 0, 0, 4]} maxBarSize={22}
                      isAnimationActive={animation.active} animationDuration={550} animationEasing="ease-out" onAnimationEnd={animation.finish}>
                      <LabelList dataKey="total" position="left" formatter={(v: number) => money(v)} style={{ fontSize: 12, fill: t.label }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartViewport>
          ) : <div className="text-sm text-ink-muted py-6 text-center">אין רכש החודש</div>}
        </div>
      </div>
      </div>)}
    </div>
  );
}

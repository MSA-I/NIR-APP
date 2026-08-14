import { Link } from 'react-router';
import { type ReactNode } from 'react';
import { Banknote, Check, ChevronDown, ChevronLeft, ReceiptText, RotateCw, ShoppingCart, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { unwrap, useQuery } from '../lib/useQuery';
import { Skeleton, StatusBadge, Note, AttentionZone, PageHeader, TaskLine, type AttentionItem } from '../components/ui';
import { EXCEPTION_TYPE, PO_STATUS, SEVERITY } from '../lib/status';
import {
  addCalendarDays, BUSINESS_TIME_ZONE, dateStartInstant, daysInCalendarMonth,
  fmtMoneyExact, fmtMoneyRounded, fmtMonth, localDateKey, shiftCalendarMonth, startOfCalendarWeek,
  todayISO as businessTodayISO,
} from '../lib/format';
import { chartTheme } from '../lib/theme';
import { mergeWeeklyComparison, topCategoriesWithOther } from '../lib/dashboardSeries';
import { CategoryDonut, ComparisonLineChart, money, moneyShort, SpendBarChart, TrendSparkline } from '../components/charts';
import { fetchAll } from '../lib/supabasePaging';

// audit round 2: glance values are whole-shekel by convention — the three money-strip tiles round to
// whole ₪ so they read consistently at a glance (₪8,131 not ₪14,842.6). Tables elsewhere keep exact
// amounts; format.ts is untouched. null stays null → "—", never a fake rounded 0 (CLAUDE.md:37).
// The rounding moved into the formatter (format.ts): a glance surface is a shape decision, not
// something each call site re-derives. The alias stays because it names the surface.
const glanceMoney = fmtMoneyRounded;
// "עודכן ב-HH:MM" freshness stamp — the screen promises real-time, so it says when it last read.
const timeFmt = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: BUSINESS_TIME_ZONE });

type WeeklyPoint = { week: string; total: number; count: number; label: string };
type ManagementDashboardSnapshot = {
  money: { openBalance: number | null; openInvoiceCount: number };
  paymentRequests: {
    pendingApproval: number;
    drafts: number;
    dueDateCoverage: number;
    activeCount: number;
    overdue: number | null;
    dueToday: number | null;
  };
  credits: { count: number; sum: number | null };
  bank: { unmatched: number; suggested: number };
  invoices: { pendingApproval: number; toReview: number; notSent: number };
  openOrders: { count: number; committed: number | null; remaining: number; noDate: number; late: number; awaitingConfirmation: number };
  openSupplierCount: number;
  topBalances: { id: string; name: string; balance: number }[];
};

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

// One segment of the money band. Segments live in a single .card and separate with logical
// borders (border-t stacked / border-s side-by-side) — never divide-x, which is physical
// left/right and breaks under RTL (see supplier-metrics.tsx).
function BandStat({ title, value, tone = 'idle', to, context, icon: Icon, aux, delta, spark, sparkLabel }: {
  title: string;
  value: number | null;
  tone?: 'done' | 'await' | 'idle';
  to: string;
  context: string;
  icon: LucideIcon;
  aux?: string;
  delta?: number | null;
  spark?: WeeklyPoint[];
  sparkLabel?: string;
}) {
  const toneCls = { done: 'text-done-fg', await: 'text-await-fg', idle: 'text-ink' }[tone];
  const chipCls = {
    done: 'bg-done-wash text-done-fg',
    await: 'bg-await-wash text-await-fg',
    idle: 'bg-idle-wash text-idle-fg',
  }[tone];
  const hasSpark = value != null && spark != null && spark.filter((point) => point.count > 0).length >= 2;
  const linkLabel = [
    `${title}: ${glanceMoney(value)}`,
    delta != null ? `${Math.round(delta) > 0 ? '+' : ''}${Math.round(delta)}% מול אותם ימים בחודש הקודם` : null,
    context,
    aux,
  ].filter(Boolean).join('. ');
  return (
    <Link
      to={to}
      aria-label={linkLabel}
      className="block min-h-20 border-t border-line-soft px-4 py-3 transition-colors first:border-t-0 hover:bg-surface-sunken active:bg-action-wash/70 sm:border-s sm:border-t-0 sm:px-5 sm:first:border-s-0"
    >
      <div className="flex items-center gap-2">
        <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${chipCls}`} aria-hidden="true">
          <Icon size={16} />
        </span>
        <span className="text-xs font-medium text-ink-muted">{title}</span>
        {delta != null && <DeltaChip value={delta} />}
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <div className={`shrink-0 text-xl font-semibold num sm:text-2xl ${toneCls}`} dir="ltr">{glanceMoney(value)}</div>
        {hasSpark && spark && sparkLabel && <TrendSparkline points={spark} label={sparkLabel} />}
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-xs text-ink-muted">
        <span>{delta != null ? 'מול אותם ימים בחודש הקודם' : context}</span>
        <span className="min-w-0 text-end leading-snug">{aux ?? (hasSpark ? 'מגמת 8 שבועות' : context)}</span>
      </div>
    </Link>
  );
}

function OperationsDisclosure({ title, count, summary, empty, children }: {
  title: string;
  count: number;
  summary?: string;
  empty: string;
  children: ReactNode;
}) {
  if (count === 0) {
    return (
      <div className="flex min-h-11 items-center gap-2 border-t border-line-soft px-4 py-2.5 text-sm text-ink-muted first:border-t-0 sm:px-5">
        <Check size={15} className="shrink-0 text-done-solid" aria-hidden="true" />
        <span>{empty}</span>
        <span className="badge-idle num ms-auto">0</span>
      </div>
    );
  }

  return (
    <details name="dashboard-operations" className="group border-t border-line-soft first:border-t-0">
      <summary className="flex min-h-11 flex-wrap items-center gap-2 px-4 py-2.5 text-sm hover:bg-surface-sunken active:bg-action-wash/70 [&::-webkit-details-marker]:hidden sm:px-5">
        <span className="font-medium text-ink-body">{title}</span>
        <span className="badge-idle num">{count}</span>
        {summary && <span className="ms-auto min-w-0 text-end text-xs text-ink-muted">{summary}</span>}
        <ChevronDown size={16} className="shrink-0 text-ink-ghost transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t border-line-soft px-4 pb-4 pt-2 sm:px-5">{children}</div>
    </details>
  );
}

// One order due for delivery today/tomorrow, with the products it should bring.
type DeliveryOrder = {
  id: string;
  number: number;
  status: string;
  expected_date: string;
  supplier_id: string;
  supplier: { name: string } | null;
  items: { qty: number; product: { name: string } | null }[];
};

// אספקות היום ומחר — the morning check-in strip (section 12): which suppliers should show up at
// the door today and tomorrow. The always-visible face carries the two DISTINCT-supplier counts;
// the native disclosure (same idiom as OperationsDisclosure, not a modal) reveals the per-order
// detail: supplier · order number · status · expected products. purchase_orders has no
// delivery-hour column, so no time is shown or invented. Orders with a NULL expected_date are
// excluded from the counts and reported honestly as one quiet hint line instead.
function DeliveriesCard({ today, tomorrow, noDateCount, className = '' }: {
  today: DeliveryOrder[];
  tomorrow: DeliveryOrder[];
  noDateCount: number;
  className?: string;
}) {
  const distinctSuppliers = (rows: DeliveryOrder[]) => new Set(rows.map((o) => o.supplier_id)).size;
  const groups = [
    { key: 'today', label: 'היום', rows: today, suppliers: distinctSuppliers(today), emptyLabel: 'אין אספקות מתוכננות להיום' },
    { key: 'tomorrow', label: 'מחר', rows: tomorrow, suppliers: distinctSuppliers(tomorrow), emptyLabel: 'אין אספקות מתוכננות למחר' },
  ];
  const total = today.length + tomorrow.length;

  // The honesty line: open orders (same statuses) that simply have no expected_date. Without it,
  // a quiet card could read "all clear" while five undated orders are still in flight.
  const noDateHint = noDateCount > 0 ? (
    <Link to="/orders" className="inline-flex min-h-11 items-center text-xs text-ink-muted hover:text-ink-mid active:text-ink">
      <span className="num me-1">{noDateCount}</span> הזמנות פתוחות ללא תאריך אספקה
    </Link>
  ) : null;

  // Measured zero for both days → the existing all-clear idiom (the card never hides).
  if (total === 0) {
    return (
      <section className="card overflow-hidden">
        <div className="px-4 py-4 sm:px-5">
          <h2 className="section-title">אספקות היום ומחר</h2>
        </div>
        <div className="border-t border-line-soft px-4 py-2.5 sm:px-5">
          <div className="flex min-h-11 items-center gap-2 text-sm text-ink-muted">
            <Check size={15} className="shrink-0 text-done-solid" aria-hidden="true" />
            <span>אין אספקות מתוכננות להיום ומחר</span>
            <span className="badge-idle num ms-auto">0</span>
          </div>
          {noDateHint}
        </div>
      </section>
    );
  }

  return (
    <section className={`card overflow-hidden ${className}`}>
      <div className="px-4 py-4 sm:px-5">
        <h2 className="section-title">אספקות היום ומחר</h2>
        <p className="mt-0.5 text-xs text-ink-muted">ספקים שאמורים לספק סחורה; פירוט ההזמנות בלחיצה</p>
      </div>
      <details className="group border-t border-line-soft">
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3 hover:bg-surface-sunken active:bg-action-wash/70 focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden sm:px-5">
          {groups.map((group) => (
            <span key={group.key} className="flex items-baseline gap-1.5">
              <span className="text-xs font-medium text-ink-muted">{group.label}</span>
              <span className={`text-xl font-semibold num sm:text-2xl ${group.suppliers > 0 ? 'text-ink' : 'text-ink-muted'}`}>{group.suppliers}</span>
              <span className="text-xs text-ink-muted">{group.suppliers === 1 ? 'ספק' : 'ספקים'}</span>
            </span>
          ))}
          <ChevronDown size={16} className="ms-auto shrink-0 text-ink-ghost transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="border-t border-line-soft px-4 pb-4 pt-2 sm:px-5">
          {groups.map((group) => (
            <div key={group.key} className="mt-3 first:mt-0">
              <div className="mb-1 text-xs font-medium text-ink-muted">{group.label}</div>
              {group.rows.length === 0 ? (
                <div className="flex items-center gap-1.5 py-1 text-xs text-ink-muted">
                  <Check size={13} className="shrink-0 text-done-solid" aria-hidden="true" /> {group.emptyLabel}
                </div>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {group.rows.map((order) => (
                    <li key={order.id}>
                      <Link to={`/orders/${order.id}`} className="block min-h-11 rounded-lg px-2 py-2 text-sm hover:bg-surface-sunken active:bg-action-wash/70">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-ink-body">{order.supplier?.name ?? '—'}</span>
                          <span className="num text-xs text-ink-muted">#{order.number}</span>
                          <StatusBadge meta={PO_STATUS[order.status]} />
                        </div>
                        {order.items.length > 0 && (
                          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-muted">
                            {order.items.map((item, index) => (
                              <span key={index}>{item.product?.name ?? '—'} <span className="num">×{item.qty}</span></span>
                            ))}
                          </div>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {noDateHint && <div className="mt-3 border-t border-line-soft pt-2">{noDateHint}</div>}
        </div>
      </details>
    </section>
  );
}

// Calendar buckets are anchored to the business timezone, not the browser/server timezone.
const pad = (n: number) => String(n).padStart(2, '0');

// audit round 2: the loading state was <PageLoader/> — a centred spinner that collapses the page
// height and jumps when data lands, exactly what ui.tsx warns against on a known layout (and this is
// the flagship screen). This mirrors the above-the-fold shape instead: header, the "דורש טיפול" card,
// the money strip, the trend card and the folded detail card. One role="status" region with a single "טוען"
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

      {/* deliveries card (אספקות היום ומחר): title + the two-count summary row */}
      <div className="card overflow-hidden">
        <div className="px-4 py-4 sm:px-5"><Skeleton className="h-5 w-40" /></div>
        <div className="flex min-h-11 items-center gap-6 border-t border-line-soft px-4 py-3 sm:px-5">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-6 w-24" />
          <Skeleton className="ms-auto h-4 w-4" />
        </div>
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

      {/* money band: one card, three compact segments */}
      <div className="card grid grid-cols-1 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="min-h-20 px-4 py-3 sm:px-5 border-t sm:border-t-0 sm:border-s border-line-soft first:border-t-0 sm:first:border-s-0">
            <div className="flex items-center gap-2">
              <Skeleton className="size-8 rounded-lg" />
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="mt-2 flex items-end justify-between gap-3">
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-4 sm:px-5"><Skeleton className="h-5 w-24" /></div>
        <div className="grid grid-cols-1 border-t border-line-soft lg:grid-cols-12">
          <div className="p-4 lg:col-span-7 lg:border-e lg:border-line-soft sm:p-5">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="mt-3 h-48 w-full rounded-lg" />
          </div>
          <div className="border-t border-line-soft p-4 lg:col-span-5 lg:border-t-0 sm:p-5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-3 h-48 w-full rounded-lg" />
          </div>
          <div className="border-t border-line-soft p-4 lg:col-span-12 sm:p-5">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="mt-3 h-48 w-full rounded-lg" />
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-4 sm:px-5"><Skeleton className="h-5 w-44" /></div>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex min-h-11 items-center gap-3 border-t border-line-soft px-4 sm:px-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-6 w-8 rounded-full" />
            <Skeleton className="ms-auto h-3 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { data, loading, error, refetch, fetching } = useQuery(async () => {
    const now = new Date();
    const todayISO = businessTodayISO();
    const tomorrowISO = addCalendarDays(todayISO, 1);
    const monthStart = `${todayISO.slice(0, 7)}-01`;
    const monthKey = todayISO.slice(0, 7); // YYYY-MM, for /payments?month=
    const monthStartTimestamp = dateStartInstant(monthStart);
    const eightWeeksAgoISO = addCalendarDays(startOfCalendarWeek(todayISO), -7 * 7);
    const prevMonthKey = shiftCalendarMonth(monthKey, -1);
    const prevMonthStartISO = `${prevMonthKey}-01`;
    const trendFromISO = prevMonthStartISO < eightWeeksAgoISO ? prevMonthStartISO : eightWeeksAgoISO;
    const trendFromTimestamp = dateStartInstant(trendFromISO);
    const last30dISO = addCalendarDays(todayISO, -30);
    const chartsFrom = `${shiftCalendarMonth(monthKey, -3)}-01`;
    const chartsFromTimestamp = dateStartInstant(chartsFrom);

    const [
      ordersRes, invoicesRes, paymentsRes, exceptionsRes, poItemsRes, priceUpRes,
      reqItemsRes, offersRes, deliveriesRes, snapshotRes,
    ] = await Promise.all([
      // recent orders (8 weeks) — purchased today/week/month + the weekly series. created_at is the
      // time axis, non-draft/cancelled the filter, at snapshot prices (OPEN-DECISIONS #4, locked).
      fetchAll((from, to) => supabase.from('purchase_orders').select('id, created_at, status, items:purchase_order_items(qty, unit_price)').gte('created_at', trendFromTimestamp).lte('created_at', now.toISOString()).not('status', 'in', '(draft,cancelled)').order('created_at').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('invoices').select('id, supplier_id, invoice_date, received_date, total_amount, review_status, payment_status, export_status').eq('financial_role', 'payable').is('deleted_at', null).gte('invoice_date', chartsFrom).order('invoice_date').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('payments').select('id, amount, paid_date').gte('paid_date', trendFromISO).lte('paid_date', todayISO).order('paid_date').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('exceptions').select('*, supplier:suppliers(name)').in('status', ['open', 'in_progress']).order('created_at', { ascending: false }).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('purchase_order_items').select('id, qty, unit_price, product:products(category:categories(name)), order:purchase_orders!inner(created_at, status)').gte('order.created_at', chartsFromTimestamp).lte('order.created_at', now.toISOString()).not('order.status', 'in', '(draft,cancelled)').order('id').range(from, to)),
      // price increases — now bounded to the last 30 days (was a full unbounded scan): matches the
      // "מוצרים שהתייקרו לאחרונה" label and the alerts window (OPEN-DECISIONS #26).
      fetchAll((from, to) => supabase.from('supplier_products').select('id, current_price, previous_price, price_effective_date, product:products(id, name), supplier:suppliers(name)').gte('price_effective_date', last30dISO).not('previous_price', 'is', null).order('price_effective_date', { ascending: false }).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('purchase_request_items').select('id, qty, unit_price, product_id, request:purchase_requests!inner(created_at, status)').gte('request.created_at', monthStartTimestamp).lte('request.created_at', now.toISOString()).eq('request.status', 'split').order('id').range(from, to)),
      // available offers for the savings estimate — kept minimal (2 cols) but cannot be date-bounded:
      // savings needs the max CURRENT available offer per product regardless of when it was set.
      fetchAll((from, to) => supabase.from('supplier_products').select('id, product_id, current_price').eq('available', true).order('id').range(from, to)),
      // deliveries due today/tomorrow — open POs (sent/confirmed/partial) whose expected_date is
      // today or tomorrow (OPEN-DECISIONS: a delivery = open order + expected_date). NULL
      // expected_date rows are excluded by the gte and surfaced as a count from openPos instead.
      fetchAll((from, to) => supabase.from('purchase_orders').select('id, number, status, expected_date, supplier_id, supplier:suppliers(name), items:purchase_order_items(qty, product:products(name))').in('status', ['sent', 'confirmed', 'partial']).gte('expected_date', todayISO).lte('expected_date', tomorrowISO).order('expected_date').order('id').range(from, to)),
      supabase.rpc('management_dashboard_snapshot', { p_today: todayISO }),
    ]);

    const orders = ordersRes as unknown as { created_at: string; items: { qty: number; unit_price: number }[] }[];
    const invoices = invoicesRes as unknown as { supplier_id: string; invoice_date: string; received_date: string; total_amount: number; review_status: string; payment_status: string; export_status: string }[];
    const payments = paymentsRes as unknown as { amount: number; paid_date: string }[];
    const exceptions = exceptionsRes as unknown as ({ id: string; type: string; severity: 'low' | 'medium' | 'high'; title: string; created_at: string; supplier: { name: string } | null })[];
    const poItems = poItemsRes as unknown as { qty: number; unit_price: number; product: { category: { name: string } | null } | null; order: { created_at: string } }[];
    const priceRows = priceUpRes as unknown as { current_price: number; previous_price: number | null; price_effective_date: string; product: { id: string; name: string }; supplier: { name: string } }[];
    const reqItems = reqItemsRes as unknown as { qty: number; unit_price: number | null; product_id: string }[];
    const offers = offersRes as unknown as { product_id: string; current_price: number }[];
    const deliveries = deliveriesRes as unknown as DeliveryOrder[];
    const snapshot = unwrap(snapshotRes) as ManagementDashboardSnapshot | null;
    if (!snapshot) throw new Error('dashboard_snapshot_unavailable');

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
    const { openBalance, openInvoiceCount } = snapshot.money;

    // ── attention counts. A count of 0 is a real "all clear" (rendered in tier B as "✓ אין…").
    // `null` is reserved for what genuinely cannot be measured.
    const invoicesPendingApproval = snapshot.invoices.pendingApproval;
    const prPendingApproval = snapshot.paymentRequests.pendingApproval;

    // Payments due/overdue can ONLY come from payment_requests that carry a MANUAL due_date —
    // invoices have no due_date and suppliers.payment_terms is free text nobody parses. Undated
    // requests are excluded; if not one active request has a date, the metric is unknown → null (—),
    // never 0 (which would falsely assert "nothing is overdue"). See OPEN-DECISIONS #27.
    const paymentsOverdue = snapshot.paymentRequests.overdue;
    const paymentsDueToday = snapshot.paymentRequests.dueToday;

    const highExceptions = exceptions.filter((e) => e.severity === 'high').length;
    const suspectedDup = exceptions.filter((e) => ['duplicate_invoice', 'duplicate_payment'].includes(e.type)).length;
    const unmatchedBank = snapshot.bank.unmatched;
    const suggestedBank = snapshot.bank.suggested;

    const openCreditsSum = snapshot.credits.sum;

    const committedSum = snapshot.openOrders.committed;
    const remainingSum = snapshot.openOrders.remaining;
    const lateDeliveries = snapshot.openOrders.late;
    const awaitingConfirmation = snapshot.openOrders.awaitingConfirmation;

    // ── estimated savings this month: chosen price vs the most expensive available offer.
    const maxOffer = new Map<string, number>();
    for (const o of offers) maxOffer.set(o.product_id, Math.max(maxOffer.get(o.product_id) ?? 0, o.current_price));
    const savings = reqItems.length ? reqItems.reduce((s, it) => {
      if (it.unit_price == null) return s;
      const max = maxOffer.get(it.product_id) ?? it.unit_price;
      return s + Math.max(0, (max - it.unit_price) * it.qty);
    }, 0) : null;
    // savings as a % of the worst-case (most-expensive-offer) basket, so the ₪ figure has a scale.
    const savingsBaseline = reqItems.reduce((s, it) => {
      if (it.unit_price == null) return s;
      return s + (maxOffer.get(it.product_id) ?? it.unit_price) * it.qty;
    }, 0);
    const savingsPct = savings != null && savingsBaseline > 0 ? (savings / savingsBaseline) * 100 : null;

    // ── price increases (from the 30-day set). The attention metric is SUPPLIERS, not products.
    const priceIncreases = priceRows
      .filter((r) => r.previous_price != null && r.current_price > r.previous_price)
      .map((r) => ({ ...r, pct: ((r.current_price - r.previous_price!) / r.previous_price!) * 100 }))
      .sort((a, b) => b.pct - a.pct);
    const priceIncreaseSuppliers = new Set(priceIncreases.map((r) => r.supplier.name)).size;

    // ── monthly expense chart (invoices by calendar month) + MoM change. Calendar buckets stay
    // consecutive even when a month has no invoices; an entirely empty source stays empty.
    const byMonth = new Map<string, { total: number; count: number }>();
    for (const inv of invoices) {
      const m = inv.invoice_date.slice(0, 7);
      const bucket = byMonth.get(m) ?? { total: 0, count: 0 };
      bucket.total += inv.total_amount;
      bucket.count += 1;
      byMonth.set(m, bucket);
    }
    const monthBuckets = Array.from({ length: 4 }, (_, idx) => {
      const key = shiftCalendarMonth(monthKey, -(3 - idx));
      const bucket = byMonth.get(key) ?? { total: 0, count: 0 };
      const total = bucket.total;
      return { key, month: fmtMonth(`${key}-01`), total, count: bucket.count, label: bucket.count ? money(total) : '' };
    });
    const monthly = invoices.length ? monthBuckets.map(({ month, total, count, label }) => ({ month, total, count, label })) : [];
    const curMonthBucket = byMonth.get(monthKey);
    const prevMonthBucket = byMonth.get(prevMonthKey);
    const momChange = curMonthBucket && prevMonthBucket && prevMonthBucket.total > 0
      ? ((curMonthBucket.total - prevMonthBucket.total) / prevMonthBucket.total) * 100
      : null;

    // ── weekly magnitude series: buckets carry a row count so an artificial zero bucket is never
    // mistaken for an observed point. The same helper powers purchases and supplier payments.
    const weeklySeries = (rows: { date: string; value: number }[]): WeeklyPoint[] => {
      const currentWeekStart = startOfCalendarWeek(todayISO);
      const buckets = Array.from({ length: 8 }, (_, idx) => {
        const key = addCalendarDays(currentWeekStart, -(7 - idx) * 7);
        return { key, week: `${key.slice(8, 10)}/${key.slice(5, 7)}`, total: 0, count: 0 };
      });
      const byWeek = new Map(buckets.map((bucket) => [bucket.key, bucket]));
      for (const row of rows) {
        const bucket = byWeek.get(startOfCalendarWeek(localDateKey(row.date)));
        if (!bucket) continue;
        bucket.total += row.value;
        bucket.count += 1;
      }
      return buckets.map(({ week, total, count }) => ({ week, total, count, label: count ? moneyShort(total) : '' }));
    };
    const weekly = weeklySeries(orders.map((order) => ({ date: order.created_at, value: orderValue(order) })));
    const paidWeekly = weeklySeries(payments.map((payment) => ({ date: payment.paid_date, value: payment.amount })));

    // MTD is compared with the same number of calendar days in the previous month. Missing/zero
    // baseline means "not measurable", so the delta is omitted rather than rendered as 0%.
    const previousMonthLength = daysInCalendarMonth(prevMonthKey);
    const previousCutoffISO = `${prevMonthKey}-${pad(Math.min(Number(todayISO.slice(8, 10)), previousMonthLength))}`;
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
    const categories = topCategoriesWithOther([...byCat.entries()].map(([name, total]) => ({ name, total })))
      .map((category) => ({ ...category, label: moneyShort(category.total) }));

    // supplier open balances — id is KEPT so each row can link to /suppliers/:id (was dropped).
    const topBalances = snapshot.topBalances;

    // ── "דורש טיפול היום", ordered by business importance.
    // Tones use section 6's semantic vocabulary: await=ממתין · alert=דחוף · info=מידע · idle=ניטרלי.
    const attention: AttentionItem[] = [
      { key: 'inv-approval', label: 'חשבוניות הממתינות לאישור', count: invoicesPendingApproval, tone: 'await', to: '/invoices?review=pending_approval', clearLabel: 'אין חשבוניות לאישור' },
      { key: 'pr-approval', label: 'דרישות תשלום הממתינות לאישור', count: prPendingApproval, tone: 'await', to: '/payment-requests?status=pending_approval', clearLabel: 'אין דרישות לאישור' },
      { key: 'pay-overdue', label: 'דרישות תשלום באיחור', count: paymentsOverdue, tone: 'alert', to: '/payment-requests?due=overdue', hint: paymentsOverdue == null ? 'אין מספיק תאריכי פירעון כדי למדוד איחורים' : undefined, clearLabel: 'אין תשלומים באיחור' },
      { key: 'pay-today', label: 'תשלומים לביצוע היום', count: paymentsDueToday, tone: 'await', to: '/payment-requests?due=today', hint: paymentsDueToday == null ? 'לא הוגדרו תאריכי יעד' : undefined, clearLabel: 'אין תשלומים להיום' },
      { key: 'exceptions', label: 'חריגים פתוחים', count: exceptions.length, tone: 'alert', to: '/exceptions?status=open', hint: highExceptions ? `${highExceptions} בחומרה גבוהה` : undefined, clearLabel: 'אין חריגים פתוחים' },
      { key: 'credits', label: 'זיכויים פתוחים', count: snapshot.credits.count, amount: openCreditsSum, tone: 'info', to: '/credits?status=active', clearLabel: 'אין זיכויים פתוחים' },
      { key: 'commitments', label: 'התחייבויות רכש פתוחות', count: snapshot.openOrders.count, amount: committedSum, tone: 'idle', to: '/orders?status=open', hint: remainingSum > 0 ? `נותר לקבלה ${fmtMoneyRounded(remainingSum)}` : undefined, clearLabel: 'אין התחייבויות פתוחות' },
      { key: 'late-delivery', label: 'הזמנות באיחור באספקה', count: lateDeliveries, tone: 'alert', to: '/receiving', clearLabel: 'אין הזמנות באיחור' },
      { key: 'awaiting-confirmation', label: 'הזמנות ממתינות לאישור ספק', count: awaitingConfirmation, tone: 'await', to: '/orders?status=sent', clearLabel: 'כל ההזמנות אושרו' },
      { key: 'price-increases', label: 'ספקים שהעלו מחירים (30 יום)', count: priceIncreaseSuppliers, tone: 'await', to: '/prices?increases=1', clearLabel: 'אין שינויי מחירים' },
    ];

    return {
      fetchedAt: new Date(),   // query-completion time → drives the "עודכן ב-" stamp
      // אספקות היום ומחר — split by day here so the card only renders. noDateCount comes from
      // openPos (already fetched): open orders that carry no expected_date at all.
      deliveries: {
        today: deliveries.filter((d) => d.expected_date === todayISO),
        tomorrow: deliveries.filter((d) => d.expected_date === tomorrowISO),
        noDateCount: snapshot.openOrders.noDate,
      },
      attention,
      money: { openBalance, openInvoiceCount, paidMonth, paidDelta, purchasedMonth, purchasedDelta, monthKey },
      monthly, weekly, paidWeekly, momChange, categories, savings, savingsPct,
      priceIncreases: priceIncreases.slice(0, 6),
      priceIncreaseCount: priceIncreases.length,
      topBalances,
      openSupplierCount: snapshot.openSupplierCount,
      exceptions: exceptions.slice(0, 6),
      exceptionCount: exceptions.length,
      meta: { suspectedDup, unmatchedBank, suggestedBank },
      queue: {
        receiving: snapshot.openOrders.count,
        invoicesToReview: snapshot.invoices.toReview,
        prDrafts: snapshot.paymentRequests.drafts,
        prPendingApproval,
        highExceptions,
        notSentToAccountant: snapshot.invoices.notSent,
      },
    };
  });

  if (loading) return <DashboardSkeleton />;

  const t = chartTheme();
  const taskTotal = data ? Object.values(data.queue).reduce((sum, count) => sum + count, 0) : 0;
  const weeklyComparison = data ? mergeWeeklyComparison(data.weekly, data.paidWeekly) : [];
  const categoryTotal = data?.categories.reduce((sum, category) => sum + category.total, 0) ?? 0;
  const monthlyAria = data ? `הוצאות רכש לפי חודש: ${data.monthly.length
    ? data.monthly.map((point) => `${point.month} ${point.count ? fmtMoneyExact(point.total) : 'אין חשבוניות'}`).join(', ')
    : 'אין נתוני חשבוניות לתקופה'}` : '';
  const weeklyAria = `השוואת רכש ותשלומים לפי שבוע: ${weeklyComparison.map((point) => (
    `${point.week}, רכש ${point.purchases == null ? 'אין רשומות' : fmtMoneyExact(point.purchases)}, תשלומים ${point.payments == null ? 'אין רשומות' : fmtMoneyExact(point.payments)}`
  )).join('; ')}`;
  const categoryEmptyMessage = data?.categories.length
    ? `נמדד רכש בסכום ${fmtMoneyExact(categoryTotal)}; אין תמהיל חיובי להצגה`
    : 'אין רכש החודש';
  const categoriesAria = data ? `הוצאות לפי קטגוריה: ${categoryTotal > 0
    ? data.categories.map((category) => `${category.name} ${fmtMoneyExact(category.total)}, ${Math.round((category.total / categoryTotal) * 100)} אחוז`).join(', ')
    : categoryEmptyMessage}` : '';
  const actionKinds = data?.attention.filter((item) => item.count != null && item.count > 0 && (item.tone === 'alert' || item.tone === 'await')).length ?? 0;

  return (
    <div className="dashboard-depth space-y-5">
      <PageHeader title="מרכז הבקרה"
        meta={actionKinds > 0 ? `יש היום ${actionKinds} סוגי טיפול שדורשים תשומת לב` : 'אין משימות דחופות כרגע'}
        actions={<div className="flex items-center gap-2 text-xs text-ink-muted">
          <span aria-live="polite" aria-atomic="true">
            {data?.fetchedAt && (
              <span key={data.fetchedAt.getTime()} className="freshness-settle">
                עודכן ב-<span className="num">{timeFmt.format(data.fetchedAt)}</span>
              </span>
            )}
          </span>
          <button className="btn-ghost min-h-11 min-w-11 p-2!" onClick={() => void refetch()} disabled={fetching}
            aria-label="רענון נתוני מרכז הבקרה" title="רענון">
            <RotateCw size={15} className={fetching ? 'animate-spin' : ''} />
          </button>
        </div>} />

      {/* Truth-reporting (CLAUDE.md): a failed load/refetch shows an inline note WITH retry and keeps
          whatever data we still hold on screen — it never blanks the sections that did load. */}
      {error && (
        <Note tone="alert" className="flex items-center justify-between gap-3">
          <span>{error}</span>
          <button className="btn-ghost min-h-11 shrink-0 whitespace-nowrap" onClick={() => void refetch()}>נסה שוב</button>
        </Note>
      )}

      {/* flex, not space-y: `order` below only moves flex/grid children, and margins cannot be
          reordered at all. Each zone declares its own entrance step for both viewports — see the
          `--dash-step` rules in index.css — because below lg the money band moves to the top and
          DOM position stops describing what the eye sees. */}
      {data && (
        <div className="dash-enter flex flex-col gap-5">
          <AttentionZone items={data.attention} totalLabel="סה״כ בטיפול"
            className="[--dash-step-mobile:1] [--dash-step:0]" />

          <DeliveriesCard today={data.deliveries.today} tomorrow={data.deliveries.tomorrow} noDateCount={data.deliveries.noDateCount}
            className="[--dash-step-mobile:2] [--dash-step:1]" />

          {/* Section 12 on a phone: the manager opens the app and sees a figure. The band used to
              sit below two cards, so the first fold at 390 held no money at all. It is FIRST on
              screen below lg and third from lg up, where all three zones fit the fold anyway.
              DOM order is unchanged on purpose — the quality gate pins the heading order. */}
          <div className="card grid grid-cols-1 sm:grid-cols-3 order-first lg:order-none [--dash-step-mobile:0] [--dash-step:2]">
            <BandStat title="יתרת חשבוניות פתוחות" value={data.money.openBalance} tone="await" to="/invoices?pay=unpaid"
              icon={ReceiptText} context="נכון לעכשיו"
              aux={data.money.openBalance == null ? 'אין נתונים זמינים' : `${data.money.openInvoiceCount} חשבוניות פתוחות`} />
            <BandStat title="שולם לספקים החודש" value={data.money.paidMonth} tone="done" to={`/payments?month=${data.money.monthKey}`}
              icon={Banknote} context="מתחילת החודש" delta={data.money.paidDelta}
              spark={data.paidWeekly} sparkLabel="מגמת תשלומים לספקים בשמונה השבועות האחרונים" />
            <BandStat title="נרכש החודש" value={data.money.purchasedMonth} to="/orders?status=all"
              icon={ShoppingCart} context="מתחילת החודש" delta={data.money.purchasedDelta}
              aux={data.savings != null ? `חיסכון משוער ${fmtMoneyRounded(data.savings)}${data.savingsPct != null ? ` · ${data.savingsPct.toFixed(0)}%` : ''}` : undefined}
              spark={data.weekly} sparkLabel="מגמת רכש בשמונה השבועות האחרונים" />
          </div>

          <section className="card overflow-hidden [--dash-step-mobile:3] [--dash-step:3]">
            <div className="px-4 py-4 sm:px-5">
              <h2 className="section-title">מגמות</h2>
              <p className="mt-0.5 text-xs text-ink-muted">רכש, תשלומים ותמהיל הוצאות במבט אחד</p>
            </div>

            <div className="grid grid-cols-1 border-t border-line-soft lg:grid-cols-12">
              <section className="p-4 sm:p-5 lg:col-span-7 lg:border-e lg:border-line-soft" aria-labelledby="monthly-trend-title">
                <div className="flex min-h-8 flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 id="monthly-trend-title" className="text-sm font-semibold text-ink-body">הוצאות רכש לפי חודש</h3>
                    <p className="text-xs text-ink-muted">חשבוניות שהתקבלו בארבעת החודשים האחרונים</p>
                  </div>
                  {data.momChange != null && (
                    <span className={`text-xs font-medium ${data.momChange > 0 ? 'text-alert-fg' : 'text-done-fg'}`} dir="ltr">
                      {data.momChange > 0 ? '+' : ''}{data.momChange.toFixed(0)}% מול חודש קודם
                    </span>
                  )}
                </div>
                <SpendBarChart
                  points={data.monthly.map((point) => ({ key: point.month, label: point.label, total: point.total }))}
                  ariaLabel={monthlyAria} emptyMessage="אין נתוני חשבוניות לתקופה" />
              </section>

              <section className="border-t border-line-soft p-4 sm:p-5 lg:col-span-5 lg:border-t-0" aria-labelledby="category-trend-title">
                <h3 id="category-trend-title" className="text-sm font-semibold text-ink-body">תמהיל הרכש החודש</h3>
                <p className="text-xs text-ink-muted">ארבע הקטגוריות הגדולות וכל היתר</p>
                <CategoryDonut slices={data.categories} total={categoryTotal} ariaLabel={categoriesAria} emptyMessage={categoryEmptyMessage} />
              </section>

              <section className="border-t border-line-soft p-4 sm:p-5 lg:col-span-12" aria-labelledby="weekly-trend-title">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 id="weekly-trend-title" className="text-sm font-semibold text-ink-body">רכש מול תשלומים</h3>
                    <p className="text-xs text-ink-muted">שמונה השבועות האחרונים</p>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-ink-muted" aria-hidden="true">
                    <span className="inline-flex items-center gap-1.5"><span className="w-6 border-t-2" style={{ borderColor: t.bars[0] }} />רכש</span>
                    <span className="inline-flex items-center gap-1.5"><span className="w-6 border-t-2 border-dashed" style={{ borderColor: t.bars[2] }} />תשלומים</span>
                  </div>
                </div>
                <ComparisonLineChart points={weeklyComparison} xKey="week" legend={false}
                  series={[{ key: 'purchases', name: 'רכש', color: t.bars[0] }, { key: 'payments', name: 'תשלומים', color: t.bars[2], dashed: true }]}
                  ariaLabel={weeklyAria} emptyMessage="אין רכש או תשלומים בשמונת השבועות האחרונים" />
              </section>
            </div>
          </section>

          <section className="card overflow-hidden [--dash-step-mobile:4] [--dash-step:4]">
            <div className="px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
              <h2 className="section-title">תמונת מצב תפעולית</h2>
              <p className="mt-0.5 text-xs text-ink-muted">הפירוט זמין לפי צורך; הפעולות הדחופות נשארות למעלה.</p>
            </div>
            <div className="border-t border-line-soft">
              <OperationsDisclosure title="חריגים פתוחים" count={data.exceptionCount}
                summary={data.queue.highExceptions ? `${data.queue.highExceptions} בחומרה גבוהה` : undefined}
                empty="אין חריגים פתוחים כרגע">
                <div className="flex justify-end">
                  <Link to="/exceptions?status=open" className="btn-ghost min-h-11 text-xs">לכל החריגים <ChevronLeft size={13} /></Link>
                </div>
                <ul className="divide-y divide-line-soft">
                  {data.exceptions.map((exception) => (
                    <li key={exception.id}>
                      <Link to={`/exceptions?id=${exception.id}`} className="block min-h-11 rounded-lg px-2 py-2 text-sm hover:bg-surface-sunken active:bg-action-wash/70">
                        <div className="flex items-center gap-2">
                          <StatusBadge meta={SEVERITY[exception.severity]} />
                          <span className="text-xs text-ink-muted">{EXCEPTION_TYPE[exception.type]}</span>
                        </div>
                        <div className="mt-0.5 break-words text-ink-mid sm:truncate">{exception.title}</div>
                      </Link>
                    </li>
                  ))}
                </ul>
                {(data.meta.suspectedDup > 0 || data.meta.unmatchedBank > 0 || data.meta.suggestedBank > 0) && (
                  <div className="mt-3 flex flex-wrap gap-x-4 border-t border-line-soft pt-2 text-xs">
                    {data.meta.suspectedDup > 0 && (
                      <Link to="/exceptions?type=duplicate_invoice,duplicate_payment" className="inline-flex min-h-11 items-center text-ink-muted hover:text-ink-mid active:text-ink">
                        חשד לכפילות: <span className="num font-medium">{data.meta.suspectedDup}</span>
                      </Link>
                    )}
                    {data.meta.unmatchedBank > 0 && (
                      <Link to="/bank?status=unmatched" className="inline-flex min-h-11 items-center text-ink-muted hover:text-ink-mid active:text-ink">
                        תנועות בנק לא מותאמות: <span className="num font-medium">{data.meta.unmatchedBank}</span>
                      </Link>
                    )}
                    {data.meta.suggestedBank > 0 && (
                      <Link to="/bank?status=suggested" className="inline-flex min-h-11 items-center text-ink-muted hover:text-ink-mid active:text-ink">
                        התאמות שממתינות לאישור: <span className="num font-medium">{data.meta.suggestedBank}</span>
                      </Link>
                    )}
                  </div>
                )}
              </OperationsDisclosure>

              <OperationsDisclosure title="מוצרים שהתייקרו לאחרונה" count={data.priceIncreaseCount}
                summary={data.priceIncreases[0] ? `עלייה מרבית ${data.priceIncreases[0].pct.toFixed(1)}%` : undefined}
                empty="אין התייקרויות אחרונות">
                <div className="flex justify-end">
                  <Link to="/prices?increases=1" className="btn-ghost min-h-11 text-xs">לכל המחירונים <ChevronLeft size={13} /></Link>
                </div>
                <ul className="divide-y divide-line-soft">
                  {data.priceIncreases.map((price, index) => (
                    <li key={index}>
                      <Link to={`/prices?product=${price.product.id}`} className="flex min-h-11 flex-col items-stretch gap-2 rounded-lg px-2 py-2 text-sm hover:bg-surface-sunken active:bg-action-wash/70 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        <span className="min-w-0 break-words sm:truncate">
                          <span className="font-medium text-ink-body">{price.product.name}</span>
                          <span className="ms-2 text-xs text-ink-muted">{price.supplier.name}</span>
                        </span>
                        <span className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 sm:justify-start">
                          <span className="text-xs text-ink-muted">מ־<span className="num">{fmtMoneyExact(price.previous_price)}</span> ל־<span className="num">{fmtMoneyExact(price.current_price)}</span></span>
                          <span className="inline-flex items-center gap-1 font-medium text-alert-fg num" dir="ltr">
                            <TrendingUp size={13} className="text-trend-up-fg" />+{price.pct.toFixed(1)}%
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </OperationsDisclosure>

              <OperationsDisclosure title="ספקים עם יתרה פתוחה" count={data.openSupplierCount}
                summary={data.topBalances[0] ? `${data.topBalances[0].name} · ${fmtMoneyExact(data.topBalances[0].balance)}` : undefined}
                empty="אין יתרות פתוחות">
                <div className="flex justify-end">
                  <Link to="/suppliers?balance=open" className="btn-ghost min-h-11 text-xs">לכל הספקים <ChevronLeft size={13} /></Link>
                </div>
                <ul className="divide-y divide-line-soft">
                  {data.topBalances.map((balance) => (
                    <li key={balance.id}>
                      <Link to={`/suppliers/${balance.id}`} className="flex min-h-11 items-center justify-between rounded-lg px-2 py-2 text-sm hover:bg-surface-sunken active:bg-action-wash/70">
                        <span className="text-ink-mid">{balance.name}</span>
                        <span className="font-semibold text-await-fg num">{fmtMoneyExact(balance.balance)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </OperationsDisclosure>

              <OperationsDisclosure title="משימות לפי תפקיד" count={taskTotal}
                summary={`${Object.values(data.queue).filter((count) => count > 0).length} תורים פעילים`}
                empty="אין משימות פתוחות לפי תפקיד">
                <ul className="space-y-1 text-sm">
                  <TaskLine label="הזמנות ממתינות לקבלת סחורה (ניר)" count={data.queue.receiving} to="/orders?status=open" />
                  <TaskLine label="חשבוניות לבדיקה (מזכירות)" count={data.queue.invoicesToReview} to="/invoices?review=received" />
                  <TaskLine label="טיוטות דרישת תשלום (מזכירות)" count={data.queue.prDrafts} to="/payment-requests" />
                  <TaskLine label="דרישות לאישור הנהלה" count={data.queue.prPendingApproval} to="/payment-requests?status=pending_approval" />
                  <TaskLine label="חריגים בחומרה גבוהה (הנהלה)" count={data.queue.highExceptions} to="/exceptions?status=open&severity=high" />
                  <TaskLine label="חשבוניות שטרם הועברו לרו״ח" count={data.queue.notSentToAccountant} to="/invoices?export=not_sent" />
                </ul>
              </OperationsDisclosure>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

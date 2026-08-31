import { useT } from '../lib/i18n/LocaleProvider';
import { Link } from 'react-router';
import { useState, type ReactNode } from 'react';
import { ArrowUpLeft, Banknote, Check, ChevronDown, ChevronLeft, ReceiptText, RefreshCw, ShoppingCart, TrendingUp, type LucideIcon } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { unwrap, useQuery } from '../lib/useQuery';
import { Skeleton, StatusBadge, Note, AttentionZone, PageHeader, Card, ICON, ToggleGroup, PeriodComparison, type AttentionItem, type ComparisonBasis } from '../components/ui';
import { EXCEPTION_TYPE, PO_STATUS, SEVERITY } from '../lib/status';
import {
  addCalendarDays, BUSINESS_TIME_ZONE, dateStartInstant, daysInCalendarMonth,
  fmtMoneyExact, fmtMoneyRounded, fmtMonth, localDateKey, productLabel, shiftCalendarMonth,
  startOfCalendarWeek,
  todayISO as businessTodayISO,
} from '../lib/format';
import { comparisonSeries } from '../lib/theme';
import { mergeWeeklyComparison, topCategoriesWithOther } from '../lib/dashboardSeries';
import { CategoryDonut, ComparisonLineChart, moneyFor, moneyShortFor, SpendBarChart, TrendSparkline } from '../components/charts';
import type { MoneyAmount } from '../lib/types';
import { fetchAll } from '../lib/supabasePaging';
import { useAuth } from '../auth/AuthContext';
import { PlanBadge } from '../components/PlanBadge';

// audit round 2: glance values are whole-shekel by convention — the three money-strip tiles round to
// whole ₪ so they read consistently at a glance (₪8,131 not ₪14,842.6). Tables elsewhere keep exact
// amounts; format.ts is untouched. null stays null → "—", never a fake rounded 0 (CLAUDE.md:37).
// The rounding moved into the formatter (format.ts): a glance surface is a shape decision, not
// something each call site re-derives. The alias stays because it names the surface.
/**
 * Every glance figure on this screen is drawn in the currency the row it came from is in — never
 * in a currency the screen picked. `glanceMoney(value, currency)` keeps the shape rule (whole
 * units on a glance surface) and leaves the unit to the data.
 */
const glanceMoney = fmtMoneyRounded;
// "עודכן ב-HH:MM" freshness stamp — the screen promises real-time, so it says when it last read.
const timeFmt = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: BUSINESS_TIME_ZONE });

type WeeklyPoint = { week: string; total: number; count: number; label: string };
/**
 * 0218 split every money figure on this snapshot into one entry per currency, and renamed each key
 * with it. What this screen DOES with those entries is `OPEN-DECISIONS #301` (owner, 30.08.2026):
 *
 *   ONE CURRENCY AT A TIME, AND THE READER PICKS IT. Every figure that carries money — the KPI
 *     strip, the attention rows, the due-window bar, the deltas, the charts, the supplier list —
 *     is in the currency the picker is on. Nothing is summed across currencies and nothing is
 *     converted; the picker names the others and one click reads them instead.
 *   COUNTS OF THINGS STAY WHOLE. Exceptions, invoices to review, the role queue: these have no
 *     unit, so there is nothing about them for a currency to make wrong.
 *
 * This REPLACES the two-mode rule of `0217`/plan §3.1, under which a glanced-at figure rendered
 * every currency as its own line while the figures computed beside it were quietly base-currency
 * only. That shape was honest per figure and unreadable per screen: it handed the reader two
 * numbers and no way to compare either of them with the trend under it. The half of it that was
 * right survives unchanged and is now the whole rule — a ratio, a percentage change or a bar width
 * across two currencies is not a smaller version of the truth, it is a different number entirely.
 */
type ManagementDashboardSnapshot = {
  money: {
    /* `invoiceCount` per entry has been in the RPC's payload since `0218` (`invoice_balance_money`
       emits currency, amount and invoice_count together) and was dropped on the way into
       TypeScript, because a screen that showed every currency at once only ever needed the one
       total beside them. A screen that shows ONE currency needs that currency's count, or the
       context line under a shekel balance counts dollar invoices too. */
    openBalanceByCurrency: (MoneyAmount & { invoiceCount: number })[] | null;
    /** Every open invoice, all currencies together. Kept for the callers that count documents. */
    openInvoiceCount: number;
  };
  paymentRequests: {
    pendingApproval: number;
    drafts: number;
    dueDateCoverage: number;
    activeCount: number;
    overdue: number | null;
    dueToday: number | null;
    // 0148 — the due-window money. All four figures below ride the same evidence guard as
    // `overdue`/`dueToday`: null means "no active request carries a due date at all", while 0
    // means "dated requests exist and none of them fall here". Never conflate the two.
    overdueAmountByCurrency: MoneyAmount[] | null;
    dueWithin7AmountByCurrency: MoneyAmount[] | null;
    dueWithin7Count: number | null;
  };
  credits: { count: number; sumByCurrency: MoneyAmount[] | null };
  bank: { unmatched: number; suggested: number };
  invoices: { pendingApproval: number; toReview: number; notSent: number };
  openOrders: {
    count: number;
    committedByCurrency: MoneyAmount[] | null;
    remainingByCurrency: MoneyAmount[];
    noDate: number; late: number; awaitingConfirmation: number;
  };
  openSupplierCount: number;
  topBalancesByCurrency: { currency: string; rows: { id: string; name: string; balance: number }[] }[];
};

/** The base-currency entry of a per-currency list, or null when that currency is not in it. */
const inBaseCurrency = (entries: MoneyAmount[] | null | undefined, base: string | null | undefined) =>
  entries?.find((entry) => entry.currency === base)?.amount ?? null;

/** Every currency in a list that is not the organisation's own — what the note has to mention. */
const currenciesBeside = (entries: MoneyAmount[] | null | undefined, base: string | null | undefined) =>
  [...new Set((entries ?? []).filter((entry) => entry.currency !== base).map((entry) => entry.currency))].sort();

// DeltaChip lived here until 31.08.2026. It rendered the arrow and the percent, and its
// accessible sentence named a FIXED baseline — "against the same days last month" — which was
// true for both of its callers and would have been false for the third comparison on this
// screen. `PeriodComparison` (ui.tsx) replaces it and takes the baseline as an argument, so the
// sentence is a fact about the caller rather than a constant. The neutral ink it insisted on
// survives verbatim: a change without a business verdict is never green or red.

/* CoveragePills (the reference's capsule row) lived here for one round (T7.3) and was removed by
   owner decision — "לא רלוונטי". Deleted rather than left dormant. */

// One hero money stat. T7 (Crextio-reference layout): the strip lost its card and its logical
// borders — the three figures sit straight on the wheat canvas, Crextio-style, and separate by
// spacing alone. Each stat keeps its full anatomy: icon chip · label · hero figure · delta ·
// sparkline · context line.
function BandStat({ title, value, tone = 'idle', to, context, icon: Icon, aux, comparison, spark, sparkLabel, currency }: {
  title: string;
  value: number | null;
  tone?: 'done' | 'await' | 'idle';
  to: string;
  context: string;
  icon: LucideIcon;
  aux?: string;
  /** The baseline and what it is, or nothing where the tile has no comparison to make. */
  comparison?: { previous: number | null; basis: ComparisonBasis } | null;
  spark?: WeeklyPoint[];
  sparkLabel?: string;
  /** The one currency this tile's figure is in. A tile shows one number, so it shows one unit. */
  currency: string | null | undefined;
}) {
  const { t } = useT();
  // T7.2 (Crextio strip): the icon sits flat beside the label — no chip box; the tone lives on
  // the figure alone.
  const toneCls = { done: 'text-done-fg', await: 'text-await-fg', idle: 'text-ink' }[tone];
  const hasSpark = value != null && spark != null && spark.filter((point) => point.count > 0).length >= 2;
  /* The accessible name carries the same two facts the line below carries — the change and what
     it is measured against — rather than a percentage floating free of its baseline. */
  const comparablePrevious = comparison && comparison.previous != null && comparison.previous > 0
    ? comparison.previous : null;
  const spokenDelta = value != null && comparablePrevious != null
    ? Math.round(((value - comparablePrevious) / comparablePrevious) * 100) : null;
  const linkLabel = [
    `${title}: ${glanceMoney(value, currency)}`,
    comparison == null || value == null ? null
      : spokenDelta == null
        ? t('comparison.noBasis')
        : `${spokenDelta > 0 ? '+' : ''}${spokenDelta}% ${comparison.basis.partial
          ? t('comparison.againstPartial', { current: comparison.basis.currentLabel, previous: comparison.basis.previousLabel })
          : t('comparison.against', { previous: comparison.basis.previousLabel })}`,
    comparison ? comparison.basis.sourceLabel : context,
    aux,
  ].filter(Boolean).join('. ');
  return (
    <Card
      as={Link}
      pad={false}
      to={to}
      aria-label={linkLabel}
      className="card-link-hover block min-h-24 px-4 py-3.5 sm:px-5"
    >
      <div className="flex items-center gap-2">
        <Icon size={ICON.md} className="shrink-0 text-ink-muted" aria-hidden="true" />
        <span className="text-xs font-medium text-ink-muted">{title}</span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <div className={`shrink-0 kpi-hero num ${toneCls}`} dir="ltr">{glanceMoney(value, currency)}</div>
        {hasSpark && spark && sparkLabel && <TrendSparkline points={spark} label={sparkLabel} currency={currency} />}
      </div>
      {/* One context line, never the same sentence twice. Where a comparison exists it IS the
          line — the change, the two periods by name, and where the figure came from — so the tile
          does not grow a row: what used to be a chip in the header and a vague "against the same
          days last month" underneath is now one sentence a reader can actually check. */}
      <div className="mt-1 flex items-center justify-between gap-3 text-xs text-ink-muted">
        {/* A figure that was not measured has nothing to compare, so the tile keeps its plain
            context line rather than going blank: `PeriodComparison` renders nothing on a null
            current, and an empty row would drop "מתחילת החודש" from a tile that still needs to
            say which period it is about. */}
        {comparison && value != null
          ? <PeriodComparison current={value} previous={comparison.previous} basis={comparison.basis} />
          : <span>{context}</span>}
        {(aux ?? (hasSpark ? t('dashboard.text_3') : null)) && (
          <span className="min-w-0 text-end leading-snug">{aux ?? t('dashboard.text_4')}</span>
        )}
      </div>
    </Card>
  );
}

// One folded operational subject. It no longer lives inside a card, so it carries no horizontal
// padding of its own: the rows align with the page gutter and separate with a single hairline.
// The negative-inline margin is only so the hover/active wash of the summary bleeds past the text
// the way every other row in the system does.
function OperationsDisclosure({ title, count, summary, empty, children }: {
  title: string;
  count: number;
  summary?: string;
  empty: string;
  children: ReactNode;
}) {
  if (count === 0) {
    return (
      <div className="flex min-h-11 items-center gap-2 border-t border-line-soft py-2.5 text-sm text-ink-muted first:border-t-0">
        <Check size={ICON.sm} className="shrink-0 text-done-fg" aria-hidden="true" />
        <span>{empty}</span>
        <span className="badge-idle num ms-auto">0</span>
      </div>
    );
  }

  return (
    <details name="dashboard-operations" className="group border-t border-line-soft first:border-t-0">
      <summary className="-mx-2 flex min-h-11 list-none flex-wrap items-center gap-2 rounded-lg px-2 py-2.5 text-sm hover:bg-surface-hover active:bg-surface-selected focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
        <span className="font-medium text-ink-body">{title}</span>
        <span className="badge-idle num">{count}</span>
        {summary && <span className="ms-auto min-w-0 text-end text-xs text-ink-muted">{summary}</span>}
        <ChevronDown size={ICON.sm} className="shrink-0 text-ink-ghost transition-transform motion-reduce:transition-none group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t border-line-soft pb-4 pt-2">{children}</div>
    </details>
  );
}

// T7 (Crextio-reference layout): the role queues moved out of the folded operational snapshot into
// the dashboard's single dark surface — the Onyx contrast card, the analogue of the reference's
// dark report tile. Same six queues, same counts, same links; only the container changed, so
// nothing is duplicated (the disclosure that held them was removed). The count pill is now the
// app's canonical "how many" chip — `badge` + bg-action-soft/text-action-on-soft, the pair
// ui.tsx already uses for the filter count — instead of a private shell-ink spelling. It still
// answers "how many", never "how urgent" (חוק צ'יפ הספירה); a light chip carries its own
// contrast on the Onyx card, which the 10%-alpha shell-ink pill did not.
function RoleQueueCard({ queue, total, className = '' }: {
  queue: {
    receiving: number; invoicesToReview: number; prDrafts: number;
    prPendingApproval: number; highExceptions: number; notSentToAccountant: number;
  };
  total: number;
  className?: string;
}) {
  const { t } = useT();
  const rows = [
    { label: t('dashboard.text_5'), count: queue.receiving, to: '/orders?status=open' },
    { label: t('dashboard.text_6'), count: queue.invoicesToReview, to: '/invoices?review=received' },
    { label: t('dashboard.text_7'), count: queue.prDrafts, to: '/payment-requests' },
    { label: t('dashboard.text_8'), count: queue.prPendingApproval, to: '/payment-requests?status=pending_approval' },
    { label: t('dashboard.text_9'), count: queue.highExceptions, to: '/exceptions?status=open&severity=high' },
    { label: t('dashboard.text_10'), count: queue.notSentToAccountant, to: '/invoices?export=not_sent' },
  ];
  // The reference's dot-matrix rendering, on TRUE data: one dot per open task in the queue,
  // capped at 12 (the number beside carries the exact count; the dots are aria-hidden texture).
  const DOT_CAP = 12;
  return (
    <section className={`relative rounded-3xl bg-shell p-4 text-shell-ink shadow-dashboard sm:p-5 ${className}`} aria-labelledby="role-queues-title">
      {/* The reference's corner circle-chip: a round paper-on-dark arrow to the full queue. */}
      <Link to="/alerts" aria-label={t('dashboard.aria_label')}
        className="group absolute end-3 top-3 grid size-11 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        <span className="grid size-9 place-items-center rounded-full bg-shell-ink/10 text-shell-ink transition-colors group-hover:bg-shell-ink/20">
          <ArrowUpLeft size={ICON.sm} aria-hidden="true" />
        </span>
      </Link>
      <h2 id="role-queues-title" className="section-title pe-16 text-shell-ink">{t('dashboard.text_11')}</h2>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="kpi-hero num text-shell-ink">{total}</span>
        <span className="text-xs text-shell-ink-dim">{t('dashboard.text_12')}</span>
      </div>
      <ul className="mt-3 space-y-0.5 text-sm">
        {rows.map((row) => (
          <li key={row.label}>
            <Link to={row.to}
              className="-mx-2 flex min-h-11 items-center gap-3 rounded-lg px-2 py-1.5 text-shell-ink-soft transition-colors hover:bg-shell-ink/10 hover:text-shell-ink active:bg-shell-ink/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <span className="min-w-0 flex-1 leading-snug">{row.label}</span>
              {row.count > 0 && (
                <span className="flex max-w-24 flex-wrap items-center justify-end gap-1" aria-hidden="true">
                  {Array.from({ length: Math.min(row.count, DOT_CAP) }, (_, i) => (
                    <span key={i} className="size-1.5 rounded-full bg-shell-ink/80" />
                  ))}
                  {row.count > DOT_CAP && <span className="text-xs text-shell-ink-dim">+</span>}
                </span>
              )}
              <span className="badge num min-w-8 shrink-0 justify-center bg-action-soft text-action-on-soft">{row.count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
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
  items: { qty: number; product: { name: string; display_name: string | null } | null }[];
};

// אספקות היום ומחר — the morning check-in strip (section 12): which suppliers should show up at
// the door today and tomorrow. The always-visible face carries the two DISTINCT-supplier counts;
// the native disclosure (same idiom as OperationsDisclosure, not a modal) reveals the per-order
// detail: supplier · order number · status · expected products. purchase_orders has no
// delivery-hour column, so no time is shown or invented. Orders with a NULL expected_date are
// excluded from the counts and reported honestly as one quiet hint line instead.
//
// Not a card any more (density round, 18.08.2026). A heading, one hairline and the counts say
// "this is a distinct subject" without a second border, a second radius and a second shadow around
// a region whose whole body is one summary row. The two facts on screen — today's supplier count
// and tomorrow's — and every row behind the fold are unchanged; only the box is gone.
function DeliveriesZone({ today, tomorrow, noDateCount, className = '' }: {
  today: DeliveryOrder[];
  tomorrow: DeliveryOrder[];
  noDateCount: number;
  className?: string;
}) {
  const { t } = useT();
  const distinctSuppliers = (rows: DeliveryOrder[]) => new Set(rows.map((o) => o.supplier_id)).size;
  const groups = [
    { key: 'today', label: t('dashboard.distinctSuppliers'), rows: today, suppliers: distinctSuppliers(today), emptyLabel: t('dashboard.distinctSuppliers_2') },
    { key: 'tomorrow', label: t('dashboard.distinctSuppliers_3'), rows: tomorrow, suppliers: distinctSuppliers(tomorrow), emptyLabel: t('dashboard.distinctSuppliers_4') },
  ];
  const total = today.length + tomorrow.length;

  // The honesty line: open orders (same statuses) that simply have no expected_date. Without it,
  // a quiet card could read "all clear" while five undated orders are still in flight.
  const noDateHint = noDateCount > 0 ? (
    <Link to="/orders" className="inline-flex min-h-11 items-center text-xs text-ink-muted hover:text-ink-mid active:text-ink">
      <span className="num me-1">{noDateCount}</span> {t('dashboard.openOrdersNoDate')}
    </Link>
  ) : null;

  return (
    <Card as="section" className={className} aria-labelledby="deliveries-title">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id="deliveries-title" className="section-title">{t('dashboard.text_13')}</h2>
        <p className="text-xs text-ink-muted">{t('dashboard.text_14')}</p>
      </div>
      {/* Measured zero for both days → the existing all-clear idiom (the zone never hides). */}
      {total === 0 ? (
        <div className="mt-2 border-t border-line-soft pt-2">
          <div className="flex min-h-11 items-center gap-2 text-sm text-ink-muted">
            <Check size={ICON.sm} className="shrink-0 text-done-fg" aria-hidden="true" />
            <span>{t('dashboard.text_15')}</span>
            <span className="badge-idle num ms-auto">0</span>
          </div>
          {noDateHint}
        </div>
      ) : (
        <details className="group mt-2 border-t border-line-soft">
          <summary className="-mx-2 flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-6 gap-y-1 rounded-lg px-2 py-3 hover:bg-surface-hover active:bg-surface-selected focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden">
            {groups.map((group) => (
              <span key={group.key} className="flex items-baseline gap-1.5">
                <span className="text-xs font-medium text-ink-muted">{group.label}</span>
                <span className={`kpi-value-compact num ${group.suppliers > 0 ? 'text-ink' : 'text-ink-muted'}`}>{group.suppliers}</span>
                <span className="text-xs text-ink-muted">{group.suppliers === 1 ? t('dashboard.text_16') : t('dashboard.text_17')}</span>
              </span>
            ))}
            <ChevronDown size={ICON.sm} className="ms-auto shrink-0 text-ink-ghost transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="border-t border-line-soft pb-2 pt-2">
            {groups.map((group) => (
              <div key={group.key} className="mt-3 first:mt-0">
                <div className="mb-1 text-xs font-medium text-ink-muted">{group.label}</div>
                {group.rows.length === 0 ? (
                  <div className="flex items-center gap-1.5 py-1 text-xs text-ink-muted">
                    <Check size={ICON.xs} className="shrink-0 text-done-fg" aria-hidden="true" /> {group.emptyLabel}
                  </div>
                ) : (
                  <ul className="divide-y divide-line-soft">
                    {group.rows.map((order) => (
                      <li key={order.id}>
                        <Link to={`/orders/${order.id}`} className="-mx-2 block min-h-11 rounded-lg px-2 py-2 text-sm hover:bg-surface-hover active:bg-surface-selected">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-ink-body">{order.supplier?.name ?? '—'}</span>
                            <span className="num text-xs text-ink-muted">#{order.number}</span>
                            <StatusBadge meta={PO_STATUS[order.status]} />
                          </div>
                          {order.items.length > 0 && (
                            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-muted">
                              {order.items.map((item, index) => (
                                <span key={index}><bdi>{item.product ? productLabel(item.product) : '—'}</bdi> <span className="num">×{item.qty}</span></span>
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
      )}
    </Card>
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
  const { t } = useT();
  return (
    <div role="status" aria-busy="true" className="dashboard-depth">
      <span className="sr-only">{t('dashboard.text_18')}</span>

      {/* header: page title + freshness stamp */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-24" />
      </div>

      {/* Keep the loading geometry in the same responsive shape as settled content (T7 grid):
          hero money strip first, then attention / deliveries / dark queue tiles, then charts. */}
      <div className="mt-5 flex flex-col gap-5 lg:grid lg:grid-cols-12 lg:gap-6">

      {/* hero money strip: three separate stat cards (T7.3c) */}
      <div className="order-first grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4 lg:order-1 lg:col-span-12">
        {Array.from({ length: 3 }, (_, i) => (
          <Card key={i} pad={false} className="min-h-24 px-4 py-3.5 sm:px-5">
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded" />
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="mt-2 flex items-end justify-between gap-3">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </Card>
        ))}
      </div>

      {/* AttentionZone card: header + dense rows (badge · label · amount) */}
      <Card className="order-2 lg:col-span-6">
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
      </Card>

      {/* deliveries card: heading + the two-count summary row */}
      <Card className="order-3 lg:col-span-3">
        <Skeleton className="h-5 w-40" />
        <div className="mt-2 flex min-h-11 items-center gap-6 py-3">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-6 w-20" />
          <Skeleton className="ms-auto h-4 w-4" />
        </div>
      </Card>

      {/* the dark role-queue tile — promised quiet (sunken), not dark, while loading */}
      <div className="order-4 rounded-3xl bg-surface-sunken p-4 sm:p-5 lg:col-span-3">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="mt-2 h-8 w-16" />
        <div className="mt-3 space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex min-h-9 items-center justify-between gap-3">
              <Skeleton className={`h-3.5 ${['w-44', 'w-36', 'w-40', 'w-32'][i]}`} />
              <Skeleton className="h-5 w-8 rounded-full" />
            </div>
          ))}
        </div>
      </div>

      {/* trends board: heading + four chart cards (bar 5 / donut 4 / ring 3 / comparison 12) */}
      <div className="order-5 lg:col-span-12">
        <Skeleton className="h-5 w-24" />
        <div className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-12 lg:gap-6">
          <Card className="lg:col-span-5">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="mt-3 h-48 w-full rounded-lg" />
          </Card>
          <Card className="lg:col-span-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mx-auto mt-4 size-36 rounded-full" />
            <div className="mx-auto mt-3 flex justify-center gap-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-16" />
            </div>
          </Card>
          <Card className="lg:col-span-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mx-auto mt-4 size-28 rounded-full" />
            <Skeleton className="mx-auto mt-3 h-3 w-28" />
          </Card>
          <Card className="lg:col-span-12">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="mt-3 h-48 w-full rounded-lg" />
          </Card>
        </div>
      </div>

      {/* operational snapshot: heading + one card of folded rows */}
      <div className="order-6 lg:col-span-12">
        <Skeleton className="h-5 w-44" />
        <Card className="mt-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex min-h-11 items-center gap-3 border-t border-line-soft first:border-t-0">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-6 w-8 rounded-full" />
              <Skeleton className="ms-auto h-3 w-28" />
            </div>
          ))}
        </Card>
      </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { statusLabel, t, locale } = useT();
  const { profile, org } = useAuth();
  const baseCurrency = org?.base_currency ?? null;
  /* The tier mark on the greeting line is owner-only, and the gate is repeated HERE rather than
     left to `PlanBadge`'s own: the component renders null for everyone else, but the line that
     holds it must not exist at all for them — a truthy `meta` node that renders nothing still
     draws an empty band under the heading. */
  const isOwner = profile?.role === 'owner';

  /* WHICH currency the control centre is reading, and `null` for "whatever the organisation keeps
     its books in". Null rather than `baseCurrency` on purpose: the organisation row can still be
     loading when this state is created, and storing the answer to a question that has not been
     answered yet would pin the picker to a stale currency for the rest of the session. The
     resolution happens below, once, against the currencies the data actually came back with. */
  const [pickedCurrency, setPickedCurrency] = useState<string | null>(null);
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
      reqItemsRes, offersRes, deliveriesRes, snapshotRes, supplierCountRes, supplierBalanceRes,
    ] = await Promise.all([
      // recent orders (8 weeks) — purchased today/week/month + the weekly series. created_at is the
      // time axis, non-draft/cancelled the filter, at snapshot prices (OPEN-DECISIONS #4, locked).
      fetchAll((from, to) => supabase.from('purchase_orders').select('id, created_at, status, currency, items:purchase_order_items(qty, unit_price)').gte('created_at', trendFromTimestamp).lte('created_at', now.toISOString()).not('status', 'in', '(draft,cancelled)').order('created_at').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('invoices').select('id, supplier_id, invoice_date, received_date, total_amount, currency, review_status, payment_status, export_status').eq('financial_role', 'payable').is('deleted_at', null).gte('invoice_date', chartsFrom).order('invoice_date').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('payments').select('id, amount, currency, paid_date').gte('paid_date', trendFromISO).lte('paid_date', todayISO).order('paid_date').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('exceptions').select('*, supplier:suppliers(name)').in('status', ['open', 'in_progress']).order('created_at', { ascending: false }).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('purchase_order_items').select('id, qty, unit_price, product:products(category:categories(name)), order:purchase_orders!inner(created_at, status, currency)').gte('order.created_at', chartsFromTimestamp).lte('order.created_at', now.toISOString()).not('order.status', 'in', '(draft,cancelled)').order('id').range(from, to)),
      // price increases — now bounded to the last 30 days (was a full unbounded scan): matches the
      // "מוצרים שהתייקרו לאחרונה" label and the alerts window (OPEN-DECISIONS #26).
      fetchAll((from, to) => supabase.from('supplier_products').select('id, current_price, previous_price, currency, price_effective_date, product:products(id, name, display_name), supplier:suppliers(name)').gte('price_effective_date', last30dISO).not('previous_price', 'is', null).order('price_effective_date', { ascending: false }).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('purchase_request_items').select('id, qty, unit_price, product_id, request:purchase_requests!inner(created_at, status, currency)').gte('request.created_at', monthStartTimestamp).lte('request.created_at', now.toISOString()).eq('request.status', 'split').order('id').range(from, to)),
      // available offers for the savings estimate — kept minimal (2 cols) but cannot be date-bounded:
      // savings needs the max CURRENT available offer per product regardless of when it was set.
      fetchAll((from, to) => supabase.from('supplier_products').select('id, product_id, current_price, currency').eq('available', true).order('id').range(from, to)),
      // deliveries due today/tomorrow — open POs (sent/confirmed/partial) whose expected_date is
      // today or tomorrow (OPEN-DECISIONS: a delivery = open order + expected_date). NULL
      // expected_date rows are excluded by the gte and surfaced as a count from openPos instead.
      fetchAll((from, to) => supabase.from('purchase_orders').select('id, number, status, expected_date, supplier_id, supplier:suppliers(name), items:purchase_order_items(qty, product:products(name, display_name))').in('status', ['sent', 'confirmed', 'partial']).gte('expected_date', todayISO).lte('expected_date', tomorrowISO).order('expected_date').order('id').range(from, to)),
      supabase.rpc('management_dashboard_snapshot', { p_today: todayISO }),
      // First run or a working business? Zero suppliers is the honest test: no order, invoice,
      // price or receipt can exist without one, and the setup wizard itself puts suppliers before
      // products. Deriving emptiness from "all KPIs are zero" would also flag a real business in
      // a quiet month. HEAD + exact count — no rows cross the wire, and it rides the same
      // Promise.all, so it costs no extra round trip.
      supabase.from('suppliers').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      /* Who is owed money, and in WHICH currency. The snapshot already carries a supplier count,
         but it is one number for the whole business ("a supplier owed in two currencies is ONE
         supplier who needs attention" -- 0218), and it caps its supplier LIST at six per currency.
         Neither can answer "how many suppliers are owed in the currency on screen", so the picker
         would otherwise print the organisation's whole count above a single currency's list.
         Two columns, no names and no amounts: this is counted, never rendered. The view is the
         one the client is meant to read -- `security_invoker`, so RLS scopes it to this org. */
      fetchAll((from, to) => supabase.from('supplier_balances_by_currency').select('supplier_id, currency').gt('open_balance_in_currency', 0).order('supplier_id').order('currency').range(from, to)),
    ]);

    const orders = ordersRes as unknown as { created_at: string; currency: string; items: { qty: number; unit_price: number }[] }[];
    const invoices = invoicesRes as unknown as { supplier_id: string; invoice_date: string; received_date: string; total_amount: number; currency: string; review_status: string; payment_status: string; export_status: string }[];
    const payments = paymentsRes as unknown as { amount: number; currency: string; paid_date: string }[];
    const exceptions = exceptionsRes as unknown as ({ id: string; type: string; severity: 'low' | 'medium' | 'high'; title: string; created_at: string; supplier: { name: string } | null })[];
    const poItems = poItemsRes as unknown as { qty: number; unit_price: number; product: { category: { name: string } | null } | null; order: { created_at: string; currency: string } }[];
    const priceRows = priceUpRes as unknown as { current_price: number; previous_price: number | null; currency: string; price_effective_date: string; product: { id: string; name: string; display_name: string | null }; supplier: { name: string } }[];
    const reqItems = reqItemsRes as unknown as { qty: number; unit_price: number | null; product_id: string; request: { currency: string } }[];
    const offers = offersRes as unknown as { product_id: string; current_price: number; currency: string }[];
    const deliveries = deliveriesRes as unknown as DeliveryOrder[];
    const supplierBalanceRows = supplierBalanceRes as unknown as { supplier_id: string; currency: string }[];
    const snapshot = unwrap(snapshotRes) as ManagementDashboardSnapshot | null;
    if (!snapshot) throw new Error('dashboard_snapshot_unavailable');

    const orderValue = (o: { items: { qty: number; unit_price: number }[] }) => o.items.reduce((s, i) => s + i.qty * i.unit_price, 0);

    /* ── what does NOT change with the currency being read, hoisted above the per-currency view so
       one read serves every currency and the outer result too. Counts of documents, bank matches
       and exceptions are counts of things, not sums of money: they answer "how many are waiting"
       and carry no unit to be wrong about. The per-currency LISTS are here for the same reason —
       the list is the same list whichever entry of it is being read. */
    const { openBalanceByCurrency } = snapshot.money;

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

    const openCreditsByCurrency = snapshot.credits.sumByCurrency;

    const committedByCurrency = snapshot.openOrders.committedByCurrency;
    const remainingByCurrency = snapshot.openOrders.remainingByCurrency;
    const lateDeliveries = snapshot.openOrders.late;
    const awaitingConfirmation = snapshot.openOrders.awaitingConfirmation;

    // supplier open balances — id is KEPT so each row can link to /suppliers/:id (was dropped).
    const topBalancesByCurrency = snapshot.topBalancesByCurrency;

    // ── money strip (context). Every value is `number | null`: null when its source set is
    // empty, so an empty org shows "—", never a fake "0" (CLAUDE.md:31,37). A measured 0 (there
    // ARE rows this period, they just sum to 0) is legitimate and kept as a number.
    /* THE ONE RULE FOR EVERY FIGURE THIS SCREEN COMPUTES ITSELF (0217, #277).
       A month-over-month delta, a category mix, a savings percentage and a bar width are all
       ratios, and a ratio across two currencies is not an approximation of anything. So every
       aggregate below is taken inside ONE currency.

       WHICH one is the reader's choice now, not a constant. `#277` had this screen render each
       currency as its own line wherever a figure was glanced at, which meant a business holding
       shekels and dollars read two figures everywhere and could compare neither with anything.
       The owner's ruling (`#301`, 30.08.2026) is that the control centre shows ONE currency at a time and
       the reader picks it. That is the only reading of "one currency" that neither converts (there
       is no rate source, and CLAUDE.md forbids inventing one) nor hides (every currency the
       business holds is one click away, and the picker names them all).

       So this is a FUNCTION of the currency, called once per currency the business holds, over
       rows that were fetched exactly once. Switching currency re-reads a computed view; it does
       not re-query. Every figure inside is in `viewCurrency` or it is not here at all. */
    const currencyView = (viewCurrency: string) => {
    const inView = <T extends { currency: string }>(rows: readonly T[]) =>
      rows.filter((row) => row.currency === viewCurrency);

    const ordersThisMonth = inView(orders).filter((o) => {
      const date = localDateKey(o.created_at);
      return date >= monthStart && date <= todayISO;
    });
    const paymentsThisMonth = inView(payments).filter((p) => {
      const date = localDateKey(p.paid_date);
      return date >= monthStart && date <= todayISO;
    });
    const purchasedMonth = ordersThisMonth.length ? ordersThisMonth.reduce((s, o) => s + orderValue(o), 0) : null;
    const paidMonth = paymentsThisMonth.length ? paymentsThisMonth.reduce((s, p) => s + p.amount, 0) : null;

    // ── estimated savings this month: chosen price vs the most expensive available offer.
    // The dearest AVAILABLE offer, inside the base currency: "we could have paid X and paid Y"
    // is a comparison, and a comparison needs one unit.
    const maxOffer = new Map<string, number>();
    for (const o of inView(offers)) maxOffer.set(o.product_id, Math.max(maxOffer.get(o.product_id) ?? 0, o.current_price));
    const viewReqItems = reqItems.filter((it) => it.request.currency === viewCurrency);
    const savings = viewReqItems.length ? viewReqItems.reduce((s, it) => {
      if (it.unit_price == null) return s;
      const max = maxOffer.get(it.product_id) ?? it.unit_price;
      return s + Math.max(0, (max - it.unit_price) * it.qty);
    }, 0) : null;
    // savings as a % of the worst-case (most-expensive-offer) basket, so the ₪ figure has a scale.
    const savingsBaseline = viewReqItems.reduce((s, it) => {
      if (it.unit_price == null) return s;
      return s + (maxOffer.get(it.product_id) ?? it.unit_price) * it.qty;
    }, 0);
    const savingsPct = savings != null && savingsBaseline > 0 ? (savings / savingsBaseline) * 100 : null;

    // ── price increases (from the 30-day set). The attention metric is SUPPLIERS, not products.
    const priceIncreases = inView(priceRows)
      .filter((r) => r.previous_price != null && r.current_price > r.previous_price)
      .map((r) => ({ ...r, pct: ((r.current_price - r.previous_price!) / r.previous_price!) * 100 }))
      .sort((a, b) => b.pct - a.pct);
    const priceIncreaseSuppliers = new Set(priceIncreases.map((r) => r.supplier.name)).size;

    // ── monthly expense chart (invoices by calendar month) + MoM change. Calendar buckets stay
    // consecutive even when a month has no invoices; an entirely empty source stays empty.
    const byMonth = new Map<string, { total: number; count: number }>();
    for (const inv of inView(invoices)) {
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
      return { key, month: fmtMonth(`${key}-01`, locale), total, count: bucket.count, label: bucket.count ? moneyFor(viewCurrency)(total) : '' };
    });
    const monthly = invoices.length ? monthBuckets.map(({ month, total, count, label }) => ({ month, total, count, label })) : [];
    const curMonthBucket = byMonth.get(monthKey);
    const prevMonthBucket = byMonth.get(prevMonthKey);
    /* The third copy of the same arithmetic, now the third caller of the same primitive. Two
       whole months here, so `partial` is false and the labels are month names. */
    const monthComparison = {
      previous: prevMonthBucket ? prevMonthBucket.total : null,
      basis: {
        currentLabel: fmtMonth(`${monthKey}-01`, locale),
        previousLabel: fmtMonth(`${prevMonthKey}-01`, locale),
        partial: false,
        sourceLabel: t('comparison.sourceInvoices'),
        unit: 'money' as const,
        currency: viewCurrency,
      },
    };
    // The bar card's two header cells (reference anatomy). null = the month has no invoices — the
    // cell simply doesn't render; no fake 0.
    const headline = {
      current: curMonthBucket ? curMonthBucket.total : null,
      previous: prevMonthBucket ? prevMonthBucket.total : null,
    };

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
      return buckets.map(({ week, total, count }) => ({ week, total, count, label: count ? moneyShortFor(viewCurrency)(total) : '' }));
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
    /* The two periods, named rather than described. "Against the same days last month" states a
       relationship; a reader on the 17th cannot tell from it whether the baseline is a whole month
       or the same seventeen days. `1–17.8` and `1–17.7` can be checked. */
    const dayRangeLabel = (fromISO: string, toISO: string) =>
      `${Number(fromISO.slice(8, 10))}–${Number(toISO.slice(8, 10))}.${Number(toISO.slice(5, 7))}`;
    const currentMtdLabel = dayRangeLabel(monthStart, todayISO);
    const previousMtdLabel = dayRangeLabel(prevMonthStartISO, previousCutoffISO);
    /* Partial by construction: the month is still running, which is exactly why the baseline was
       cut to the same day count. A finished month would compare whole to whole. */
    const mtdBasis = (sourceLabel: string) => ({
      currentLabel: currentMtdLabel,
      previousLabel: previousMtdLabel,
      partial: true,
      sourceLabel,
      unit: 'money' as const,
      currency: viewCurrency,
    });

    // ── by category (PO items, current month) — kept but demoted.
    const byCat = new Map<string, number>();
    for (const it of poItems) {
      if (it.order.currency !== viewCurrency) continue;
      const orderDate = localDateKey(it.order.created_at);
      if (orderDate < monthStart || orderDate > todayISO) continue;
      const cat = it.product?.category?.name ?? t('dashboard.text_19');
      byCat.set(cat, (byCat.get(cat) ?? 0) + it.qty * it.unit_price);
    }
    const categories = topCategoriesWithOther([...byCat.entries()].map(([name, total]) => ({ name, total })))
      .map((category) => ({ ...category, label: moneyShortFor(viewCurrency)(category.total) }));

    /* Supplier open balances for the currency being read, and NOTHING when it holds none. The old
       `?? topBalancesByCurrency[0]?.rows` fallback belonged to a screen with no picker: it quietly
       served some other currency's suppliers under this currency's heading. With a picker that is
       a lie the reader can now catch — an empty list under "USD" is the true answer. */
    const topBalances = topBalancesByCurrency.find((group) => group.currency === viewCurrency)?.rows ?? [];
    /* DISTINCT suppliers owed in this currency -- the count above the list, so the two agree. The
       list itself is still the six largest; the count says how many there are. */
    const openSupplierCount = new Set(
      supplierBalanceRows.filter((row) => row.currency === viewCurrency).map((row) => row.supplier_id),
    ).size;

    /* The money an attention row carries, narrowed to the currency being read. `MoneyByCurrency`
       still draws it, and still refuses to total anything — it is simply handed one entry now
       instead of all of them, so the row shows one figure and the picker decides which. A row
       whose currency holds nothing keeps its COUNT and drops its amount to `—`: there really are
       that many open credits, and none of them are in this currency. */
    const remainingInView = remainingByCurrency.find((entry) => entry.currency === viewCurrency) ?? null;
    const amountsIn = (entries: MoneyAmount[] | null | undefined) => {
      const entry = entries?.find((row) => row.currency === viewCurrency);
      return entry ? [entry] : null;
    };

    // ── "דורש טיפול היום", ordered by business importance.
    // Tones use section 6's semantic vocabulary: await=ממתין · alert=דחוף · info=מידע · idle=ניטרלי.
    const attention: AttentionItem[] = [
      { key: 'inv-approval', label: t('dashboard.text_20'), count: invoicesPendingApproval, tone: 'await', to: '/invoices?review=pending_approval', clearLabel: t('dashboard.text_21') },
      { key: 'pr-approval', label: t('dashboard.text_22'), count: prPendingApproval, tone: 'await', to: '/payment-requests?status=pending_approval', clearLabel: t('dashboard.text_23') },
      { key: 'pay-overdue', label: t('dashboard.text_24'), count: paymentsOverdue, tone: 'alert', to: '/payment-requests?due=overdue', hint: paymentsOverdue == null ? t('dashboard.text_25') : undefined, clearLabel: t('dashboard.text_26') },
      { key: 'pay-today', label: t('dashboard.text_27'), count: paymentsDueToday, tone: 'await', to: '/payment-requests?due=today', hint: paymentsDueToday == null ? t('dashboard.text_28') : undefined, clearLabel: t('dashboard.text_29') },
      { key: 'exceptions', label: t('dashboard.openExceptions'), count: exceptions.length, tone: 'alert', to: '/exceptions?status=open', hint: highExceptions ? t('dashboard.highSeverity', { count: highExceptions }) : undefined, clearLabel: t('dashboard.noOpenExceptions') },
      { key: 'credits', label: t('dashboard.text_30'), count: snapshot.credits.count, amounts: amountsIn(openCreditsByCurrency), tone: 'info', to: '/credits?status=active', clearLabel: t('dashboard.text_31') },
      { key: 'commitments', label: t('dashboard.openCommitments'), count: snapshot.openOrders.count, amounts: amountsIn(committedByCurrency), tone: 'idle', to: '/orders?status=open', hint: remainingInView != null && remainingInView.amount > 0 ? t('dashboard.remainingToReceive', { amount: fmtMoneyRounded(remainingInView.amount, remainingInView.currency) }) : undefined, clearLabel: t('dashboard.noOpenCommitments') },
      { key: 'late-delivery', label: t('dashboard.text_32'), count: lateDeliveries, tone: 'alert', to: '/receiving', clearLabel: t('dashboard.text_33') },
      { key: 'awaiting-confirmation', label: t('dashboard.text_34'), count: awaitingConfirmation, tone: 'await', to: '/orders?status=sent', clearLabel: t('dashboard.text_35') },
      { key: 'price-increases', label: t('dashboard.text_36'), count: priceIncreaseSuppliers, tone: 'await', to: '/prices?increases=1', clearLabel: t('dashboard.text_37') },
    ];

    /* The open balance is read out of the per-currency list rather than summed from it. ABSENT is
       not ZERO: the RPC groups every invoice row by its currency, so a currency that holds
       invoices appears here even when they are all settled (amount 0, a measured fact). A
       currency missing from the list has no invoices at all, which is not a claim that nothing is
       owed in it — that is `null`, and the tile draws "—" (CLAUDE.md:37). The per-currency
       `invoiceCount` rides along, so the context line counts THIS currency's invoices and not the
       organisation's whole ledger. */
    const balanceEntry = openBalanceByCurrency?.find((entry) => entry.currency === viewCurrency) ?? null;

    return {
      attention,
      money: {
        openBalance: balanceEntry ? balanceEntry.amount : null,
        openInvoiceCount: balanceEntry ? balanceEntry.invoiceCount : 0,
        paidMonth, purchasedMonth, monthKey,
        paidComparison: { previous: paidPreviousMTD, basis: mtdBasis(t('comparison.sourcePayments')) },
        purchasedComparison: { previous: purchasedPreviousMTD, basis: mtdBasis(t('comparison.sourceOrdersSent')) },
      },
      monthly, weekly, paidWeekly, monthComparison, headline, categories, savings, savingsPct,
      priceIncreases: priceIncreases.slice(0, 6),
      priceIncreaseCount: priceIncreases.length,
      topBalances,
      openSupplierCount,
      // The week's obligations (0148). The RPC guards all four figures behind the same "at least
      // one active request carries a due date" condition, so they are known together or unknown
      // together — folding them into ONE nullable object says that in the type, instead of asking
      // the tile to re-derive the same guard four times and risk printing ₪0 next to a "—".
      dueWindow: (() => {
        const pr = snapshot.paymentRequests;
        if (pr.overdueAmountByCurrency == null || pr.dueWithin7AmountByCurrency == null
          || pr.overdue == null || pr.dueWithin7Count == null) return null;
        // The tile draws a SPLIT BAR from these two, so they have to be in one currency for the
        // ratio to mean anything. It is the currency being read; the lists ride along so the tile
        // can name what it did not include.
        return {
          overdueAmount: inBaseCurrency(pr.overdueAmountByCurrency, viewCurrency),
          overdueAmountByCurrency: pr.overdueAmountByCurrency,
          overdueCount: pr.overdue,
          dueWithin7Amount: inBaseCurrency(pr.dueWithin7AmountByCurrency, viewCurrency),
          dueWithin7AmountByCurrency: pr.dueWithin7AmountByCurrency,
          dueWithin7Count: pr.dueWithin7Count,
          otherCurrencies: [...new Set([
            ...currenciesBeside(pr.overdueAmountByCurrency, viewCurrency),
            ...currenciesBeside(pr.dueWithin7AmountByCurrency, viewCurrency),
          ])].sort(),
        };
      })(),
    };
    };

    /* Every currency this business actually holds, its own first and the rest by ISO code — the
       picker's tabs, and the only currencies a view is built for.

       Two sources, because neither alone is the business. The fetched rows are time-bounded (three
       months of invoices, eight weeks of orders), so a currency whose last movement is older shows
       up only in the snapshot's balances, credits and commitments — money still owed today. The
       organisation's own currency is always a tab even when nothing has moved in it, because it is
       the currency the books are kept in and an empty tab is a true statement about it. */
    const currencies = [...new Set([
      ...(baseCurrency ? [baseCurrency] : []),
      ...[
        ...orders.map((o) => o.currency),
        ...invoices.map((i) => i.currency),
        ...payments.map((p) => p.currency),
        ...(openBalanceByCurrency ?? []).map((entry) => entry.currency),
        ...(openCreditsByCurrency ?? []).map((entry) => entry.currency),
        ...(committedByCurrency ?? []).map((entry) => entry.currency),
        ...snapshot.topBalancesByCurrency.map((group) => group.currency),
      ].filter((currency) => currency !== baseCurrency).sort(),
    ])];

    return {
      fetchedAt: new Date(),   // query-completion time → drives the "עודכן ב-" stamp
      firstRun: (supplierCountRes.count ?? 0) === 0,
      // אספקות היום ומחר — split by day here so the card only renders. noDateCount comes from
      // openPos (already fetched): open orders that carry no expected_date at all.
      deliveries: {
        today: deliveries.filter((d) => d.expected_date === todayISO),
        tomorrow: deliveries.filter((d) => d.expected_date === tomorrowISO),
        noDateCount: snapshot.openOrders.noDate,
      },
      currencies,
      /* One entry per currency, all of them built from the same fetch at the same instant, so the
         picker switches between two readings of one moment rather than between two moments. */
      byCurrency: Object.fromEntries(currencies.map((currency) => [currency, currencyView(currency)])),
      topBalancesByCurrency,
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

  /* Resolving the picker: the reader's choice if it is still one of the currencies this business
     holds, otherwise the organisation's own, otherwise the first there is. The middle step is what
     keeps a stale choice from emptying the screen — a currency can leave the list between two
     reads (its last open invoice was paid), and a dashboard that answers "—" to everything because
     it is reading a currency the business no longer holds is a worse answer than falling back. */
  const currencies = data?.currencies ?? [];
  const viewCurrency = pickedCurrency != null && currencies.includes(pickedCurrency) ? pickedCurrency
    : baseCurrency != null && currencies.includes(baseCurrency) ? baseCurrency
      : currencies[0] ?? null;
  /* Every figure below that carries money comes from HERE, not from `data`. `data` keeps only what
     has no currency — counts, deliveries, the role queue — so the two can never drift apart. */
  const view = data != null && viewCurrency != null ? data.byCurrency[viewCurrency] ?? null : null;

  // T7.1 greeting-as-title (reference layout): time-of-day + first name. The screen NAME stays
  // "מרכז הבקרה" — in the meta line here and, via routePresentation, in navigation and the
  // browser title — so the greeting never desyncs the wayfinding catalogue. full_name can be ''
  // during offline bootstrap; a nameless greeting falls back to the plain screen name.
  const businessHour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: BUSINESS_TIME_ZONE }).format(new Date()));
  const dayGreeting = businessHour < 5 ? t('dashboard.text_38') : businessHour < 12 ? t('dashboard.text_39') : businessHour < 18 ? t('dashboard.text_40') : t('dashboard.text_41');
  const firstName = profile?.full_name?.trim().split(/\s+/)[0] ?? '';
  const pageTitle = firstName ? t('dashboard.greetingWithName', { greeting: dayGreeting, name: firstName }) : t('dashboard.controlCentre');
  const taskTotal = data ? Object.values(data.queue).reduce((sum, count) => sum + count, 0) : 0;
  const weeklyComparison = (() => {
    if (!view) return [];
    const rows = mergeWeeklyComparison(view.weekly, view.paidWeekly);
    // Trim the measured-zero TAIL to one week: a long flat run after the last activity is honest
    // but tells nothing — one trailing zero says "and then it stopped", the rest is dead ink.
    const lastActive = Math.max(
      view.weekly.reduce((last, point, i) => (point.count > 0 ? i : last), -1),
      view.paidWeekly.reduce((last, point, i) => (point.count > 0 ? i : last), -1),
    );
    return lastActive >= 0 ? rows.slice(0, Math.min(rows.length, lastActive + 2)) : rows;
  })();
  // Zero-policy guard: continuous zero lines are real only when the window holds SOME activity.
  const weeklyHasActivity = view
    ? view.weekly.some((point) => point.count > 0) || view.paidWeekly.some((point) => point.count > 0)
    : false;
  const categoryTotal = view?.categories.reduce((sum, category) => sum + category.total, 0) ?? 0;
  // The due-window tile's split bar divides by this, so it is computed once here and guarded
  // once at the call site: a window that holds requests but no money is a real state (all-zero
  // amounts), and dividing by it would paint NaN% into two inline widths.
  // Both halves are the organisation's own currency, or the bar is not drawn at all: a width
  // computed from a shekel numerator over a shekel-plus-dollar denominator is a picture of nothing.
  const dueSplitTotal = view?.dueWindow && view.dueWindow.overdueAmount != null && view.dueWindow.dueWithin7Amount != null
    ? view.dueWindow.overdueAmount + view.dueWindow.dueWithin7Amount
    : 0;
  /* The supplier rows in view are the ones filed under the currency being read, so that currency
     IS their unit — no search for it. It used to be recovered by matching the row array back to
     its group, which was the only way to name the unit while the screen picked the group itself. */
  const topBalancesCurrency = viewCurrency;
  const monthlyAria = view ? t('dashboard.monthlyAria', {
    points: view.monthly.length
      ? view.monthly.map((point) => `${point.month} ${point.count ? fmtMoneyExact(point.total, viewCurrency) : t('dashboard.noInvoices')}`).join(', ')
      : t('dashboard.noInvoiceDataForPeriod'),
  }) : '';
  const weeklyAria = t('dashboard.weeklyAria', {
    points: weeklyComparison.map((point) => t('dashboard.weeklyAriaPoint', {
      week: point.week,
      purchases: point.purchases == null ? t('dashboard.noRecords') : fmtMoneyExact(point.purchases, viewCurrency),
      payments: point.payments == null ? t('dashboard.noRecords') : fmtMoneyExact(point.payments, viewCurrency),
    })).join('; '),
  });
  const categoryEmptyMessage = view?.categories.length
    ? t('dashboard.categoriesNoPositiveMix', { amount: fmtMoneyExact(categoryTotal, viewCurrency) })
    : t('dashboard.text_42');
  const categoriesAria = view ? t('dashboard.categoriesAria', { points: categoryTotal > 0
    ? view.categories.map((category) => t('dashboard.categoriesAriaPoint', { name: category.name, amount: fmtMoneyExact(category.total, viewCurrency), percent: Math.round((category.total / categoryTotal) * 100) })).join(', ')
    : categoryEmptyMessage }) : '';

  return (
    <div className="dashboard-depth space-y-5">
      {/* No `meta` line. It said "יש היום N סוגי טיפול שדורשים תשומת לב" (or "אין משימות דחופות
          כרגע") roughly 40px above an AttentionZone whose own header says "דורש טיפול היום · N
          סוגי טיפול" and whose own empty state says "אין משימות דחופות כרגע" — the same count and
          the same sentence, twice, in one glance. The one that survives is the one attached to the
          rows it counts. Nothing is lost: both branches are still rendered, by AttentionZone. */}
      {/* THE TIER MARK RIDES THE GREETING (owner, 26.08.2026 — he circled this line and moved it
          here from the shell header, where under the brand pill it floated between the header and
          the page and belonged to neither).
          WHY `meta` AND NOT `actions` OR A NEW `PageHeader` SLOT:
          · `meta` is the line directly UNDER the page title — the same slot the phone gives it,
            where it replaces `InPlace · <org>`. So the two surfaces agree in position, which is
            the whole point of this round.
          · `actions` is the opposite end of the row and already holds a freshness readout and a
            refresh control. A tenant's contract is neither.
          · A `badge` slot on `PageHeader` would put an OWNER-ONLY mark on the primitive every
            screen in the product uses. A slot used once is a slot that invites five more.
          IT DOES NOT REPLACE THE SCREEN NAME, it stands beside it: `'מרכז הבקרה'` on this line is
          what keeps the greeting from desyncing the wayfinding catalogue (see `pageTitle` above),
          and the phone's line was carrying product identity, not a screen name.
          NO GAP FOR ANYONE WHO GETS NOTHING: the whole line is still gated on `firstName`, and the
          chip on `isOwner`, so a non-owner renders the identical string this passed before and an
          owner on a rung with no look renders it too — never an empty 20px band under the heading.
          `compact` drops the 44px action-row touch floor, which on a 20px text line is a 24px hole
          under a heading, and pins the chip's own hit area at 24×24 instead (WCAG 2.5.8 AA). */}
      <div data-tour-anchor="dashboard-heading">
      <PageHeader title={<span className="font-normal">{pageTitle}</span>}
        meta={firstName
          ? <span className="flex flex-wrap items-center gap-2">
            {t('dashboard.text_43')}
            {/* DESKTOP ONLY, and the first build without this printed the chip TWICE on a phone
                dashboard — once on the header's subtitle line and again here, 120px apart. The
                header slot is the PHONE's ruling and it holds on every screen; this line is the
                DESKTOP's, where the shell header carries no tier mark at all. One chip per
                surface. (It still mounts below `lg` and costs one `my_subscription()` call there;
                `PlanBadge` self-gates on the tenant scope, so hiding is the cheap correct fix and
                unmounting would need a viewport hook this screen does not have.) */}
            {isOwner && <span className="hidden lg:inline-flex"><PlanBadge compact /></span>}
          </span>
          : undefined}
        actions={<div className="flex items-center gap-2 text-xs text-ink-muted">
          <span aria-live="polite" aria-atomic="true">
            {data?.fetchedAt && (
              <span key={data.fetchedAt.getTime()} className="freshness-settle">
                {t('dashboard.updatedAt')} <span className="num">{timeFmt.format(data.fetchedAt)}</span>
              </span>
            )}
          </span>
          <button className="btn-ghost btn-icon" onClick={() => void refetch()} disabled={fetching}
            aria-label={t('dashboard.aria_label_2')} title={t('dashboard.title_2')}>
              <RefreshCw size={ICON.sm} aria-hidden="true" className={fetching ? 'animate-spin ' : ''} />
          </button>
        </div>} />
      </div>

      {/* The capsule strip lived here briefly (T7.3) and was removed by owner decision
          ("לא רלוונטי") — the money strip and the due-window tile already carry the day's figures. */}

      {/* Truth-reporting (CLAUDE.md): a failed load/refetch shows an inline note WITH retry and keeps
          whatever data we still hold on screen — it never blanks the sections that did load. */}
      {error && (
        <Note tone="alert" className="flex items-center justify-between gap-3">
          <span>{error}</span>
          <button className="btn-ghost min-h-11 shrink-0 whitespace-nowrap" onClick={() => void refetch()}>{t('dashboard.refetch')}</button>
        </Note>
      )}

      {/* First run. The setup wizard has always existed, but its only doors were the account menu
          and Settings — where a person looks for settings, not for "how do I start". A brand-new
          owner used to land on an empty control centre with nothing telling them why it is empty
          or what to do next. Owner only: /onboarding is Guard roles={['owner']}, so office must
          not see a link it cannot open. It sits OUTSIDE the .dash-enter grid on purpose — the
          quality gate pins the heading order inside it. */}
      {data?.firstRun && profile?.role === 'owner' && (
        <div data-tour-first-run="true">
        <Note tone="info" className="flex flex-wrap items-center justify-between gap-3">
          <span className="min-w-0 flex-1">
            {t('dashboard.text_44')}{' '}
            {t('dashboard.text_45')}
          </span>
          <Link to="/onboarding" className="btn-primary min-h-11 shrink-0 whitespace-nowrap">{t('dashboard.text_46')}</Link>
        </Note>
        </div>
      )}

      {/* flex, not space-y: `order` below only moves flex/grid children, and margins cannot be
          reordered at all. Each zone declares its own entrance step for both viewports — see the
          `--dash-step` rules in index.css — because below lg the money band moves to the top and
          DOM position stops describing what the eye sees. */}
      {/* T7 Crextio-reference grid: below lg this is still one calm column (money first); from
          lg up it becomes the reference division — hero money strip across the top, then the
          attention card beside the deliveries card beside the dark role-queue card, then the
          trend cards. DOM order is unchanged on purpose — the quality gate pins the heading
          order (attention h2 first, deliveries h2 second), so placement is CSS `order` only. */}
      {data && view && (
        <div className="dash-enter flex flex-col gap-5 lg:grid lg:grid-cols-12 lg:gap-6">
          <div data-tour-anchor="dashboard-attention"
            className="lg:order-2 lg:col-span-6 [--dash-step-mobile:1] [--dash-step:1]">
            <AttentionZone items={view.attention} totalLabel={t('dashboard.totalLabel')} baseCurrency={viewCurrency} />
          </div>

          <DeliveriesZone today={data.deliveries.today} tomorrow={data.deliveries.tomorrow} noDateCount={data.deliveries.noDateCount}
            className="lg:order-3 lg:col-span-3 [--dash-step-mobile:2] [--dash-step:2]" />

          {/* Section 12 on a phone: the manager opens the app and sees a figure. The strip is
              FIRST on screen below lg; from lg it is the full-width hero row of the grid.
              T7.3c (owner, mobile report): THREE SEPARATE CARDS — on a phone they stack as three
              tiles, on desktop they sit as the reference's stat-card row. Each BandStat is its
              own card now. */}
          <div className="order-first grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4 lg:order-1 lg:col-span-12 [--dash-step-mobile:0] [--dash-step:0]">
            {/* The open balance used to be the one strip figure drawn as two lines — a supplier
                owed in shekels and another owed in dollars are two debts, and `#277` had the tile
                stack both. It is one figure again, in the currency the picker is on, because the
                owner's ruling is that the reader chooses the unit instead of reading every unit at
                once. Nothing is summed and nothing is converted: the other currency is a click
                away in the picker, holding its own balance and its own invoice count. */}
            {/* `/invoices` takes review/pay/export/month/attention/q/page/sort and no currency,
                so the link does NOT carry one: a query parameter the target silently ignores
                promises a filtered list and delivers every currency's invoices. The tile still
                names its currency in the label; narrowing the list itself needs a currency
                filter on that screen, which is its own change. */}
            <Card as={Link} pad={false} to="/invoices?pay=unpaid"
              aria-label={t('dashboard.openBalanceAria', { currency: viewCurrency ?? '', count: view.money.openInvoiceCount })}
              className="card-link-hover block min-h-24 px-4 py-3.5 sm:px-5">
              <div className="flex items-center gap-2">
                <ReceiptText size={ICON.md} className="shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="text-xs font-medium text-ink-muted">{t('dashboard.title_3')}</span>
              </div>
              <div className="mt-2 kpi-hero num text-await-fg" dir="ltr">
                {glanceMoney(view.money.openBalance, viewCurrency)}
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-ink-muted">
                <span>{t('dashboard.context')}</span>
                <span>{view.money.openBalance == null ? t('dashboard.noDataAvailable') : t('dashboard.openInvoicesCount', { count: view.money.openInvoiceCount })}</span>
              </div>
            </Card>
            <BandStat title={t('dashboard.paidThisMonth')} value={view.money.paidMonth} tone="done" to={`/payments?month=${view.money.monthKey}`}
              icon={Banknote} context={t('dashboard.context_2')} comparison={view.money.paidComparison} currency={viewCurrency}
              spark={view.paidWeekly} sparkLabel={t('dashboard.sparkLabel')} />
            <BandStat title={t('dashboard.title_4')} value={view.money.purchasedMonth} to="/orders?status=all"
              icon={ShoppingCart} context={t('dashboard.context_3')} comparison={view.money.purchasedComparison} currency={viewCurrency}
              aux={view.savings != null
                ? (view.savingsPct != null
                  ? t('dashboard.estimatedSavingWithPct', { amount: fmtMoneyRounded(view.savings, viewCurrency), percent: view.savingsPct.toFixed(0) })
                  : t('dashboard.estimatedSaving', { amount: fmtMoneyRounded(view.savings, viewCurrency) }))
                : undefined}
              spark={view.weekly} sparkLabel={t('dashboard.sparkLabel_2')} />
          </div>
          {data.currencies.length > 1 && (
            /* The picker, and it renders ONLY for a business that holds more than one currency —
               a single-currency organisation has no choice to make and gets no control to read.

               Said once, where the figures are, rather than repeated on every tile: the whole
               screen above and below is in one currency, and this is where it is named and
               changed. Nothing is converted and nothing is hidden — the currencies this business
               holds are all here, each carrying its own balances, credits and commitments.

               `order-1`, WITH the money band it governs, and NOT `order-2`: this row spans all
               twelve columns, so sharing an order group with the six-column attention card leaves
               it nowhere to sit on that row. It would open a row of its own between the attention
               card and the two cards that belong beside it, dropping the deliveries card and the
               role-queue card a full row down and stranding half a row of white space. Ordered
               with the band, it closes the money zone instead of splitting the attention zone. */
            <div className="order-first flex flex-wrap items-center gap-x-3 gap-y-2 lg:order-1 lg:col-span-12">
              <ToggleGroup
                label={t('dashboard.currencyPickerLabel')}
                value={viewCurrency ?? ''}
                onChange={setPickedCurrency}
                items={data.currencies.map((currency) => ({
                  key: currency,
                  label: <span className="num" dir="ltr">{currency}</span>,
                  testId: `dashboard-currency-${currency}`,
                }))}
              />
              <p className="text-xs text-ink-muted">
                {t('dashboard.currencyPickerNote', { currency: viewCurrency ?? '' })}
              </p>
            </div>
          )}

          <RoleQueueCard queue={data.queue} total={taskTotal}
            className="lg:order-4 lg:col-span-3 [--dash-step-mobile:3] [--dash-step:3]" />

          {/* The trends board keeps its three views visible together (DESIGN.md: no tabs), and
              under T7 each view is its own borderless card — the reference's chart tiles. The
              board heading still names the region; separation inside it is card + spacing, not
              hairlines. */}
          <section className="lg:order-5 lg:col-span-12 [--dash-step-mobile:4] [--dash-step:4]" aria-labelledby="trends-title">
            <h2 id="trends-title" className="section-title">{t('dashboard.text_47')}</h2>

            <div className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-12 lg:gap-6">
              <Card as="section" className="lg:col-span-5" aria-labelledby="monthly-trend-title">
                {/* Reference header anatomy (image 3): title at the start, two summary CELLS at the
                    end — this month beside last month, separated by a logical hairline. Both
                    figures come from byMonth, so the monthly claim survives the on-bar labels'
                    removal. The MoM percent used to ride the current-month cell as a bare number;
                    it now sits under the header inside the sentence that names both months, which
                    is the same fact with its baseline attached. */}
                <div className="flex min-h-8 flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div>
                    <h3 id="monthly-trend-title" className="text-sm font-semibold text-ink-body">{t('dashboard.text_48')}</h3>
                    <p className="text-xs text-ink-muted">{t('dashboard.text_49')}</p>
                  </div>
                  {view.headline.current != null && (
                    <div className="flex items-start text-xs">
                      <div className="pe-3 text-end">
                        <div className="text-ink-muted">{t('dashboard.text_50')}</div>
                        <div className="flex items-baseline gap-1.5">
                          <span className="num text-sm font-semibold text-ink">{glanceMoney(view.headline.current, viewCurrency)}</span>
                        </div>
                      </div>
                      {view.headline.previous != null && (
                        <div className="border-s border-line-soft ps-3 text-end">
                          <div className="text-ink-muted">{t('dashboard.text_51')}</div>
                          <div className="num text-sm font-semibold text-ink-mid">{glanceMoney(view.headline.previous, viewCurrency)}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="mt-1">
                  <PeriodComparison current={view.headline.current} previous={view.monthComparison.previous}
                    basis={view.monthComparison.basis} />
                </div>
                {/* teal-mid, not the deep brand hue — the ring beside this card is deep, and two
                    neighboring charts in one color read as one chart (owner, T7.3c). */}
                <SpendBarChart
                  points={view.monthly.map((point) => ({ key: point.month, label: point.label, total: point.total }))}
                  ariaLabel={monthlyAria} emptyMessage={t('dashboard.noInvoiceDataForPeriod')} currency={viewCurrency} />
              </Card>

              <Card as="section" className="lg:col-span-4" aria-labelledby="category-trend-title">
                <h3 id="category-trend-title" className="text-sm font-semibold text-ink-body">{t('dashboard.text_52')}</h3>
                <p className="text-xs text-ink-muted">{t('dashboard.text_53')}</p>
                <CategoryDonut slices={view.categories} total={categoryTotal} currency={viewCurrency} ariaLabel={categoriesAria} emptyMessage={categoryEmptyMessage} />
              </Card>

              {/* Owner review, defect 11: this slot used to hold a radial ring over "כיסוי תאריכי
                  פירעון" — how many active requests carry a due date. That is data hygiene, not a
                  decision: the manager cannot pay a percentage. The tile now answers the question
                  the week actually asks — how much money has to move — and a ring cannot say it.
                  A ring encodes a part of a WHOLE; here the "whole" is a seven-day window we
                  chose, so a percentage of it would be arithmetic about our own choice while
                  hiding the only figure that matters. Two lines under one total instead.
                  The word באיחור carries the meaning; the alert ink only repeats it.
                  25.08.2026 — the tile is no longer text-only. Owner report: with a chart on
                  either side of it, a tile with no graphic at all read as a slot that had failed
                  to render. It gets a two-segment split bar, NOT the ring back: the objection
                  above was never "no graphic", it was "not a percentage of a window we chose". */}
              <Card as="section" className="lg:col-span-3" aria-labelledby="due-window-title">
                <h3 id="due-window-title" className="text-sm font-semibold text-ink-body">{t('dashboard.text_54')}</h3>
                <p className="text-xs text-ink-muted">{t('dashboard.text_55')}</p>
                {view.dueWindow == null ? (
                  <p className="mt-4 flex min-h-24 items-center text-sm text-ink-muted sm:min-h-40">
                    {t('dashboard.text_56')}
                  </p>
                ) : view.dueWindow.overdueAmount == null || view.dueWindow.dueWithin7Amount == null ? (
                  /* Active dated requests exist, but none of them is in the organisation's own
                     currency — so this tile has no figure it may add, and says which currencies
                     the money IS in rather than showing one of them as though it were the total. */
                  <p className="mt-4 flex min-h-24 items-center text-sm text-ink-muted sm:min-h-40">
                    {t('dashboard.dueWindowOtherOnly', { others: view.dueWindow.otherCurrencies.join(', ') })}
                  </p>
                ) : (
                  <div className="mt-2 flex min-h-32 flex-col justify-center gap-4 sm:min-h-40">
                    <div className="kpi-hero num text-ink" dir="ltr">
                      {glanceMoney(view.dueWindow.overdueAmount + (view.dueWindow.dueWithin7Amount ?? 0), viewCurrency)}
                    </div>
                    {view.dueWindow.otherCurrencies.length > 0 && (
                      <p className="text-xs text-ink-muted">
                        {t('dashboard.dueWindowAlsoOther', { others: view.dueWindow.otherCurrencies.join(', ') })}
                      </p>
                    )}
                    {/* The one graphic this tile gets, and the reason it is allowed where the ring
                        was not: THIS part-of-whole has a real whole. The ring divided by a window
                        we chose; this divides the money that has to move into the half that is
                        already late and the half that is not — the same two figures the lines
                        below name, in the proportion the eye reads before it reads a number.
                        Two segments, the split-bar idiom every AP dashboard uses for aging.
                        aria-hidden: the lines below carry both amounts and both counts, and a
                        screen reader gains nothing from hearing the split a third time. */}
                    {dueSplitTotal > 0 && (
                      <div className="split-bar flex h-2 overflow-hidden rounded-full bg-line-soft" aria-hidden="true">
                        <span className="bg-alert-solid" style={{ width: `${((view.dueWindow.overdueAmount ?? 0) / dueSplitTotal) * 100}%` }} />
                        <span className="bg-bar-mid" style={{ width: `${((view.dueWindow.dueWithin7Amount ?? 0) / dueSplitTotal) * 100}%` }} />
                      </div>
                    )}
                    <div className="flex flex-col gap-1.5 text-sm">
                      <p className="text-alert-fg">
                        {t('dashboard.ofWhichOverdue')} <span className="num" dir="ltr">{glanceMoney(view.dueWindow.overdueAmount, viewCurrency)}</span>
                        {' · '}<span className="num">{view.dueWindow.overdueCount}</span> {t('dashboard.requestsWord')}
                      </p>
                      <p className="text-ink-mid">
                        {t('dashboard.dueWithinSevenDays')} <span className="num" dir="ltr">{glanceMoney(view.dueWindow.dueWithin7Amount, viewCurrency)}</span>
                        {' · '}<span className="num">{view.dueWindow.dueWithin7Count}</span> {t('dashboard.requestsWord')}
                      </p>
                    </div>
                    <Link className="link self-start text-sm" to="/payment-requests?due=soon">
                      {t('dashboard.text_57')}
                    </Link>
                  </div>
                )}
              </Card>

              <Card as="section" className="lg:col-span-12" aria-labelledby="weekly-trend-title">
                <h3 id="weekly-trend-title" className="text-sm font-semibold text-ink-body">{t('dashboard.text_58')}</h3>
                <p className="text-xs text-ink-muted">{t('dashboard.text_59')}</p>
                {/* The series names ride the ends of their own lines now — no legend row. The
                    zero policy keeps the lines continuous, so a window with NO activity at all is
                    passed as [] to keep the honest empty state (two flat zero lines are not data). */}
                {/* The pairing lives in comparisonSeries(), not here. It used to be the two system
                    darks (chart-1 + chart-4) told apart by the dash alone — 1.56:1 between the two
                    lines, which is to say the colour contributed nothing and the dash carried the
                    whole distinction. Owner decision 19.08.2026: spend both carriers. */}
                <ComparisonLineChart points={weeklyHasActivity ? weeklyComparison : []} xKey="week"
                  series={comparisonSeries({ key: 'purchases', name: t('dashboard.comparisonSeries') }, { key: 'payments', name: t('dashboard.comparisonSeries_2') })}
                  ariaLabel={weeklyAria} emptyMessage={t('dashboard.emptyMessage_2')} currency={viewCurrency} />
              </Card>
            </div>
          </section>

          {/* Three folded subjects, still one zone under one heading (DESIGN.md: one region named
              "תמונת מצב תפעולית", not separate cards). T7 gives the zone one borderless card so it
              reads as a tile of the reference grid; the role queues left this fold for the dark
              card above, so nothing here is said twice. */}
          <section className="lg:order-6 lg:col-span-12 [--dash-step-mobile:5] [--dash-step:5]" aria-labelledby="operations-title">
            <h2 id="operations-title" className="section-title">{t('dashboard.text_60')}</h2>
            <Card className="mt-3">
              <OperationsDisclosure title={t('dashboard.title_5')} count={data.exceptionCount}
                summary={data.queue.highExceptions ? t('dashboard.highSeverity', { count: data.queue.highExceptions }) : undefined}
                empty={t('dashboard.empty')}>
                <div className="flex justify-end">
                  <Link to="/exceptions?status=open" className="btn-ghost min-h-11 text-xs">{t('dashboard.text_61')} <ChevronLeft size={ICON.xs} aria-hidden="true" /></Link>
                </div>
                <ul className="divide-y divide-line-soft">
                  {data.exceptions.map((exception) => (
                    <li key={exception.id}>
                      <Link to={`/exceptions?id=${exception.id}`} className="block min-h-11 rounded-lg px-2 py-2 text-sm hover:bg-surface-hover active:bg-surface-selected">
                        <div className="flex items-center gap-2">
                          <StatusBadge meta={SEVERITY[exception.severity]} />
                          <span className="text-xs text-ink-muted">{statusLabel(EXCEPTION_TYPE[exception.type])}</span>
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
                        {t('dashboard.suspectedDuplicates')} <span className="num font-medium">{data.meta.suspectedDup}</span>
                      </Link>
                    )}
                    {data.meta.unmatchedBank > 0 && (
                      <Link to="/bank?status=unmatched" className="inline-flex min-h-11 items-center text-ink-muted hover:text-ink-mid active:text-ink">
                        {t('dashboard.unmatchedBank')} <span className="num font-medium">{data.meta.unmatchedBank}</span>
                      </Link>
                    )}
                    {data.meta.suggestedBank > 0 && (
                      <Link to="/bank?status=suggested" className="inline-flex min-h-11 items-center text-ink-muted hover:text-ink-mid active:text-ink">
                        {t('dashboard.suggestedBank')} <span className="num font-medium">{data.meta.suggestedBank}</span>
                      </Link>
                    )}
                  </div>
                )}
              </OperationsDisclosure>

              <OperationsDisclosure title={t('dashboard.title_6')} count={view.priceIncreaseCount}
                summary={view.priceIncreases[0] ? t('dashboard.largestIncrease', { percent: view.priceIncreases[0].pct.toFixed(1) }) : undefined}
                empty={t('dashboard.empty_2')}>
                <div className="flex justify-end">
                  <Link to="/prices?increases=1" className="btn-ghost min-h-11 text-xs">{t('dashboard.text_62')} <ChevronLeft size={ICON.xs} aria-hidden="true" /></Link>
                </div>
                <ul className="divide-y divide-line-soft">
                  {view.priceIncreases.map((price, index) => (
                    <li key={index}>
                      <Link to={`/prices?product=${price.product.id}`} className="flex min-h-11 flex-col items-stretch gap-2 rounded-lg px-2 py-2 text-sm hover:bg-surface-hover active:bg-surface-selected sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        <span className="min-w-0 break-words sm:truncate">
                          <bdi className="font-medium text-ink-body">{productLabel(price.product)}</bdi>
                          <span className="ms-2 text-xs text-ink-muted">{price.supplier.name}</span>
                        </span>
                        <span className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 sm:justify-start">
                          <span className="text-xs text-ink-muted">{t('dashboard.fmtMoneyExact')}<span className="num">{fmtMoneyExact(price.previous_price, price.currency)}</span> {t('dashboard.fmtMoneyExact_2')}<span className="num">{fmtMoneyExact(price.current_price, price.currency)}</span></span>
                          {/* One vocabulary per element: a price that rose is a DIRECTION, so the
                              figure and its arrow both speak trend-*. The span used to be alert-fg
                              with a trend-up arrow inside it — two languages in one number. */}
                          <span className="inline-flex items-center gap-1 font-medium text-trend-up-fg num" dir="ltr">
                            <TrendingUp size={ICON.xs} aria-hidden="true" />+{price.pct.toFixed(1)}%
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </OperationsDisclosure>

              <OperationsDisclosure title={t('dashboard.title_7')} count={view.openSupplierCount}
                summary={view.topBalances[0] ? `${view.topBalances[0].name} · ${fmtMoneyExact(view.topBalances[0].balance, topBalancesCurrency)}` : undefined}
                empty={t('dashboard.empty_3')}>
                <div className="flex justify-end">
                  <Link to="/suppliers?balance=open" className="btn-ghost min-h-11 text-xs">{t('dashboard.text_63')} <ChevronLeft size={ICON.xs} aria-hidden="true" /></Link>
                </div>
                <ul className="divide-y divide-line-soft">
                  {view.topBalances.map((balance) => (
                    <li key={balance.id}>
                      <Link to={`/suppliers/${balance.id}`} className="flex min-h-11 items-center justify-between rounded-lg px-2 py-2 text-sm hover:bg-surface-hover active:bg-surface-selected">
                        <span className="text-ink-mid">{balance.name}</span>
                        <span className="font-semibold text-await-fg num">{fmtMoneyExact(balance.balance, topBalancesCurrency)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </OperationsDisclosure>
            </Card>
          </section>
        </div>
      )}
    </div>
  );
}

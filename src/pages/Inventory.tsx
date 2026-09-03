import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { useMemo, useState } from 'react';
import { reasonOr } from '../lib/reason';
import { useParamState } from '../lib/useParamState';
import { ChevronDown, ClipboardCheck, Minus, Package, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import {
  DataTable,
  Disclosure,
  ErrorNote,
  Modal,
  PageHeader,
  Skeleton,
  SkeletonTable,
  useToast,
  ICON,
  type Column,
} from '../components/ui';
import { ok } from '../lib/errors';
import { QUANTITY_MAX, isQuantityInRange } from '../lib/inputBounds';
import { fmtDate, fmtDateTime, fmtMoneyRounded, fmtNum, formatQuantity, formatUnit } from '../lib/format';
import { supabase } from '../lib/supabase';
import { fetchAll } from '../lib/supabasePaging';
import { useQuery, unwrap } from '../lib/useQuery';

interface InventoryBalance {
  product_id: string;
  product_name: string;
  unit: string;
  min_stock: number | null;
  quantity_on_hand: number | null;
  is_counted: boolean;
  last_counted_at: string | null;
  is_low_stock: boolean | null;
  consumption_sample_count: number | null;
  consumption_quantity: number | null;
  average_daily_consumption: number | null;
  expected_incoming_quantity: number | null;
  incoming_without_date_quantity: number | null;
  next_expected_incoming_date: string | null;
  projected_stockout_days: number | null;
  suggested_reorder_quantity: number | null;
  cheapest_supplier_name: string | null;
  cheapest_unit_price: number | null;
  /** 0223: the currency of the cheapest offer, and null when the offers span more than one. */
  cheapest_currency: string | null;
  /** 0223: true when the product is quoted in two currencies, so there IS no cheapest offer. */
  prices_span_currencies: boolean;
  price_advantage: number | null;
  supplier_price_count: number | null;
  latest_purchase_unit_price: number | null;
  /** 0225: the ORDER's currency, which is what the last purchase was priced in. */
  latest_purchase_currency: string | null;
}

interface InventoryMovement {
  id: string;
  product_id: string;
  product_name: string;
  unit: string;
  movement_type: 'receipt' | 'consumption' | 'adjustment' | 'stocktake' | 'reversal';
  quantity_delta: number;
  counted_quantity: number | null;
  negative_override: boolean;
  reason: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  receipt_id: string | null;
  receipt_number: number | null;
  reverses_movement_id: string | null;
}

type InventoryCommand = 'stocktake' | 'consumption' | 'adjustment';
/**
 * The stock-state filters, one per segment of the band above the table.
 *
 * The empty string is "no filter" — the value `useParamState` returns for an absent parameter —
 * so the URL carries `?stock=low` and nothing at all when the table is unfiltered, rather than a
 * noise parameter spelling out the default. Anything else in the parameter is not a filter this
 * screen knows how to run, so it is dropped back to "no filter": a pasted or stale value must not
 * silently empty the table with no way to tell why.
 */
const BALANCE_FILTERS = ['low', 'counted', 'uncounted'] as const;
/**
 * "מתחת למינימום" has THREE states, and it used to have two.
 *
 * `is_low_stock` is `null` in the view whenever a product has not been counted or carries no
 * minimum — the comparison has no two sides. Counting `=== true` over a set where every row is
 * null gives 0, and the tile printed `0` under the words "דורש בדיקת רכש": a clean sheet, on a
 * business where nothing has ever been counted. That is the reading this page's own header
 * sentence forbids three lines above it — „מוצר שלא נספר מוצג כמקף — יתרה לא ידועה, לא אפס" —
 * and it is how somebody buys a pallet of what they already have.
 *
 * So: a real measured zero when at least one product HAS a verdict and none of them is low;
 * `—` when no product has one, because there was nothing to measure; `—` when the fetch itself
 * failed. An empty catalogue keeps the zero.
 *
 * ── THE EMPTY CATALOGUE, ARGUED (finding 11 of the 03.09.2026 review, which asked for `—`)
 *
 * The em dash marks a question this screen COULD NOT ANSWER. A zero marks one it answered, and
 * the answer is none. Those are different failures and only the first is what `CLAUDE.md` forbids
 * — "אפס הוא גם טענה על המציאות" is a test of whether the claim is TRUE, not of whether the set
 * was big.
 *
 * What made the original defect a lie was not an empty set, it was a THREE-VALUED PREDICATE.
 * `is_low_stock` is null on a product that exists and has never been evaluated, so `=== true`
 * over twelve uncounted products returns 0 while twelve products sit uninspected behind it. The
 * zero conceals a population. Over an empty catalogue there is no concealed population: every
 * member of the set was inspected, because there are none. `|{p ∈ ∅ : low(p)}| = 0` is the same
 * kind of statement as the segment beside it — "0 counted" and "0 awaiting a count" are true
 * measured zeros that nobody disputes, and they are computed over the identical set.
 *
 * This is the rule the rest of the product already applies, not an exception carved for this
 * tile. The dashboard's balance tile: "ABSENT is not ZERO … a currency that holds invoices
 * appears here even when they are all settled (amount 0, a measured fact)" — a ledger that was
 * inspected and summed to nothing is a zero; a currency with no ledger to inspect is a dash.
 * `ToolEnvelope` states it in general: "Zero rows with `complete: true` means measured, and the
 * answer is none." An empty catalogue is a completed measurement returning no rows.
 *
 * The one reading that WOULD make this a false clean sheet is a reader seeing zero rows because
 * rows were withheld rather than absent, and `inventory_balances` does carry such a predicate:
 * `auth_role() = ANY (ARRAY['owner','office'])`. Checked, and it cannot land here — `/inventory`
 * is `STAFF_ROLES`, the same two roles, so the only people who reach this screen are the ones the
 * view answers in full. The other narrowing, `p.active`, excludes archived products, and "none of
 * my ACTIVE products is below its minimum" is the question the table beside it is also answering.
 *
 * What the review was right about is the SENTENCE, not the figure: "0 · דורש בדיקת רכש" is true
 * on an empty catalogue but does not distinguish it from a stocked one that is entirely healthy.
 * The band already varies its sub-line by state, so it says which — the glance surface has to
 * stand on its own, since the whole Wave 7 defect was a glance asserting what the detail below
 * contradicted.
 *
 * The filter follows the figure: `low == null` already leaves the segment unclickable, and a
 * segment that cannot state its count must not promise to filter by it.
 */
export function lowStockCount(
  rows: readonly { is_low_stock: boolean | null }[] | null,
): number | null {
  if (rows == null) return null;
  if (rows.length === 0) return 0;
  if (!rows.some((row) => row.is_low_stock !== null)) return null;
  return rows.filter((row) => row.is_low_stock === true).length;
}

type BalanceFilter = '' | typeof BALANCE_FILTERS[number];

const MOVEMENT_LABEL: Record<InventoryMovement['movement_type'], string> = {
  receipt: 'inventory.text',
  consumption: 'inventory.text_2',
  adjustment: 'inventory.text_3',
  stocktake: 'inventory.text_4',
  reversal: 'inventory.text_5',
};

const COMMAND_COPY: Record<InventoryCommand, { title: string; quantity: string; submit: string }> = {
  stocktake: { title: 'inventory.text_6', quantity: 'inventory.text_7', submit: 'inventory.text_8' },
  consumption: { title: 'inventory.text_9', quantity: 'inventory.text_10', submit: 'inventory.text_11' },
  adjustment: { title: 'inventory.text_12', quantity: 'inventory.text_13', submit: 'inventory.text_14' },
};

/**
 * One segment of the stock-state band.
 *
 * These three counts answer a single question — how measurable is my stock right now — so they
 * live in ONE card as segments with logical dividers, the anatomy DESIGN.md already names for the
 * dashboard money strip, rather than as three separate `KpiCard` boxes that a phone stacks into
 * three separate panels with three borders, three radii and three shadows. Same figures, same
 * `—`-for-unknown rule, same click-to-filter targets, same 44px hit areas.
 *
 * `border-s` / `border-t` only — never `divide-x`, which is physical and inverts under RTL.
 *
 * A segment that filters is a toggle, not a one-way switch, so it carries `aria-pressed` and the
 * selected surface while its filter is the live one — otherwise the only evidence that the table
 * below is filtered sits in a dropdown the user did not touch.
 */
function StockStat({ title, value, sub, tone = 'idle', active = false, onClick }: {
  title: string; value: string; sub: string; tone?: 'idle' | 'alert'; active?: boolean; onClick?: () => void;
}) {
  const body = (
    <>
      <div className="text-xs font-medium text-ink-muted">{title}</div>
      <div className={`kpi-value-compact mt-1 num ${tone === 'alert' ? 'text-alert-fg' : 'text-ink'}`}>{value}</div>
      <div className="mt-0.5 text-xs text-ink-muted">{sub}</div>
    </>
  );
  const shared = 'block min-h-20 border-t border-line-soft px-4 py-3 text-start first:border-t-0 sm:border-s sm:border-t-0 sm:px-5 sm:first:border-s-0';
  return onClick
    ? (
      <button type="button" onClick={onClick} aria-pressed={active}
        className={`${shared} w-full cursor-pointer transition-colors ${active ? 'bg-surface-selected' : 'hover:bg-surface-hover active:bg-surface-selected'}`}>
        {body}
      </button>
    )
    : <div className={shared}>{body}</div>;
}

function movementBadge(type: InventoryMovement['movement_type'], t: (key: TKey) => string) {
  const tone = type === 'receipt' || type === 'stocktake'
    ? 'info'
    : type === 'reversal'
      ? 'idle'
      : type === 'consumption'
        ? 'await'
        : 'idle';
  return <span className={`badge-${tone}`}>{t(MOVEMENT_LABEL[type] as TKey)}</span>;
}

export default function Inventory() {
  const { locale, t } = useT();
  const { profile, organizationAccess } = useAuth();
  // In the URL, not in component state: a filtered מלאי view is a thing an owner sends to the
  // office ("these are the ones under minimum"), and it has to survive Back after opening a
  // product. `useState` made the click unshareable and dropped it on every back-navigation.
  const [filterParam, setFilter] = useParamState('stock');
  const filter: BalanceFilter = (BALANCE_FILTERS as readonly string[]).includes(filterParam)
    ? filterParam as BalanceFilter
    : '';
  const [command, setCommand] = useState<{ product: InventoryBalance; type: InventoryCommand } | null>(null);

  const balances = useQuery<InventoryBalance[]>(async () =>
    fetchAll<InventoryBalance>((from, to) => supabase.from('inventory_intelligence')
      .select('*').order('product_name').order('product_id').range(from, to)));
  const movements = useQuery<InventoryMovement[]>(async () =>
    fetchAll<InventoryMovement>((from, to) => supabase.from('inventory_movement_feed')
      .select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to)));

  const filteredBalances = useMemo(() => (balances.data ?? []).filter((row) => {
    if (filter === 'low') return row.is_low_stock === true;
    if (filter === 'counted') return row.is_counted;
    if (filter === 'uncounted') return !row.is_counted;
    return true;
  }), [balances.data, filter]);

  const balanceColumns: Column<InventoryBalance & { id: string }>[] = [
    {
      key: 'product', header: t('inventory.text_15'), priority: 1, sortValue: (row) => row.product_name,
      render: (row) => <bdi className="font-medium text-ink">{row.product_name}</bdi>,
    },
    {
      key: 'quantity', header: t('inventory.text_16'), className: 'num', priority: 1,
      sortValue: (row) => row.quantity_on_hand ?? Number.NEGATIVE_INFINITY,
      render: (row) => <span className="num">{formatQuantity(row.quantity_on_hand, row.unit, locale)}</span>,
    },
    {
      key: 'minimum', header: t('inventory.text_17'), className: 'num',
      sortValue: (row) => row.min_stock ?? Number.NEGATIVE_INFINITY,
      render: (row) => <span className="num">{formatQuantity(row.min_stock, row.unit, locale)}</span>,
    },
    {
      key: 'consumption', header: t('inventory.text_18'), className: 'num', priority: 2,
      sortValue: (row) => row.average_daily_consumption ?? Number.NEGATIVE_INFINITY,
      render: (row) => <span className="num">{formatQuantity(row.average_daily_consumption, row.unit, locale)}</span>,
    },
    {
      key: 'incoming', header: t('inventory.text_19'), className: 'num', priority: 2,
      sortValue: (row) => row.expected_incoming_quantity ?? Number.NEGATIVE_INFINITY,
      render: (row) => (
        <span>
          <span className="block num">{formatQuantity(row.expected_incoming_quantity, row.unit, locale)}</span>
          {row.next_expected_incoming_date && <span className="block text-xs text-ink-muted">{t('inventoryTail.nearestDate', { date: fmtDate(row.next_expected_incoming_date) })}</span>}
          {!!row.incoming_without_date_quantity && row.incoming_without_date_quantity > 0 && (
            <span className="block text-xs text-ink-muted">{t('inventory.fmtNum')} <span className="num">{fmtNum(row.incoming_without_date_quantity)}</span> {t('inventory.fmtNum_2')}</span>
          )}
        </span>
      ),
    },
    {
      key: 'stockout', header: t('inventory.text_20'), priority: 2,
      sortValue: (row) => row.projected_stockout_days ?? Number.POSITIVE_INFINITY,
      render: (row) => row.projected_stockout_days == null
        ? <span className="num">—</span>
        : <span><span className="num">{fmtNum(Math.ceil(row.projected_stockout_days))}</span> {t('inventory.fmtNum_3')}</span>,
    },
    {
      key: 'reorder', header: t('inventory.text_21'), className: 'num', priority: 2,
      sortValue: (row) => row.suggested_reorder_quantity ?? Number.NEGATIVE_INFINITY,
      render: (row) => <span className="num">{formatQuantity(row.suggested_reorder_quantity, row.unit, locale)}</span>,
    },
    {
      key: 'supplierPrice', header: t('inventory.text_22'), priority: 2,
      sortValue: (row) => row.cheapest_unit_price ?? Number.POSITIVE_INFINITY,
      render: (row) => (row.prices_span_currencies ? (
        /* 0223: quoted in two currencies, so there is no cheapest offer — sorting 12 below 40
           when one is dollars and the other shekels would recommend a supplier on the strength of
           a smaller number rather than a lower price. */
        <span className="text-xs text-ink-muted">{t('inventory.pricesInSeveralCurrencies')}</span>
      ) : row.cheapest_unit_price == null ? <span className="num">—</span> : (
        <span>
          <span className="block font-medium">{row.cheapest_supplier_name} · <span className="num">{fmtMoneyRounded(row.cheapest_unit_price, row.cheapest_currency)}</span></span>
          <span className="block text-xs text-ink-muted">
            {row.price_advantage == null ? t('inventoryTail.onlyActivePrice') : t('inventoryTail.cheaperBy', { amount: fmtMoneyRounded(row.price_advantage, row.cheapest_currency) })}
            {row.latest_purchase_unit_price == null ? '' : t('inventoryTail.lastPurchase', { amount: fmtMoneyRounded(row.latest_purchase_unit_price, row.latest_purchase_currency) })}
          </span>
        </span>
      )),
    },
    {
      key: 'status', header: t('inventory.text_23'), priority: 1,
      sortValue: (row) => row.is_low_stock === true ? 0 : row.is_counted ? 1 : 2,
      render: (row) => row.is_low_stock === true
        ? <span className="badge-alert">{t('inventory.text_24')}</span>
        : row.is_counted
          ? <span className="badge-done">{t('inventory.text_25')}</span>
          : <span className="badge-idle">{t('inventory.text_26')}</span>,
    },
    {
      key: 'lastCount', header: t('inventory.text_27'), priority: 2,
      sortValue: (row) => row.last_counted_at ?? '', render: (row) => fmtDateTime(row.last_counted_at),
    },
  ];

  const movementColumns: Column<InventoryMovement>[] = [
    {
      key: 'createdAt', header: t('inventory.text_28'), priority: 2, sortValue: (row) => row.created_at,
      render: (row) => <span className="num">{fmtDateTime(row.created_at)}</span>,
    },
    {
      key: 'product', header: t('inventory.text_29'), priority: 1, sortValue: (row) => row.product_name,
      render: (row) => <bdi className="font-medium text-ink">{row.product_name}</bdi>,
    },
    { key: 'type', header: t('inventory.movementBadge'), priority: 1, render: (row) => movementBadge(row.movement_type, t) },
    {
      key: 'quantity', header: t('inventory.text_30'), className: 'num', priority: 1,
      sortValue: (row) => row.quantity_delta,
      render: (row) => (
        <span className={`num font-medium ${row.quantity_delta < 0 ? 'text-alert-fg' : 'text-done-fg'}`} dir="ltr">
          {row.quantity_delta > 0 ? '+' : ''}{formatQuantity(row.quantity_delta, row.unit, locale)}
        </span>
      ),
    },
    { key: 'actor', header: t('inventory.text_31'), priority: 2, render: (row) => row.created_by_name },
    {
      key: 'reason', header: t('inventory.text_32'), priority: 2,
      render: (row) => <span>{row.reason}{row.negative_override ? t('inventory.text_33') : ''}</span>,
    },
  ];

  const rows = filteredBalances.map((row) => ({ ...row, id: row.product_id }));
  const canRecord = organizationAccess.canWrite;
  const canAdjust = canRecord && (profile?.role === 'owner' || profile?.role === 'office');
  const counted = balances.data?.filter((row) => row.is_counted).length ?? null;
  const uncounted = balances.data?.filter((row) => !row.is_counted).length ?? null;
  const low = lowStockCount(balances.data ?? null);
  // A read that SUCCEEDED and returned nothing — not a read that has not happened. `balances.data`
  // is null while loading and on failure, and both of those are the em-dash state already.
  const emptyCatalogue = balances.data != null && balances.data.length === 0;
  // Clicking the segment that is already live clears it — a filter you entered by clicking is a
  // filter you should be able to leave the same way, without hunting for the dropdown.
  const toggleFilter = (value: BalanceFilter) => () => setFilter(filter === value ? '' : value);

  const movementCount = movements.data?.length ?? null;
  const latestMovementAt = movements.data?.[0]?.created_at ?? null;

  if (balances.loading && movements.loading) {
    return (
      <div role="status" aria-busy="true" className="space-y-5">
        <span className="sr-only">{t('inventory.text_34')}</span>
        <Skeleton className="h-7 w-24" />
        {/* One band of three segments, matching the settled shape — a three-card placeholder
            would promise boxes the data no longer brings and the page would jump. */}
        <div className="card grid grid-cols-1 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="min-h-20 border-t border-line-soft px-4 py-3 first:border-t-0 sm:border-s sm:border-t-0 sm:px-5 sm:first:border-s-0">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-2 h-6 w-16" />
            </div>
          ))}
        </div>
        <SkeletonTable title={false} cols={5} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* The one sentence that prevents a wrong purchase — a dash is an unmeasured product, and
          reading it as zero stock is how somebody orders a pallet of what they already have — is
          the page's reading key, so it belongs in the header's meta line. It used to sit below the
          title in a full `Note` box: a bordered, tinted alert surface standing permanently over a
          statement that never changes and warns of nothing. Same words, same position, no box. */}
      <PageHeader title={t('inventory.title')} meta={t('inventory.meta')}
        actions={
          <button type="button" className="btn-secondary" disabled={balances.fetching || movements.fetching}
            onClick={() => { void balances.refetch(); void movements.refetch(); }} aria-label={t('inventory.aria_label')}>
              <RefreshCw size={ICON.sm} className={balances.fetching || movements.fetching ? 'animate-spin ' : ''} aria-hidden="true" /> {t('inventoryTail.refresh')}
          </button>
        } />

      <section aria-labelledby="inventory-overview-title">
        <h2 id="inventory-overview-title" className="section-title mb-2">{t('inventory.text_35')}</h2>
        {/* All three segments filter, and each of them filters on the same condition: the count is
            KNOWN. A count of zero is a real answer — "nothing is under minimum" — and filtering to
            an honestly empty table says exactly that; tying clickability to `count > 0`, as it used
            to be, made the answer look like a dead card. A segment showing `—` stays a plain div,
            because an unknown count cannot promise a filter it does not know how to compute
            (CLAUDE.md, "אין ערכים סטטיים מזויפים": `—` is the absence of a measurement, not 0). */}
        {balances.error && !balances.data ? <ErrorNote message={balances.error} /> : (
          <div className="card grid grid-cols-1 sm:grid-cols-3">
            <StockStat title={t('inventory.title_2')} value={counted == null ? '—' : fmtNum(counted)} sub={t('inventory.sub')}
              active={filter === 'counted'} onClick={counted == null ? undefined : toggleFilter('counted')} />
            {/* The sub-line changes with the state, because "דורש בדיקת רכש" under a dash reads as
                a task nobody has to do rather than as an answer nobody has — and, on an empty
                catalogue, under a ZERO it reads as a stocked business with nothing to fix. Three
                figures, three sentences: the count is unknown, the count is zero because there is
                nothing to count, or the count is a real one. See `lowStockCount`. */}
            <StockStat title={t('inventory.title_3')} value={low == null ? '—' : fmtNum(low)}
              sub={low == null
                ? t('inventory.lowStockUnmeasured')
                : emptyCatalogue ? t('inventory.lowStockEmptyCatalogue') : t('inventory.sub_2')}
              tone={low && low > 0 ? 'alert' : 'idle'}
              active={filter === 'low'} onClick={low == null ? undefined : toggleFilter('low')} />
            {/* `idle`, matching the "טרם נספר" badge in the table below. The same set of products
                was amber here and neutral there, on one screen. Not-counted is the ABSENCE of a
                measurement — idle is literally "היעדר טענה" — and on a fresh tenant it is every
                product, so amber here would stop meaning "work waiting" (the reasoning already
                applied to INVOICE_EXPORT_STATUS.not_sent in status.ts). "מלאי נמוך" stays the one
                coloured claim on this screen. The segment is still clickable; the filter did not move. */}
            <StockStat title={t('inventory.title_4')} value={uncounted == null ? '—' : fmtNum(uncounted)} sub={t('inventory.sub_3')}
              active={filter === 'uncounted'} onClick={uncounted == null ? undefined : toggleFilter('uncounted')} />
          </div>
        )}
      </section>

      <section aria-labelledby="inventory-balances-title">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id="inventory-balances-title" className="section-title">{t('inventory.text_36')}</h2>
          {balances.fetching && balances.data && <span className="text-xs text-ink-muted" role="status">{t('inventory.text_37')}</span>}
        </div>
        {/* The method note moved here from above the figures, and lost the card it was wrapped in.
            It describes four columns of the table directly below it — צריכה יומית, צפי אזילה,
            הצעת רכש — so this is where a person asks the question. A `Disclosure` inside a `.card`
            was a box around a box: the summary row already carries a hairline and a chevron. */}
        <Disclosure className="mb-3 border-y border-line-soft" title={t('inventory.title_5')}>
          <ul className="space-y-1.5 text-sm text-ink-body">
            <li>{t('inventory.text_38')} <span className="num">30</span> {t('inventory.text_39')}</li>
            <li>{t('inventory.text_40')}</li>
            <li>{t('inventory.text_41')}</li>
          </ul>
        </Disclosure>
        {balances.loading && !balances.data ? <SkeletonTable title={false} cols={5} /> : (
          /* inventory_balances is one row PER ACTIVE PRODUCT (0026), so an empty table means the
             catalogue is empty — not that nothing was counted. Saying "עדיין לא נספר מלאי" here
             would be a false statement about a count that was never possible. */
          <DataTable rows={rows} columns={balanceColumns} searchable pageSize={20}
            searchLabel={t('inventory.searchLabel')}
            emptyIcon={<Package size={ICON.hero} />}
            emptyTitle={t('inventory.emptyTitle')}
            emptySubtitle={t('inventory.emptySubtitle')}
            emptyAction={<Link className="btn-secondary" to="/products">{t('inventory.text_42')}</Link>}
            searchFn={(row, q) => row.product_name.toLocaleLowerCase('he').includes(q)}
            error={balances.error}
            activeFilters={filter ? 1 : 0}
            onClearFilters={() => setFilter('')}
            toolbar={
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <SlidersHorizontal size={ICON.sm} aria-hidden="true" />
                <span className="sr-only">{t('inventory.text_43')}</span>
                <select className="input w-auto!" aria-label={t('inventory.aria_label_2')} value={filter} onChange={(event) => setFilter(event.target.value)}>
                  <option value="">{t('inventory.text_44')}</option>
                  <option value="low">{t('inventory.text_45')}</option>
                  <option value="counted">{t('inventory.text_46')}</option>
                  <option value="uncounted">{t('inventory.text_47')}</option>
                </select>
              </label>
            }
            rowLabel={(row) => t('inventoryTail.rowLabel', { product: row.product_name })}
            rowActions={(row) => [
              { key: 'stocktake', label: t('inventory.setCommand'), icon: ClipboardCheck, hidden: !canRecord, onSelect: () => setCommand({ product: row, type: 'stocktake' }) },
              { key: 'consumption', label: t('inventory.setCommand_2'), icon: Minus, hidden: !canRecord, onSelect: () => setCommand({ product: row, type: 'consumption' }) },
              { key: 'adjustment', label: t('inventory.setCommand_3'), icon: SlidersHorizontal, hidden: !canAdjust, onSelect: () => setCommand({ product: row, type: 'adjustment' }) },
            ]}
          />
        )}
      </section>

      {/* The movement feed is the LEDGER BEHIND the balances above, not a second decision surface:
          twenty rows of it, in mobile card form, were roughly half the height of this page, sitting
          under a heading of exactly the same weight as the table that actually drives a purchase.
          It is folded, not dropped — DESIGN.md's חוק תיבת הדואר: what folds is evidence and detail,
          and the count on the summary row IS the content, so "how many movements and when was the
          last one" stays on screen while closed. A failed read is never folded away: it takes over
          the summary row as an alert badge, and the table keeps `error` so its body can never
          fall through to "עדיין לא נרשמו תנועות" over a load that failed (gate B30). */}
      <details className="group border-y border-line-soft" aria-labelledby="inventory-movements-title">
        <summary className="-mx-2 flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-2.5 hover:bg-surface-hover active:bg-surface-selected focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
          <h2 id="inventory-movements-title" className="section-title">{t('inventory.text_48')}</h2>
          {movements.error
            ? <span className="badge-alert">{t('inventory.text_49')}</span>
            : movementCount != null && <span className="badge-idle num">{fmtNum(movementCount)}</span>}
          {movements.fetching && movements.data && <span className="text-xs text-ink-muted" role="status">{t('inventory.text_50')}</span>}
          <span className="ms-auto flex items-center gap-2 text-xs text-ink-muted">
            {latestMovementAt && <span>{t('inventory.fmtDateTime')} <span className="num">{fmtDateTime(latestMovementAt)}</span></span>}
            <ChevronDown size={ICON.sm} className="shrink-0 text-ink-ghost transition-transform duration-200 ease-out group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
          </span>
        </summary>
        <div className="border-t border-line-soft pb-4 pt-3">
          {movements.loading && !movements.data ? <SkeletonTable title={false} toolbar={false} cols={6} /> : (
            <DataTable rows={movements.data ?? []} columns={movementColumns} pageSize={20}
              error={movements.error} emptyTitle={t('inventory.emptyTitle_2')}
              emptySubtitle={t('inventory.emptySubtitle_2')} />
          )}
        </div>
      </details>

      {command && (
        <InventoryCommandModal command={command.type} product={command.product}
          canAllowNegative={profile?.role === 'owner'}
          onClose={() => setCommand(null)}
          onSaved={() => {
            setCommand(null);
            void balances.refetch();
            void movements.refetch();
          }} />
      )}
    </div>
  );
}

function InventoryCommandModal({ command, product, canAllowNegative, onClose, onSaved }: {
  command: InventoryCommand;
  product: InventoryBalance;
  canAllowNegative: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { errorText, locale, t } = useT();
  const toast = useToast();
  const copy = COMMAND_COPY[command];
  const [commandId] = useState(() => crypto.randomUUID());
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [allowNegative, setAllowNegative] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const parsed = Number(quantity);
    if (!quantity.trim() || !Number.isFinite(parsed)) {
      toast(t('inventory.toast'), 'error');
      return;
    }
    if (command === 'stocktake' && parsed < 0) {
      toast(t('inventory.toast_2'), 'error');
      return;
    }
    if (command === 'consumption' && parsed <= 0) {
      toast(t('inventory.toast_3'), 'error');
      return;
    }
    if (command === 'adjustment' && parsed === 0) {
      toast(t('inventory.toast_4'), 'error');
      return;
    }
    /* The ceiling the three inventory commands already enforce (`0026:202-203`, `0026:294`),
       said here too so the person gets a sentence instead of a raised exception. The `max`
       attribute alone would not do it: a `type="number"` field still accepts a pasted or typed
       value above `max`, it only marks the field invalid. */
    if (!isQuantityInRange(parsed)) {
      toast(t('inventory.quantityTooLarge'), 'error');
      return;
    }

    setBusy(true);
    try {
      const response = command === 'stocktake'
        ? ok(await supabase.rpc('record_inventory_stocktake', {
          p_movement_id: commandId,
          p_product_id: product.product_id,
          p_counted_quantity: parsed,
          p_reason: reasonOr(reason, t('inventory.reasonOr')),
        }))
        : ok(await supabase.rpc('record_inventory_movement', {
          p_movement_id: commandId,
          p_product_id: product.product_id,
          p_movement_type: command,
          p_quantity: parsed,
          p_allow_negative: canAllowNegative && allowNegative,
          p_reason: reasonOr(reason, t('inventory.reasonOr_2')),
        }));
      const result = unwrap(response) as { idempotent?: boolean } | null;
      toast(result?.idempotent ? t('inventory.toast_5') : t('inventory.toast_6'));
      onSaved();
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} busy={busy} title={`${copy.title} — ${product.product_name}`}
      description={t('inventoryTail.adjustmentDescription', { quantity: formatQuantity(product.quantity_on_hand, product.unit, locale) })}
      statusMessage={busy ? t('inventory.text_51') : undefined}>
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="inventory-command-quantity">{copy.quantity}</label>
          <div className="flex items-center gap-2">
            {/* An adjustment is signed, so it gets both ends of the range; the other two already
                have a floor. `max` mirrors what the command itself enforces (`0026:202-203`,
                `0026:294`) — see `lib/inputBounds.ts`. */}
            <input id="inventory-command-quantity" className="input num" dir="ltr" type="number" step="0.01"
              min={command === 'adjustment' ? -QUANTITY_MAX : 0} max={QUANTITY_MAX}
              value={quantity} onChange={(event) => setQuantity(event.target.value)} />
            <span className="shrink-0 text-sm text-ink-soft">{formatUnit(product.unit, locale)}</span>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="inventory-command-reason">{t('inventory.text_52')}</label>
          <textarea id="inventory-command-reason" className="input" rows={3} maxLength={1000} value={reason}
            onChange={(event) => setReason(event.target.value)} />
        </div>
        {command !== 'stocktake' && canAllowNegative && (
          <label className="flex min-h-11 items-start gap-2 rounded-lg border border-line-soft p-3 text-sm text-ink-body">
            <input type="checkbox" className="mt-0.5 size-4 accent-action" checked={allowNegative}
              onChange={(event) => setAllowNegative(event.target.checked)} />
            <span>
              <span className="block font-medium">{t('inventory.text_53')}</span>
              <span className="block text-xs text-ink-muted">{t('inventory.text_54')}</span>
            </span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>{t('inventory.text_55')}</button>
          <button type="button" className="btn-primary" disabled={busy || !quantity.trim()} onClick={() => void submit()}>
            {busy ? t('inventory.text_56') : copy.submit}
          </button>
        </div>
      </div>
    </Modal>
  );
}

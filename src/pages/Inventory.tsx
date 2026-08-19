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
  type Column,
} from '../components/ui';
import { ok, toHebrewError } from '../lib/errors';
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
  price_advantage: number | null;
  supplier_price_count: number | null;
  latest_purchase_unit_price: number | null;
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
type BalanceFilter = '' | typeof BALANCE_FILTERS[number];

const MOVEMENT_LABEL: Record<InventoryMovement['movement_type'], string> = {
  receipt: 'קבלת סחורה',
  consumption: 'צריכה',
  adjustment: 'התאמה ידנית',
  stocktake: 'ספירה פיזית',
  reversal: 'ביטול תנועה',
};

const COMMAND_COPY: Record<InventoryCommand, { title: string; quantity: string; submit: string }> = {
  stocktake: { title: 'ספירה פיזית', quantity: 'כמות שנספרה', submit: 'שמירת הספירה' },
  consumption: { title: 'רישום צריכה', quantity: 'כמות שנצרכה', submit: 'רישום הצריכה' },
  adjustment: { title: 'התאמת מלאי ידנית', quantity: 'שינוי בכמות (חיובי או שלילי)', submit: 'רישום ההתאמה' },
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

function movementBadge(type: InventoryMovement['movement_type']) {
  const tone = type === 'receipt' || type === 'stocktake'
    ? 'info'
    : type === 'reversal'
      ? 'idle'
      : type === 'consumption'
        ? 'await'
        : 'idle';
  return <span className={`badge-${tone}`}>{MOVEMENT_LABEL[type]}</span>;
}

export default function Inventory() {
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
      key: 'product', header: 'מוצר', priority: 1, sortValue: (row) => row.product_name,
      render: (row) => <bdi className="font-medium text-ink">{row.product_name}</bdi>,
    },
    {
      key: 'quantity', header: 'כמות משוערת', className: 'num', priority: 1,
      sortValue: (row) => row.quantity_on_hand ?? Number.NEGATIVE_INFINITY,
      render: (row) => <span className="num">{formatQuantity(row.quantity_on_hand, row.unit)}</span>,
    },
    {
      key: 'minimum', header: 'מלאי מינימום', className: 'num',
      sortValue: (row) => row.min_stock ?? Number.NEGATIVE_INFINITY,
      render: (row) => <span className="num">{formatQuantity(row.min_stock, row.unit)}</span>,
    },
    {
      key: 'consumption', header: 'צריכה יומית', className: 'num', priority: 2,
      sortValue: (row) => row.average_daily_consumption ?? Number.NEGATIVE_INFINITY,
      render: (row) => <span className="num">{formatQuantity(row.average_daily_consumption, row.unit)}</span>,
    },
    {
      key: 'incoming', header: 'אספקה צפויה', className: 'num', priority: 2,
      sortValue: (row) => row.expected_incoming_quantity ?? Number.NEGATIVE_INFINITY,
      render: (row) => (
        <span>
          <span className="block num">{formatQuantity(row.expected_incoming_quantity, row.unit)}</span>
          {row.next_expected_incoming_date && <span className="block text-xs text-ink-muted">המועד הקרוב: {fmtDate(row.next_expected_incoming_date)}</span>}
          {!!row.incoming_without_date_quantity && row.incoming_without_date_quantity > 0 && (
            <span className="block text-xs text-ink-muted">מתוכם <span className="num">{fmtNum(row.incoming_without_date_quantity)}</span> ללא תאריך</span>
          )}
        </span>
      ),
    },
    {
      key: 'stockout', header: 'צפי לאזילה', priority: 2,
      sortValue: (row) => row.projected_stockout_days ?? Number.POSITIVE_INFINITY,
      render: (row) => row.projected_stockout_days == null
        ? <span className="num">—</span>
        : <span><span className="num">{fmtNum(Math.ceil(row.projected_stockout_days))}</span> ימים</span>,
    },
    {
      key: 'reorder', header: 'הצעת רכש', className: 'num', priority: 2,
      sortValue: (row) => row.suggested_reorder_quantity ?? Number.NEGATIVE_INFINITY,
      render: (row) => <span className="num">{formatQuantity(row.suggested_reorder_quantity, row.unit)}</span>,
    },
    {
      key: 'supplierPrice', header: 'מחיר ספק', priority: 2,
      sortValue: (row) => row.cheapest_unit_price ?? Number.POSITIVE_INFINITY,
      render: (row) => row.cheapest_unit_price == null ? <span className="num">—</span> : (
        <span>
          <span className="block font-medium">{row.cheapest_supplier_name} · <span className="num">{fmtMoneyRounded(row.cheapest_unit_price)}</span></span>
          <span className="block text-xs text-ink-muted">
            {row.price_advantage == null ? 'מחיר פעיל יחיד' : `זול ב-${fmtMoneyRounded(row.price_advantage)} מהמחיר הבא`}
            {row.latest_purchase_unit_price == null ? '' : ` · רכישה אחרונה ${fmtMoneyRounded(row.latest_purchase_unit_price)}`}
          </span>
        </span>
      ),
    },
    {
      key: 'status', header: 'מצב', priority: 1,
      sortValue: (row) => row.is_low_stock === true ? 0 : row.is_counted ? 1 : 2,
      render: (row) => row.is_low_stock === true
        ? <span className="badge-alert">מלאי נמוך</span>
        : row.is_counted
          ? <span className="badge-done">תקין לפי הספירה</span>
          : <span className="badge-idle">טרם נספר</span>,
    },
    {
      key: 'lastCount', header: 'ספירה אחרונה', priority: 2,
      sortValue: (row) => row.last_counted_at ?? '', render: (row) => fmtDateTime(row.last_counted_at),
    },
  ];

  const movementColumns: Column<InventoryMovement>[] = [
    {
      key: 'createdAt', header: 'מועד', priority: 2, sortValue: (row) => row.created_at,
      render: (row) => <span className="num">{fmtDateTime(row.created_at)}</span>,
    },
    {
      key: 'product', header: 'מוצר', priority: 1, sortValue: (row) => row.product_name,
      render: (row) => <bdi className="font-medium text-ink">{row.product_name}</bdi>,
    },
    { key: 'type', header: 'פעולה', priority: 1, render: (row) => movementBadge(row.movement_type) },
    {
      key: 'quantity', header: 'שינוי', className: 'num', priority: 1,
      sortValue: (row) => row.quantity_delta,
      render: (row) => (
        <span className={`num font-medium ${row.quantity_delta < 0 ? 'text-alert-fg' : 'text-done-fg'}`} dir="ltr">
          {row.quantity_delta > 0 ? '+' : ''}{formatQuantity(row.quantity_delta, row.unit)}
        </span>
      ),
    },
    { key: 'actor', header: 'נרשם על ידי', priority: 2, render: (row) => row.created_by_name },
    {
      key: 'reason', header: 'סיבה', priority: 2,
      render: (row) => <span>{row.reason}{row.negative_override ? ' · אושרה יתרה שלילית' : ''}</span>,
    },
  ];

  const rows = filteredBalances.map((row) => ({ ...row, id: row.product_id }));
  const canRecord = organizationAccess.canWrite;
  const canAdjust = canRecord && (profile?.role === 'owner' || profile?.role === 'office');
  const counted = balances.data?.filter((row) => row.is_counted).length ?? null;
  const low = balances.data?.filter((row) => row.is_low_stock === true).length ?? null;
  const uncounted = balances.data?.filter((row) => !row.is_counted).length ?? null;
  // Clicking the segment that is already live clears it — a filter you entered by clicking is a
  // filter you should be able to leave the same way, without hunting for the dropdown.
  const toggleFilter = (value: BalanceFilter) => () => setFilter(filter === value ? '' : value);

  const movementCount = movements.data?.length ?? null;
  const latestMovementAt = movements.data?.[0]?.created_at ?? null;

  if (balances.loading && movements.loading) {
    return (
      <div role="status" aria-busy="true" className="space-y-5">
        <span className="sr-only">טוען</span>
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
      <PageHeader title="מלאי" meta="מוצר שלא נספר מוצג כמקף — יתרה לא ידועה, לא אפס."
        actions={
          <button type="button" className="btn-secondary" disabled={balances.fetching || movements.fetching}
            onClick={() => { void balances.refetch(); void movements.refetch(); }} aria-label="רענון נתוני מלאי ותנועות">
            <RefreshCw size={16} className={balances.fetching || movements.fetching ? 'animate-spin' : ''} aria-hidden="true" /> רענון
          </button>
        } />

      <section aria-labelledby="inventory-overview-title">
        <h2 id="inventory-overview-title" className="section-title mb-2">תמונת מצב</h2>
        {/* All three segments filter, and each of them filters on the same condition: the count is
            KNOWN. A count of zero is a real answer — "nothing is under minimum" — and filtering to
            an honestly empty table says exactly that; tying clickability to `count > 0`, as it used
            to be, made the answer look like a dead card. A segment showing `—` stays a plain div,
            because an unknown count cannot promise a filter it does not know how to compute
            (CLAUDE.md, "אין ערכים סטטיים מזויפים": `—` is the absence of a measurement, not 0). */}
        {balances.error && !balances.data ? <ErrorNote message={balances.error} /> : (
          <div className="card grid grid-cols-1 sm:grid-cols-3">
            <StockStat title="מוצרים שנספרו" value={counted == null ? '—' : fmtNum(counted)} sub="עם יתרה ניתנת למדידה"
              active={filter === 'counted'} onClick={counted == null ? undefined : toggleFilter('counted')} />
            <StockStat title="מתחת למינימום" value={low == null ? '—' : fmtNum(low)} sub="דורש בדיקת רכש"
              tone={low && low > 0 ? 'alert' : 'idle'}
              active={filter === 'low'} onClick={low == null ? undefined : toggleFilter('low')} />
            {/* `idle`, matching the "טרם נספר" badge in the table below. The same set of products
                was amber here and neutral there, on one screen. Not-counted is the ABSENCE of a
                measurement — idle is literally "היעדר טענה" — and on a fresh tenant it is every
                product, so amber here would stop meaning "work waiting" (the reasoning already
                applied to INVOICE_EXPORT_STATUS.not_sent in status.ts). "מלאי נמוך" stays the one
                coloured claim on this screen. The segment is still clickable; the filter did not move. */}
            <StockStat title="ממתינים לספירה" value={uncounted == null ? '—' : fmtNum(uncounted)} sub="היתרה שלהם אינה ידועה"
              active={filter === 'uncounted'} onClick={uncounted == null ? undefined : toggleFilter('uncounted')} />
          </div>
        )}
      </section>

      <section aria-labelledby="inventory-balances-title">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id="inventory-balances-title" className="section-title">יתרות מוצרים</h2>
          {balances.fetching && balances.data && <span className="text-xs text-ink-muted" role="status">מעדכן יתרות…</span>}
        </div>
        {/* The method note moved here from above the figures, and lost the card it was wrapped in.
            It describes four columns of the table directly below it — צריכה יומית, צפי אזילה,
            הצעת רכש — so this is where a person asks the question. A `Disclosure` inside a `.card`
            was a box around a box: the summary row already carries a hairline and a chevron. */}
        <Disclosure className="mb-3 border-y border-line-soft" title="איך המספרים כאן מחושבים">
          <ul className="space-y-1.5 text-sm text-ink-body">
            <li>צריכה יומית — רק תנועות צריכה מאז הספירה האחרונה, עד <span className="num">30</span> יום.</li>
            <li>צפי אזילה והצעת רכש — לפי היתרה שנספרה בלבד. אספקה צפויה מוצגת בנפרד ואינה נחשבת כאילו הגיעה.</li>
            <li>הצעת הרכש אינה יוצרת הזמנה.</li>
          </ul>
        </Disclosure>
        {balances.loading && !balances.data ? <SkeletonTable title={false} cols={5} /> : (
          /* inventory_balances is one row PER ACTIVE PRODUCT (0026), so an empty table means the
             catalogue is empty — not that nothing was counted. Saying "עדיין לא נספר מלאי" here
             would be a false statement about a count that was never possible. */
          <DataTable rows={rows} columns={balanceColumns} searchable pageSize={20}
            searchLabel="חיפוש מוצר במלאי"
            emptyIcon={<Package size={36} />}
            emptyTitle="עדיין אין מוצרים פעילים"
            emptySubtitle="יתרת מלאי נמדדת לכל מוצר פעיל. אחרי הוספת מוצרים, ספירה פיזית ראשונה היא זו שנותנת להם יתרה."
            emptyAction={<Link className="btn-secondary" to="/products">מעבר למוצרים</Link>}
            searchFn={(row, q) => row.product_name.toLocaleLowerCase('he').includes(q)}
            error={balances.error}
            activeFilters={filter ? 1 : 0}
            onClearFilters={() => setFilter('')}
            toolbar={
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <SlidersHorizontal size={16} aria-hidden="true" />
                <span className="sr-only">סינון מצב מלאי</span>
                <select className="input w-auto!" aria-label="סינון מצב מלאי" value={filter} onChange={(event) => setFilter(event.target.value)}>
                  <option value="">כל המוצרים</option>
                  <option value="low">מתחת למינימום</option>
                  <option value="counted">נספרו</option>
                  <option value="uncounted">טרם נספרו</option>
                </select>
              </label>
            }
            rowLabel={(row) => `מלאי ${row.product_name}`}
            rowActions={(row) => [
              { key: 'stocktake', label: 'ספירה פיזית', icon: ClipboardCheck, hidden: !canRecord, onSelect: () => setCommand({ product: row, type: 'stocktake' }) },
              { key: 'consumption', label: 'רישום צריכה', icon: Minus, hidden: !canRecord, onSelect: () => setCommand({ product: row, type: 'consumption' }) },
              { key: 'adjustment', label: 'התאמה ידנית', icon: SlidersHorizontal, hidden: !canAdjust, onSelect: () => setCommand({ product: row, type: 'adjustment' }) },
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
          <h2 id="inventory-movements-title" className="section-title">תנועות אחרונות</h2>
          {movements.error
            ? <span className="badge-alert">שגיאה בטעינת התנועות</span>
            : movementCount != null && <span className="badge-idle num">{fmtNum(movementCount)}</span>}
          {movements.fetching && movements.data && <span className="text-xs text-ink-muted" role="status">מעדכן תנועות…</span>}
          <span className="ms-auto flex items-center gap-2 text-xs text-ink-muted">
            {latestMovementAt && <span>אחרונה: <span className="num">{fmtDateTime(latestMovementAt)}</span></span>}
            <ChevronDown size={16} className="shrink-0 text-ink-ghost transition-transform duration-200 ease-out group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
          </span>
        </summary>
        <div className="border-t border-line-soft pb-4 pt-3">
          {movements.loading && !movements.data ? <SkeletonTable title={false} toolbar={false} cols={6} /> : (
            <DataTable rows={movements.data ?? []} columns={movementColumns} pageSize={20}
              error={movements.error} emptyTitle="עדיין לא נרשמו תנועות מלאי"
              emptySubtitle="ספירה פיזית ראשונה תיצור את נקודת הפתיחה למוצר." />
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
      toast('יש להזין כמות תקינה.', 'error');
      return;
    }
    if (command === 'stocktake' && parsed < 0) {
      toast('כמות בספירה פיזית אינה יכולה להיות שלילית.', 'error');
      return;
    }
    if (command === 'consumption' && parsed <= 0) {
      toast('כמות צריכה חייבת להיות גדולה מאפס.', 'error');
      return;
    }
    if (command === 'adjustment' && parsed === 0) {
      toast('התאמה ידנית חייבת לשנות את הכמות.', 'error');
      return;
    }

    setBusy(true);
    try {
      const response = command === 'stocktake'
        ? ok(await supabase.rpc('record_inventory_stocktake', {
          p_movement_id: commandId,
          p_product_id: product.product_id,
          p_counted_quantity: parsed,
          p_reason: reasonOr(reason, 'תיקון מלאי'),
        }))
        : ok(await supabase.rpc('record_inventory_movement', {
          p_movement_id: commandId,
          p_product_id: product.product_id,
          p_movement_type: command,
          p_quantity: parsed,
          p_allow_negative: canAllowNegative && allowNegative,
          p_reason: reasonOr(reason, 'תיקון מלאי'),
        }));
      const result = unwrap(response) as { idempotent?: boolean } | null;
      toast(result?.idempotent ? 'הפעולה כבר נשמרה קודם; הנתונים רועננו.' : 'תנועת המלאי נשמרה.');
      onSaved();
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} busy={busy} title={`${copy.title} — ${product.product_name}`}
      description={`יתרה נוכחית: ${formatQuantity(product.quantity_on_hand, product.unit)}. הפעולה תירשם ביומן הביקורת.`}
      statusMessage={busy ? 'שומר את תנועת המלאי' : undefined}>
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="inventory-command-quantity">{copy.quantity}</label>
          <div className="flex items-center gap-2">
            <input id="inventory-command-quantity" className="input num" dir="ltr" type="number" step="0.01"
              min={command === 'adjustment' ? undefined : 0} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
            <span className="shrink-0 text-sm text-ink-soft">{formatUnit(product.unit)}</span>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="inventory-command-reason">סיבה (רשות — נרשמת ביומן הביקורת)</label>
          <textarea id="inventory-command-reason" className="input" rows={3} maxLength={1000} value={reason}
            onChange={(event) => setReason(event.target.value)} />
        </div>
        {command !== 'stocktake' && canAllowNegative && (
          <label className="flex min-h-11 items-start gap-2 rounded-lg border border-line-soft p-3 text-sm text-ink-body">
            <input type="checkbox" className="mt-0.5 size-4 accent-action" checked={allowNegative}
              onChange={(event) => setAllowNegative(event.target.checked)} />
            <span>
              <span className="block font-medium">אפשר יתרה שלילית אם הפעולה מחייבת זאת</span>
              <span className="block text-xs text-ink-muted">מיועד לחריגה מנומקת בלבד; האישור נשמר בתנועה וביומן הביקורת.</span>
            </span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button type="button" className="btn-primary" disabled={busy || !quantity.trim()} onClick={() => void submit()}>
            {busy ? 'שומר…' : copy.submit}
          </button>
        </div>
      </div>
    </Modal>
  );
}

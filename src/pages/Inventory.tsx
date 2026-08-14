import { useMemo, useState } from 'react';
import { reasonOr } from '../lib/reason';
import { ClipboardCheck, Minus, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import {
  DataTable,
  ErrorNote,
  KpiCard,
  Modal,
  Note,
  SkeletonCards,
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
type BalanceFilter = 'all' | 'low' | 'uncounted';

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
  const [filter, setFilter] = useState<BalanceFilter>('all');
  const [command, setCommand] = useState<{ product: InventoryBalance; type: InventoryCommand } | null>(null);

  const balances = useQuery<InventoryBalance[]>(async () =>
    fetchAll<InventoryBalance>((from, to) => supabase.from('inventory_intelligence')
      .select('*').order('product_name').order('product_id').range(from, to)));
  const movements = useQuery<InventoryMovement[]>(async () =>
    fetchAll<InventoryMovement>((from, to) => supabase.from('inventory_movement_feed')
      .select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to)));

  const filteredBalances = useMemo(() => (balances.data ?? []).filter((row) => {
    if (filter === 'low') return row.is_low_stock === true;
    if (filter === 'uncounted') return !row.is_counted;
    return true;
  }), [balances.data, filter]);

  const balanceColumns: Column<InventoryBalance & { id: string }>[] = [
    {
      key: 'product', header: 'מוצר', priority: 1, sortValue: (row) => row.product_name,
      render: (row) => <span className="font-medium text-ink">{row.product_name}</span>,
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
            <span className="block text-xs text-ink-muted num">מתוכם {fmtNum(row.incoming_without_date_quantity)} ללא תאריך</span>
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
      render: (row) => <span className="font-medium text-ink">{row.product_name}</span>,
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

  if (balances.loading && movements.loading) {
    return <div className="space-y-5"><SkeletonCards count={3} cols={3} /><SkeletonTable cols={5} /></div>;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">מלאי</h1>
          <p className="mt-1 text-sm text-ink-soft">יתרה משוערת מתנועות קבלה, צריכה וספירה פיזית.</p>
        </div>
        <button type="button" className="btn-secondary" disabled={balances.fetching || movements.fetching}
          onClick={() => { void balances.refetch(); void movements.refetch(); }} aria-label="רענון נתוני מלאי ותנועות">
          <RefreshCw size={16} className={balances.fetching || movements.fetching ? 'animate-spin' : ''} aria-hidden="true" /> רענון
        </button>
      </header>

      <Note tone="idle">
        מוצר שלא בוצעה לו ספירה פיזית מוצג כ־<span className="num">—</span>. זהו מצב לא ידוע, לא מלאי אפס.
      </Note>

      <Note tone="info">
        צריכה יומית מחושבת רק מתנועות צריכה שנרשמו מאז הספירה האחרונה, ועד 30 יום. צפי האזילה והצעת הרכש מסתמכים על היתרה המדודה בלבד; אספקה צפויה מוצגת בנפרד ואינה נחשבת כאילו כבר הגיעה. ההצעה אינה יוצרת הזמנה.
      </Note>

      <section aria-labelledby="inventory-overview-title">
        <h2 id="inventory-overview-title" className="section-title mb-3">תמונת מצב</h2>
        {balances.error && !balances.data ? <ErrorNote message={balances.error} /> : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <KpiCard title="מוצרים שנספרו" value={counted == null ? '—' : fmtNum(counted)} sub="עם יתרה ניתנת למדידה" />
            <KpiCard title="מתחת למינימום" value={low == null ? '—' : fmtNum(low)} sub="דורש בדיקת רכש" tone={low && low > 0 ? 'alert' : 'idle'} onClick={low && low > 0 ? () => setFilter('low') : undefined} />
            <KpiCard title="ממתינים לספירה" value={uncounted == null ? '—' : fmtNum(uncounted)} sub="היתרה שלהם אינה ידועה" tone={uncounted && uncounted > 0 ? 'await' : 'idle'} onClick={uncounted && uncounted > 0 ? () => setFilter('uncounted') : undefined} />
          </div>
        )}
      </section>

      <section aria-labelledby="inventory-balances-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="inventory-balances-title" className="section-title">יתרות מוצרים</h2>
          {balances.fetching && balances.data && <span className="text-xs text-ink-muted" role="status">מעדכן יתרות…</span>}
        </div>
        {balances.loading && !balances.data ? <SkeletonTable title={false} cols={5} /> : (
          <DataTable rows={rows} columns={balanceColumns} searchable pageSize={20}
            searchLabel="חיפוש מוצר במלאי"
            searchFn={(row, q) => row.product_name.toLocaleLowerCase('he').includes(q)}
            error={balances.error}
            activeFilters={filter === 'all' ? 0 : 1}
            onClearFilters={() => setFilter('all')}
            toolbar={
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <SlidersHorizontal size={16} aria-hidden="true" />
                <span className="sr-only">סינון מצב מלאי</span>
                <select className="input w-auto!" aria-label="סינון מצב מלאי" value={filter} onChange={(event) => setFilter(event.target.value as BalanceFilter)}>
                  <option value="all">כל המוצרים</option>
                  <option value="low">מתחת למינימום</option>
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

      <section aria-labelledby="inventory-movements-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="inventory-movements-title" className="section-title">תנועות אחרונות</h2>
          {movements.fetching && movements.data && <span className="text-xs text-ink-muted" role="status">מעדכן תנועות…</span>}
        </div>
        {movements.loading && !movements.data ? <SkeletonTable title={false} cols={6} /> : (
          <DataTable rows={movements.data ?? []} columns={movementColumns} pageSize={20}
            error={movements.error} emptyTitle="עדיין לא נרשמו תנועות מלאי"
            emptySubtitle="ספירה פיזית ראשונה תיצור את נקודת הפתיחה למוצר." />
        )}
      </section>

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

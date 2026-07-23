import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Minus, PackageCheck, Save, CheckCircle2, FileText, Camera, ChevronDown } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { PageLoader, useToast, StatusBadge, EmptyState, ErrorNote, SkeletonList } from '../components/ui';
import { DocumentList } from '../components/FileUpload';
import { PO_STATUS, RECEIPT_LINE_STATUS, type Tone } from '../lib/status';
import { fmtDate, todayISO } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import type { PurchaseOrder, PurchaseOrderItem, ReceiptLineStatus } from '../lib/types';

type OrderForReceiving = PurchaseOrder & {
  supplier: { id: string; name: string };
  items: (PurchaseOrderItem & { product: { name: string; unit: string } })[];
};

function needsReceivingAttention(order: OrderForReceiving, today: string): boolean {
  return order.status === 'partial' || (!!order.expected_date && order.expected_date <= today);
}

function ReceivingOrderCard({ order, today, onOpen }: {
  order: OrderForReceiving;
  today: string;
  onOpen: () => void;
}) {
  const attentionReason = order.status === 'partial'
    ? 'קבלה חלקית'
    : order.expected_date && order.expected_date < today
      ? 'מועד האספקה עבר'
      : order.expected_date === today
        ? 'אספקה היום'
        : null;

  return (
    <button onClick={onOpen}
      className="card w-full text-start p-4 hover:border-action-line active:scale-[.99] transition-all focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-ink text-base">{order.supplier.name}</div>
        <StatusBadge meta={PO_STATUS[order.status]} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-ink-muted">
        <span className="num">הזמנה #{order.number}</span>
        <span className="num">{order.items.length} פריטים</span>
        {order.expected_date && <span>אספקה: {fmtDate(order.expected_date)}</span>}
      </div>
      {attentionReason && <div className="mt-2 text-xs font-medium text-await-fg">{attentionReason}</div>}
    </button>
  );
}

/* ============ List of orders awaiting receiving — mobile-first cards ============ */
export function ReceivingList() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const { data, loading, error } = useQuery(async () =>
    unwrap(await supabase.from('purchase_orders')
      .select('*, supplier:suppliers(id, name), items:purchase_order_items(id, qty, received_qty)')
      .in('status', ['sent', 'confirmed', 'partial'])
      .order('expected_date', { ascending: true })) as Promise<OrderForReceiving[]>);

  if (loading) return <SkeletonList />;
  if (error) return <ErrorNote message={error} />;

  const today = todayISO();
  const query = search.trim().toLowerCase();
  const filtered = (data ?? []).filter((order) =>
    (!query || order.supplier.name.toLowerCase().includes(query) || String(order.number).includes(query)) &&
    (statusFilter === 'all'
      || (statusFilter === 'attention' && needsReceivingAttention(order, today))
      || order.status === statusFilter));
  const attention = filtered.filter((order) => needsReceivingAttention(order, today));
  const remaining = filtered.filter((order) => !needsReceivingAttention(order, today));
  const focusedQueue = !query && statusFilter === 'all';

  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="page-title">קבלת סחורה</h1>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <label className="sr-only" htmlFor="receiving-search">חיפוש הזמנה לקבלה</label>
          <input id="receiving-search" type="search" className="input min-h-11"
            placeholder="חיפוש לפי ספק או מספר הזמנה"
            value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <select className="input min-h-11 sm:w-auto!" aria-label="סינון הזמנות לקבלה"
          value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="all">כל הסטטוסים</option>
          <option value="attention">דורש פעולה</option>
          <option value="sent">נשלחה</option>
          <option value="confirmed">אושרה</option>
          <option value="partial">התקבלה חלקית</option>
        </select>
      </div>

      {!data?.length ? (
        <div className="card"><EmptyState title="אין הזמנות שממתינות לקבלה" subtitle="הזמנות בסטטוס נשלחה / אושרה יופיעו כאן" /></div>
      ) : !filtered.length ? (
        <div className="card"><EmptyState title="לא נמצאו הזמנות" subtitle="אפשר לשנות את החיפוש או הסינון" /></div>
      ) : !focusedQueue ? (
        <div className="space-y-3" aria-label="תוצאות קבלת סחורה">
          {filtered.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} onOpen={() => navigate(`/receiving/${order.id}`)} />)}
        </div>
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="receiving-attention-title">
            <div className="flex items-center justify-between gap-2">
              <h2 id="receiving-attention-title" className="section-title">דורש פעולה</h2>
              <span className="badge-await num">{attention.length}</span>
            </div>
            {attention.length
              ? attention.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} onOpen={() => navigate(`/receiving/${order.id}`)} />)
              : <div className="card card-pad text-sm text-ink-soft">אין קבלות שדורשות פעולה כרגע.</div>}
          </section>

          {remaining.length > 0 && (
            <>
              <details className="group sm:hidden">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg px-2 text-sm font-medium text-action hover:bg-surface-sunken active:bg-action-wash/70 focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
                  הצג הכל ({filtered.length})
                  <ChevronDown size={16} className="transition-transform group-open:rotate-180" />
                </summary>
                <div className="space-y-3 pt-2">
                  {remaining.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} onOpen={() => navigate(`/receiving/${order.id}`)} />)}
                </div>
              </details>
              <section className="hidden space-y-3 sm:block" aria-labelledby="receiving-other-title">
                <h2 id="receiving-other-title" className="section-title">הזמנות נוספות</h2>
                {remaining.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} onOpen={() => navigate(`/receiving/${order.id}`)} />)}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ============ Receive a specific order — large touch targets, minimal typing ============ */
interface LineState { qty: number; status: ReceiptLineStatus; notes: string }

export function ReceiveOrder() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [lines, setLines] = useState<Record<string, LineState>>({});
  const [openCredits, setOpenCredits] = useState(true);
  const [newReceiptId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [doneReceiptId, setDoneReceiptId] = useState<string | null>(null);
  const [invoiceSupplier, setInvoiceSupplier] = useState<string | null>(null);

  const { data, loading, error } = useQuery(async () => {
    const order = unwrap(await supabase.from('purchase_orders')
      .select('*, supplier:suppliers(id, name), items:purchase_order_items(*, product:products(name, unit))')
      .eq('id', orderId!).single()) as OrderForReceiving;
    const draft = unwrap(await supabase.from('goods_receipts')
      .select('*, items:goods_receipt_items(*)').eq('order_id', orderId!).eq('status', 'draft').maybeSingle()) as
      ({ id: string; items: { order_item_id: string; qty_received: number; status: ReceiptLineStatus; notes: string | null }[] } | null);
    return { order, draft };
  }, [orderId]);

  // hydrate line state from draft or defaults (remaining quantity, full)
  useEffect(() => {
    if (!data) return;
    const init: Record<string, LineState> = {};
    for (const item of data.order.items) {
      const draftLine = data.draft?.items.find((d) => d.order_item_id === item.id);
      const remaining = Math.max(0, item.qty - item.received_qty);
      init[item.id] = draftLine
        ? { qty: draftLine.qty_received, status: draftLine.status, notes: draftLine.notes ?? '' }
        : { qty: remaining, status: 'full', notes: '' };
    }
    setLines(init);
  }, [data]);

  const order = data?.order;

  const progress = useMemo(() => {
    if (!order) return { done: 0, total: 0 };
    return { done: Object.keys(lines).length, total: order.items.length };
  }, [order, lines]);

  function setLine(itemId: string, patch: Partial<LineState>, item?: PurchaseOrderItem) {
    setLines((s) => {
      const cur = s[itemId];
      const next = { ...cur, ...patch };
      // auto-derive status from qty unless an explicit "quality" status was chosen
      if (patch.qty != null && item && !['damaged', 'returned'].includes(next.status)) {
        const remaining = Math.max(0, item.qty - item.received_qty);
        next.status = patch.qty === 0 ? 'missing' : patch.qty < remaining ? 'partial' : 'full';
      }
      return { ...s, [itemId]: next };
    });
  }

  async function save(complete: boolean) {
    if (!order) return;
    setBusy(true);
    try {
      const result = unwrap(await supabase.rpc('save_goods_receipt', {
        p_order_id: order.id,
        p_receipt_id: data?.draft?.id ?? newReceiptId,
        p_complete: complete,
        p_notes: null,
        p_open_credits: openCredits,
        p_lines: order.items.map((item) => ({
          order_item_id: item.id,
          qty_received: lines[item.id]?.qty ?? 0,
          status: lines[item.id]?.status ?? 'full',
          notes: lines[item.id]?.notes.trim() || null,
        })),
        p_reason: complete ? 'השלמת קבלת סחורה' : 'שמירת ביניים של קבלת סחורה',
      })) as { receipt_id: string };

      const receiptId = result.receipt_id;
      if (complete) {
        setDoneReceiptId(receiptId);
        setInvoiceSupplier(order.supplier.id);
        toast('הקבלה הושלמה');
      } else {
        toast('נשמרה טיוטת קבלה — אפשר להמשיך מאוחר יותר');
        navigate('/receiving');
      }
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageLoader />;
  if (error || !order) return <ErrorNote message={error ?? 'הזמנה לא נמצאה'} />;

  /* completion screen: attach invoice photo + optional invoice creation */
  if (doneReceiptId) {
    return (
      <div className="max-w-xl mx-auto space-y-4 text-center pt-6">
        <CheckCircle2 size={48} className="text-done-solid mx-auto" />
        <h1 className="text-xl font-bold text-ink">הקבלה נשמרה!</h1>
        <p className="text-sm text-ink-muted">עכשיו אפשר לצלם את החשבונית או תעודת המשלוח ולצרף אותה לקבלה.</p>
        <div className="card card-pad text-start">
          <DocumentList entityType="goods_receipt" entityId={doneReceiptId} capture />
        </div>
        <div className="flex flex-col sm:flex-row gap-2 justify-center">
          <button className="btn-primary" onClick={() => navigate(`/invoices/new?supplier=${invoiceSupplier}&order=${order.id}&receipt=${doneReceiptId}`)}>
            <FileText size={15} /> הזנת חשבונית להזמנה זו
          </button>
          <button className="btn-secondary" onClick={() => navigate('/receiving')}>חזרה לקבלת סחורה</button>
        </div>
      </div>
    );
  }

  const statusButtons: { key: ReceiptLineStatus; label: string }[] = [
    { key: 'full', label: 'מלא' }, { key: 'partial', label: 'חלקי' }, { key: 'missing', label: 'חסר' },
    { key: 'damaged', label: 'פגום' }, { key: 'returned', label: 'הוחזר' },
  ];
  // Single source: the tone comes from RECEIPT_LINE_STATUS (lib/status.ts), so re-colouring
  // a status there recolours both the selected button and the card border here (§4.5).
  // The old amber-500 shade folds into await-solid, away from the off-by-one shade (§3.6ה).
  const SOLID: Record<Tone, string> = {
    done: 'bg-done-solid text-white border-done-solid',
    await: 'bg-await-solid text-white border-await-solid',
    alert: 'bg-alert-solid text-white border-alert-solid',
    info: 'bg-info-solid text-white border-info-solid',
    idle: 'bg-idle-solid text-white border-idle-solid',
  };
  const CARD: Record<Tone, string> = {
    done: 'border-done-line', await: 'border-await-line', alert: 'border-alert-line',
    info: 'border-info-line', idle: 'border-idle-line',
  };

  return (
    <div className="max-w-xl mx-auto space-y-3 pb-28">
      <div>
        <h1 className="page-title flex items-center gap-2"><PackageCheck size={22} /> קבלת סחורה</h1>
        <div className="text-sm text-ink-muted mt-1">{order.supplier.name} · <span className="num">הזמנה #{order.number}</span></div>
        {data?.draft && <div className="mt-1 text-xs text-await-fg">נטענה טיוטת קבלה שנשמרה קודם</div>}
      </div>

      {order.items.map((item) => {
        const line = lines[item.id];
        if (!line) return null;
        const remaining = Math.max(0, item.qty - item.received_qty);
        return (
          <div key={item.id} className={`card p-4 border-2 ${CARD[RECEIPT_LINE_STATUS[line.status].tone]}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold text-ink">{item.product.name}</div>
                <div className="text-xs text-ink-muted mt-0.5">
                  הוזמן: {item.qty} {item.product.unit}
                  {item.received_qty > 0 && ` · התקבל בעבר: ${item.received_qty}`}
                </div>
              </div>
              <StatusBadge meta={RECEIPT_LINE_STATUS[line.status]} />
            </div>

            <div className="flex items-center gap-2 mt-3">
              <span className="text-sm text-ink-soft w-16">התקבל:</span>
              <button className="btn-secondary p-3!" onClick={() => setLine(item.id, { qty: Math.max(0, line.qty - 1) }, item)} aria-label={`הפחתת הכמות שהתקבלה עבור ${item.product.name}`}><Minus size={18} /></button>
              <input type="number" min={0} step="any" inputMode="decimal"
                className="input w-24! num text-center text-lg! py-2.5! font-semibold"
                aria-label={`כמות שהתקבלה עבור ${item.product.name}`}
                value={line.qty} onChange={(e) => setLine(item.id, { qty: Math.max(0, Number(e.target.value) || 0) }, item)} />
              <button className="btn-secondary p-3!" onClick={() => setLine(item.id, { qty: line.qty + 1 }, item)} aria-label={`הגדלת הכמות שהתקבלה עבור ${item.product.name}`}><Plus size={18} /></button>
              {line.qty !== remaining && (
                <button className="btn-ghost text-xs" aria-label={`סימון מלוא הכמות שנותרה עבור ${item.product.name}: ${remaining}`} onClick={() => setLine(item.id, { qty: remaining }, item)}>מלא ({remaining})</button>
              )}
            </div>

            <div className="grid grid-cols-5 gap-1.5 mt-3">
              {statusButtons.map((b) => (
                <button key={b.key}
                  className={`rounded-lg border min-h-11 flex items-center justify-center text-xs font-medium transition-colors ${line.status === b.key ? SOLID[RECEIPT_LINE_STATUS[b.key].tone] : 'border-line text-ink-soft hover:bg-surface-sunken'}`}
                  aria-label={`${b.label} עבור ${item.product.name}`}
                  aria-pressed={line.status === b.key}
                  onClick={() => setLine(item.id, { status: b.key, ...(b.key === 'missing' ? { qty: 0 } : {}) })}>
                  {b.label}
                </button>
              ))}
            </div>

            {line.status !== 'full' && (
              <input className="input mt-2.5" placeholder="הערה (למשל: הגיע מופשר, אריזה קרועה...)"
                aria-label={`הערה לקבלת ${item.product.name}`}
                value={line.notes} onChange={(e) => setLine(item.id, { notes: e.target.value })} />
            )}
          </div>
        );
      })}

      <label className="flex items-center gap-2 text-sm text-ink-mid px-1">
        <input type="checkbox" className="rounded" checked={openCredits} onChange={(e) => setOpenCredits(e.target.checked)} />
        פתיחת דרישות זיכוי אוטומטית לחוסרי כמות בלבד
      </label>
      <p className="px-1 text-xs text-ink-muted">פריטים פגומים או שהוחזרו אינם נספרים כאספקה תקינה, והטיפול הכספי בהם נשאר ידני עד להכרעה עסקית.</p>
      {/* sticky action bar */}
      <div className="phone-taskbar fixed inset-x-0 lg:ms-60 bg-surface border-t border-line p-3 flex gap-2 z-30">
        {busy && <span className="sr-only" role="status" aria-live="polite">שומר את הקבלה</span>}
        <div className="hidden sm:flex items-center text-xs text-ink-muted me-auto ps-2">
          <Camera size={14} className="me-1" /> צילום החשבונית יתאפשר מיד לאחר סיום הקבלה
        </div>
        <button className="btn-secondary flex-1 sm:flex-none" disabled={busy} onClick={() => void save(false)}>
          <Save size={15} /> שמירת ביניים
        </button>
        <button className="btn-primary flex-1 sm:flex-none px-6!" disabled={busy} onClick={() => void save(true)}>
          <CheckCircle2 size={16} /> סיום קבלה ({progress.total} פריטים)
        </button>
      </div>
    </div>
  );
}

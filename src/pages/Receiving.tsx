import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Plus, Minus, PackageCheck, Save, CheckCircle2, FileText, Camera, ChevronDown } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { Breadcrumbs, useToast, StatusBadge, EmptyState, ErrorNote, PageHeader, RecordHeader, RecordSkeleton, SkeletonList, Note, ConfirmDialog } from '../components/ui';
import { useAuth } from '../auth/AuthContext';
import { DocumentList } from '../components/FileUpload';
import { deliveryNoteLines, matchDeliveryLineProduct } from '../components/document-review/model';
import BarcodeScanControl, { type BarcodeScanResult } from '../components/BarcodeScanner';
import OfflineQueueStatus from '../components/OfflineQueueStatus';
import ReceiptConflictDialog, {
  loadReceiptConflict, type ReceiptConflictResolution, type ReceiptConflictState,
} from '../components/ReceiptConflictDialog';
import { PO_STATUS, RECEIPT_LINE_STATUS, type Tone } from '../lib/status';
import { fmtDate, fmtDateTime, todayISO } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import {
  deleteReceiptDraft, ensureReceiptKey, getOpenOrder, getReceiptDraft, isOpenOrderStale,
  listOpenOrders, listUnsyncedDraftOrderIds, putOpenOrder, putReceiptDraft,
  type OfflineReceiptLine, type ReceiptKeyResolution, type SaveGoodsReceiptPayload,
} from '../lib/offlineDb';
import { offlineQueue } from '../lib/offlineQueue';
import type { InterpretationContract } from '../lib/useDocumentProcessing';
import type { ReceiptLineStatus } from '../lib/types';

/**
 * What this screen needs about an order — and nothing more.
 *
 * Narrower than `PurchaseOrder` on purpose. This projection is what gets stored in IndexedDB for
 * offline viewing, and **it carries no money**: no `unit_price`, no `total_amount`. The offline store
 * contract (`OFFLINE-SYNC-DESIGN.md:44`) lists supplier, items, ordered quantities and
 * `expected_date`, and the never-cache rule (:36) is a hard boundary. The receiving screen never
 * displays a price anyway, so nothing is lost by refusing to keep one.
 */
interface ReceivingProduct { id: string; name: string; unit: string; sku: string | null; barcode: string | null }
interface ReceivingItem { id: string; product_id: string; qty: number; received_qty: number; product: ReceivingProduct }
interface ReceivingOrder {
  id: string;
  number: number | null;
  status: string;
  expected_date: string | null;
  supplier: { id: string; name: string };
  items: ReceivingItem[];
}

type ServerOrder = {
  id: string; number: number | null; status: string; expected_date: string | null;
  supplier: { id: string; name: string };
  items: {
    id: string; product_id: string; qty: number; received_qty: number;
    product: { id: string; name: string; unit: string; sku: string | null; barcode: string | null };
  }[];
};

function toReceivingOrder(order: ServerOrder): ReceivingOrder {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    expected_date: order.expected_date,
    supplier: { id: order.supplier.id, name: order.supplier.name },
    items: order.items.map((item) => ({
      id: item.id,
      product_id: item.product_id,
      qty: item.qty,
      received_qty: item.received_qty,
      product: {
        id: item.product.id, name: item.product.name, unit: item.product.unit,
        sku: item.product.sku, barcode: item.product.barcode,
      },
    })),
  };
}

/** What a scanned delivery note contributes to one order's receipt lines. */
interface DeliveredMatch {
  matchedQty: Map<string, number>;
  /** Named, not counted: a line nobody can place must be visible, not a silent zero. */
  unmatched: string[];
  supplierMismatch: boolean;
}

function needsReceivingAttention(order: { status: string; expected_date: string | null }, today: string): boolean {
  return order.status === 'partial' || (!!order.expected_date && order.expected_date <= today);
}

interface ReceivingListOrder {
  id: string;
  number: number | null;
  status: string;
  expected_date: string | null;
  supplier: { id: string; name: string };
  items: { id: string }[];
}

function ReceivingOrderCard({ order, today, localDraft, onOpen }: {
  order: ReceivingListOrder;
  today: string;
  localDraft: boolean;
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
      {/* A receipt recorded on this device that the server has not accepted yet. Shown on the card
          because the person who typed it needs to see it from the list, not only after opening. */}
      {localDraft && <div className="mt-1 text-xs font-medium text-alert-fg">טיוטה מקומית — טרם סונכרנה</div>}
    </button>
  );
}

/* ============ List of orders awaiting receiving — mobile-first cards ============ */
export function ReceivingList() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const documentId = params.get('document');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [localDrafts, setLocalDrafts] = useState<string[]>([]);
  const { data, loading, error } = useQuery(async () => {
    try {
      const rows = unwrap(await supabase.from('purchase_orders')
        .select('*, supplier:suppliers(id, name), items:purchase_order_items(id, qty, received_qty)')
        .in('status', ['sent', 'confirmed', 'partial'])
        .order('expected_date', { ascending: true })) as ReceivingListOrder[];
      return { orders: rows, fromDevice: false, readAt: null as number | null, stale: false };
    } catch (serverError) {
      // Offline fallback, bounded exactly as the design document bounds it (:107): only orders that
      // were actually downloaded — i.e. opened on this device — are available, and there is no
      // blanket pre-download. With nothing cached the real error is raised rather than an empty
      // list, because an empty list would read as "no orders await receiving".
      const cached = await listOpenOrders();
      if (!cached.length) throw serverError;
      const orders = cached
        .map((entry) => entry.order as ReceivingOrder)
        .map<ReceivingListOrder>((order) => ({
          id: order.id, number: order.number, status: order.status,
          expected_date: order.expected_date, supplier: order.supplier,
          items: order.items.map((item) => ({ id: item.id })),
        }));
      return {
        orders,
        fromDevice: true,
        readAt: Math.max(...cached.map((entry) => entry.fetchedAt)),
        stale: cached.some((entry) => isOpenOrderStale(entry)),
      };
    }
  });

  useEffect(() => { void listUnsyncedDraftOrderIds().then(setLocalDrafts); }, [data]);

  // Receiving from a delivery note: the document names the supplier, never the order. Seeding the
  // search with the supplier narrows the list to plausible orders; choosing among them stays the
  // job of whoever is standing at the delivery, because only they can see what actually arrived.
  // Asked as plain lookups rather than PostgREST embeds: suggested_supplier_id is a generated
  // column and both relationships here hang off composite tenant foreign keys, which is exactly
  // where embed resolution turns into a 400 nobody sees until it is live.
  const { data: source } = useQuery(async () => {
    if (!documentId) return null;
    const [interpretation, document] = await Promise.all([
      supabase.from('document_interpretations').select('suggested_supplier_id')
        .eq('document_id', documentId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('documents').select('file_name').eq('id', documentId).maybeSingle(),
    ]);
    if (interpretation.error || !interpretation.data) return null;
    const supplierId = (interpretation.data as { suggested_supplier_id: string | null }).suggested_supplier_id;
    const supplier = supplierId
      ? await supabase.from('suppliers').select('name').eq('id', supplierId).maybeSingle()
      : null;
    return {
      supplierName: (supplier?.data as { name: string } | null | undefined)?.name ?? null,
      fileName: (document.data as { file_name: string } | null)?.file_name ?? null,
    };
  }, [documentId]);

  const supplierName = source?.supplierName ?? undefined;
  useEffect(() => { if (supplierName) setSearch(supplierName); }, [supplierName]);

  if (loading) return <SkeletonList />;
  if (error) return <ErrorNote message={error} />;

  const openOrder = (orderId: string) =>
    navigate(`/receiving/${orderId}${documentId ? `?document=${documentId}` : ''}`);

  const today = todayISO();
  const query = search.trim().toLowerCase();
  const orders = data?.orders ?? [];
  const filtered = orders.filter((order) =>
    (!query || order.supplier.name.toLowerCase().includes(query) || String(order.number).includes(query)) &&
    (statusFilter === 'all'
      || (statusFilter === 'attention' && needsReceivingAttention(order, today))
      || order.status === statusFilter));
  const attention = filtered.filter((order) => needsReceivingAttention(order, today));
  const remaining = filtered.filter((order) => !needsReceivingAttention(order, today));
  const focusedQueue = !query && statusFilter === 'all';
  const isLocalDraft = (orderId: string) => localDrafts.includes(orderId);

  return (
    <div className="space-y-4 max-w-2xl">
      <PageHeader title="קבלת סחורה" meta={`${orders.length} הזמנות ממתינות · ${attention.length} דורשות פעולה`} />
      <OfflineQueueStatus />
      {data?.fromDevice && (
        <Note tone={data.stale ? 'alert' : 'await'}>
          הרשימה מוצגת מהמכשיר, לא מהשרת. נקראה לאחרונה ב<span className="num">{fmtDateTime(data.readAt ? new Date(data.readAt) : null)}</span>
          {data.stale && ' — הנתונים מיושנים (מעל 24 שעות)'}. מופיעות כאן רק הזמנות שנפתחו במכשיר הזה בעבר.
        </Note>
      )}
      {documentId && (
        <Note tone={source ? 'await' : 'alert'}>
          {source
            ? <>קליטה מתעודת המשלוח {source.fileName ? <strong>{source.fileName}</strong> : 'שנסרקה'}
                {supplierName ? <> של <strong>{supplierName}</strong></> : null}. בחר את ההזמנה שאליה הסחורה הגיעה — הכמויות ימולאו מהתעודה.</>
            : 'לא נמצא פירוש לתעודת המשלוח שביקשת לקלוט. אפשר להמשיך ולבחור הזמנה, אך הכמויות לא ימולאו מראש.'}
        </Note>
      )}
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

      {!orders.length ? (
        <div className="card"><EmptyState title="אין הזמנות שממתינות לקבלה" subtitle="הזמנות בסטטוס נשלחה / אושרה יופיעו כאן" /></div>
      ) : !filtered.length ? (
        <div className="card"><EmptyState title="לא נמצאו הזמנות" subtitle="אפשר לשנות את החיפוש או הסינון" /></div>
      ) : !focusedQueue ? (
        // section, not div: aria-label on a roleless div is dropped by screen readers, so this list
        // of results arrived unnamed. Matches the labelled section in the focused-queue branch below.
        <section className="space-y-3" aria-label="תוצאות קבלת סחורה">
          {filtered.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} localDraft={isLocalDraft(order.id)} onOpen={() => openOrder(order.id)} />)}
        </section>
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="receiving-attention-title">
            <div className="flex items-center justify-between gap-2">
              <h2 id="receiving-attention-title" className="section-title">דורש פעולה</h2>
              <span className="badge-await num">{attention.length}</span>
            </div>
            {attention.length
              ? attention.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} localDraft={isLocalDraft(order.id)} onOpen={() => openOrder(order.id)} />)
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
                  {remaining.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} localDraft={isLocalDraft(order.id)} onOpen={() => openOrder(order.id)} />)}
                </div>
              </details>
              <section className="hidden space-y-3 sm:block" aria-labelledby="receiving-other-title">
                <h2 id="receiving-other-title" className="section-title">הזמנות נוספות</h2>
                {remaining.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} localDraft={isLocalDraft(order.id)} onOpen={() => openOrder(order.id)} />)}
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

const REASON_COMPLETE = 'השלמת קבלת סחורה';
const REASON_DRAFT = 'שמירת ביניים של קבלת סחורה';

export function ReceiveOrder() {
  const { orderId } = useParams<{ orderId: string }>();
  const [params] = useSearchParams();
  const documentId = params.get('document');
  const navigate = useNavigate();
  const toast = useToast();
  const { profile } = useAuth();
  const [lines, setLines] = useState<Record<string, LineState>>({});
  const [openCredits, setOpenCredits] = useState(true);
  // #116 (decided 09.08.2026): a manual exception is an owner/office command. kitchen — the
  // role that actually stands at the truck — reports to them; the sentence below says so.
  const canOpenException = !!profile && ['owner', 'office'].includes(profile.role);
  const [exceptionOpen, setExceptionOpen] = useState(false);
  const [exceptionBusy, setExceptionBusy] = useState(false);
  /**
   * The receipt's idempotency key, read from (or minted into) the device store — never derived at
   * send time. `Receiving.tsx` used to send `draft.id ?? newReceiptId`, which tied the key to
   * whether a read had succeeded; the persisted rule (ADR-0006:37-39) is what makes a retry after a
   * crash, a reload or a lost response land on the same receipt.
   */
  const [receiptKey, setReceiptKey] = useState<ReceiptKeyResolution | null>(null);
  const [localDraftPending, setLocalDraftPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [doneReceiptId, setDoneReceiptId] = useState<string | null>(null);
  const [invoiceSupplier, setInvoiceSupplier] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ReceiptConflictState | null>(null);
  const [conflictComplete, setConflictComplete] = useState(false);
  const [scan, setScan] = useState<BarcodeScanResult | null>(null);
  const [highlightItemId, setHighlightItemId] = useState<string | null>(null);
  const qtyInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const { data, loading, error } = useQuery(async () => {
    try {
      const order = toReceivingOrder(unwrap(await supabase.from('purchase_orders')
        .select('*, supplier:suppliers(id, name), items:purchase_order_items(*, product:products(id, name, unit, sku, barcode))')
        .eq('id', orderId!).single()) as ServerOrder);
      const draft = unwrap(await supabase.from('goods_receipts')
        .select('*, items:goods_receipt_items(*)').eq('order_id', orderId!).eq('status', 'draft').maybeSingle()) as
        ({ id: string; items: { order_item_id: string; qty_received: number; status: ReceiptLineStatus; notes: string | null }[] } | null);

      // Cached for offline viewing — the money-free projection only (see ReceivingOrder).
      await putOpenOrder({
        orderId: order.id, fetchedAt: Date.now(), supplierName: order.supplier.name,
        number: order.number, order,
      });

      // Delivery-note quantities, matched against this supplier's catalogue. Loaded with the order so
      // the two arrive together and the prefill never flashes the defaults first.
      let delivered: DeliveredMatch | null = null;
      if (documentId) {
        const [interpretation, catalogue] = await Promise.all([
          supabase.from('document_interpretations').select('payload, suggested_supplier_id')
            .eq('document_id', documentId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
          supabase.from('supplier_products').select('product_id, supplier_sku')
            .eq('supplier_id', order.supplier.id),
        ]);
        if (!interpretation.error && interpretation.data) {
          const payload = (interpretation.data as { payload: InterpretationContract }).payload;
          const supplierSkus = new Map(
            ((catalogue.data ?? []) as { product_id: string; supplier_sku: string | null }[])
              .map((row) => [row.product_id, row.supplier_sku]),
          );
          const entries = order.items.map((item) => ({
            productId: item.product_id,
            supplierSku: supplierSkus.get(item.product_id) ?? null,
            sku: item.product.sku,
            barcode: item.product.barcode,
            name: item.product.name,
          }));
          const matchedQty = new Map<string, number>();
          const unmatched: string[] = [];
          for (const line of deliveryNoteLines(payload)) {
            const productId = matchDeliveryLineProduct(line, entries);
            if (productId && line.quantity !== null) {
              matchedQty.set(productId, (matchedQty.get(productId) ?? 0) + line.quantity);
            } else {
              unmatched.push(line.description || line.sku || `שורה ${line.sourceRow ?? '—'}`);
            }
          }
          delivered = {
            matchedQty,
            unmatched,
            supplierMismatch: (interpretation.data as { suggested_supplier_id: string | null })
              .suggested_supplier_id !== null
              && (interpretation.data as { suggested_supplier_id: string | null }).suggested_supplier_id !== order.supplier.id,
          };
        }
      }
      return { order, draft, delivered, fromDevice: false, readAt: null as number | null, stale: false };
    } catch (serverError) {
      const cached = await getOpenOrder(orderId!);
      if (!cached) throw serverError;
      // A previously downloaded order, shown with its age. Nothing about the server draft or the
      // delivery note is known offline, and neither is invented.
      return {
        order: cached.order as ReceivingOrder,
        draft: null,
        delivered: null,
        fromDevice: true,
        readAt: cached.fetchedAt,
        stale: isOpenOrderStale(cached),
      };
    }
  }, [orderId, documentId]);

  /**
   * Hydration order, most-authoritative first:
   *   1. an **unsynced local draft** — a person's own work that has not reached the server yet;
   *   2. the **server draft** — the same person's earlier work, already accepted;
   *   3. the **delivery note**;
   *   4. the remaining ordered quantity.
   * (1) outranks (2) for the same reason (2) has always outranked (3): later human input wins over
   * an earlier record, and losing unsent work would be the worst outcome of the three.
   *
   * This is also where the idempotency key is resolved — once, at draft creation.
   */
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    (async () => {
      const local = await getReceiptDraft(data.order.id);
      const localLines = local && local.syncedAt === null
        ? new Map(local.lines.map((line) => [line.order_item_id, line]))
        : null;
      const init: Record<string, LineState> = {};
      for (const item of data.order.items) {
        const remaining = Math.max(0, item.qty - item.received_qty);
        const localLine = localLines?.get(item.id);
        if (localLine) {
          init[item.id] = { qty: localLine.qty_received, status: localLine.status, notes: localLine.notes ?? '' };
          continue;
        }
        const draftLine = data.draft?.items.find((d) => d.order_item_id === item.id);
        if (draftLine) {
          init[item.id] = { qty: draftLine.qty_received, status: draftLine.status, notes: draftLine.notes ?? '' };
          continue;
        }
        const delivered = data.delivered?.matchedQty.get(item.product_id);
        const qty = delivered ?? remaining;
        init[item.id] = {
          qty,
          status: delivered === undefined ? 'full' : qty === 0 ? 'missing' : qty < remaining ? 'partial' : 'full',
          notes: '',
        };
      }
      if (cancelled) return;
      setLines(init);
      if (local) setOpenCredits(local.openCredits);
      setLocalDraftPending(!!local && local.syncedAt === null);
      const resolution = await ensureReceiptKey({
        orderId: data.order.id,
        // Only a successful server read can contribute the server draft's id; offline this is null
        // and a device UUID is minted. Either way the stored value is the key from here on.
        serverDraftId: data.draft?.id ?? null,
        lines: toOfflineLines(data.order.items, init),
        openCredits: local?.openCredits ?? true,
      });
      if (!cancelled) setReceiptKey(resolution);
    })();
    return () => { cancelled = true; };
  }, [data]);

  const order = data?.order;

  const progress = useMemo(() => {
    if (!order) return { done: 0, total: 0 };
    return { done: Object.keys(lines).length, total: order.items.length };
  }, [order, lines]);

  const scanEntries = useMemo(() => (order?.items ?? []).map((item) => ({
    productId: item.product_id,
    orderItemId: item.id,
    // A synthetic barcode-only line never reaches the supplier-catalogue or sku branches of
    // matchDeliveryLineProduct, so there is nothing to look up here and nothing is faked.
    supplierSku: null,
    sku: item.product.sku,
    barcode: item.product.barcode,
    name: item.product.name,
  })), [order]);

  const onScan = useCallback((result: BarcodeScanResult) => {
    setScan(result);
    // A code identifies a line. It never sets a quantity, and an ambiguous or unknown code
    // selects nothing at all (OPEN-DECISIONS #102).
    setHighlightItemId(result.kind === 'match' ? result.orderItemId : null);
  }, []);

  useEffect(() => {
    if (!highlightItemId) return;
    const input = qtyInputs.current[highlightItemId];
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    input?.focus();
  }, [highlightItemId]);

  function setLine(itemId: string, patch: Partial<LineState>, item?: ReceivingItem) {
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

  function currentLines(): OfflineReceiptLine[] {
    return toOfflineLines(order?.items ?? [], lines);
  }

  async function send(complete: boolean, payloadLines: OfflineReceiptLine[], reason: string) {
    if (!order || !receiptKey) return;
    const observedAt = Date.now();
    const payload: SaveGoodsReceiptPayload = {
      p_order_id: order.id,
      p_receipt_id: receiptKey.receiptId,
      p_complete: complete,
      p_notes: null,
      p_open_credits: openCredits,
      p_lines: payloadLines,
      p_reason: reason,
    };
    // Stored before sent: whatever happens to the network afterwards, the device keeps what the
    // person saw. `observedAt` is the moment of this save — the moment they asserted what arrived.
    const existing = await getReceiptDraft(order.id);
    await putReceiptDraft({
      orderId: order.id,
      receiptId: receiptKey.receiptId,
      keySource: receiptKey.keySource,
      lines: payloadLines,
      openCredits,
      notes: null,
      observedAt,
      updatedAt: observedAt,
      syncedAt: null,
      completed: existing?.completed ?? false,
    });
    setLocalDraftPending(true);

    const outcome = await offlineQueue.submitReceipt({
      orderId: order.id,
      orderLabel: `${order.supplier.name} · הזמנה #${order.number ?? '—'}`,
      payload,
      observedAt,
    });

    switch (outcome.kind) {
      case 'sent':
        setLocalDraftPending(false);
        if (complete) {
          // The receipt is closed: its local draft has nothing left to protect.
          await deleteReceiptDraft(order.id);
          setDoneReceiptId(outcome.receiptId);
          setInvoiceSupplier(order.supplier.id);
          toast('הקבלה הושלמה');
        } else {
          toast('נשמרה טיוטת קבלה — אפשר להמשיך מאוחר יותר');
          navigate('/receiving');
        }
        return;
      case 'queued':
        setConflict(null);
        toast(outcome.reason);
        if (!complete) navigate('/receiving');
        return;
      case 'conflict':
        setConflictComplete(complete);
        toast(outcome.message, 'error');
        setConflict(await loadReceiptConflict({
          orderId: order.id,
          receiptId: receiptKey.receiptId,
          orderNumber: order.number,
          supplierName: order.supplier.name,
          localLines: payloadLines,
          products: new Map(order.items.map((item) => [item.id, { name: item.product.name, unit: item.product.unit }])),
          localObservedAt: observedAt,
          code: outcome.code,
        }));
        return;
      case 'rejected':
        toast(outcome.message, 'error');
        return;
    }
  }

  async function save(complete: boolean) {
    if (!order || !receiptKey) return;
    setBusy(true);
    try {
      await send(complete, currentLines(), complete ? REASON_COMPLETE : REASON_DRAFT);
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function resolveConflict(resolution: ReceiptConflictResolution) {
    if (!order || !receiptKey) return;
    setBusy(true);
    try {
      if (resolution.kind === 'keep-local') {
        setConflict(null);
        toast('הטיוטה נשמרה במכשיר. אפשר להכריע מאוחר יותר.');
        return;
      }
      if (resolution.kind === 'discard-local') {
        const queued = offlineQueue.getSnapshot().actions
          .find((action) => action.idempotencyKey === receiptKey.receiptId);
        if (queued) await offlineQueue.discardAction(queued.id);
        await deleteReceiptDraft(order.id);
        setConflict(null);
        setLocalDraftPending(false);
        toast('הטיוטה המקומית נמחקה. הנתונים בשרת נשארו כפי שהם.');
        navigate('/receiving');
        return;
      }
      const base = conflictComplete ? REASON_COMPLETE : REASON_DRAFT;
      setConflict(null);
      await send(conflictComplete, resolution.lines, `${base} · הכרעת קונפליקט: ${resolution.explanation}`);
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <RecordSkeleton />;
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
    // Reserves both fixed bars on a phone (contextual taskbar + the global capture bar G1 kept
    // here), and only the taskbar from 64rem up, where the action bar is `lg:hidden`.
    <div className="max-w-xl mx-auto space-y-3 pb-52 lg:pb-28">
      <div>
        <RecordHeader
          breadcrumbs={<Breadcrumbs items={[{ label: 'קבלת סחורה', to: '/receiving' }, { label: `הזמנה #${order.number}` }]} />}
          title={<span className="flex items-center gap-2"><PackageCheck size={22} /> קבלת סחורה</span>}
          status={<StatusBadge meta={PO_STATUS[order.status]} />}
          meta={<><span>{order.supplier.name}</span><span className="num">הזמנה #{order.number}</span><span className="num">{progress.done} מתוך {progress.total} פריטים עודכנו</span></>} />
        {data?.draft && <div className="mt-1 text-xs text-await-fg">נטענה טיוטת קבלה שנשמרה קודם</div>}
        {localDraftPending && <div className="mt-1 text-xs font-medium text-alert-fg" data-testid="receiving-local-draft">טיוטה מקומית — נשמרה במכשיר וטרם סונכרנה</div>}
        {receiptKey && !receiptKey.persisted && (
          <div className="mt-1 text-xs text-alert-fg">
            לא ניתן לשמור טיוטה במכשיר הזה. אין להסתמך על עבודה לא-מקוונת כאן.
          </div>
        )}
      </div>

      <OfflineQueueStatus />

      {data?.fromDevice && (
        <Note tone={data.stale ? 'alert' : 'await'}>
          ההזמנה מוצגת מהמכשיר. נקראה ב<span className="num">{fmtDateTime(data.readAt ? new Date(data.readAt) : null)}</span>
          {data.stale && ' — מעל 24 שעות, ייתכן שהכמויות בשרת השתנו מאז'}. הקבלה תישלח כשיהיה חיבור.
        </Note>
      )}

      {scanEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Rendered unconditionally: the component itself is the flag boundary and returns null
              while `receiving.barcode` is off, unknown or still loading (fail-closed). */}
          <BarcodeScanControl entries={scanEntries} onPick={onScan} />
          {scan && scan.kind !== 'match' && (
            <span className="text-xs text-ink-muted">
              קוד אחרון שנסרק: <span className="num">{scan.code}</span> — לא נבחרה שורה.
              {/* G1, finding 6. An unrecognised code ended here, with no suggestion — while the
                  price-list review screen offers "יצירת מוצר חדש מהשורה" on every unmatched row
                  (PriceListReviewConfirmation.tsx:533) and RLS lets `kitchen` add a product
                  (0022:131-132). So this was a missing door, not a fence. The link is the step;
                  quick-create in place depends on finding 5 and is not worth it alone. The second
                  half is the honest limit: a product created now is still not on THIS order, so
                  the receipt cannot take it either. */}
              {scan.kind === 'none' && (
                <>
                  {' '}הקוד אינו מוכר בשורות ההזמנה. אם המוצר חסר בקטלוג אפשר להוסיף אותו במסך{' '}
                  <Link className="link" to="/products">מוצרים</Link>{' '}— אך מוצר שנוסף עכשיו עדיין אינו חלק מההזמנה הזו,
                  ולכן לא ניתן לקלוט אותו בקבלה הנוכחית.
                </>
              )}
            </span>
          )}
        </div>
      )}

      {/* What the delivery note could and could not place. An unmatched line is named rather than
          counted: a product the catalogue cannot identify still arrived, and leaving it as a silent
          zero would read as "nothing came" instead of "nobody knows what this is". */}
      {data?.delivered && (
        <Note tone={data.delivered.supplierMismatch ? 'alert' : data.delivered.unmatched.length ? 'await' : 'info'}>
          <div className="space-y-1">
            {data.delivered.supplierMismatch && (
              <div className="font-medium">שים לב: תעודת המשלוח שויכה לספק אחר מספק ההזמנה. בדוק שזו ההזמנה הנכונה.</div>
            )}
            {data?.draft
              ? <div>נטענה טיוטה שנשמרה קודם, ולכן הכמויות שבה גוברות על תעודת המשלוח.</div>
              : <div>
                  הכמויות מולאו מתעודת המשלוח עבור <span className="num">{data.delivered.matchedQty.size}</span> פריטים.
                  שאר השורות נשארו בכמות שהוזמנה. בדוק מול הסחורה שהגיעה בפועל לפני שמירה.
                </div>}
            {/* #116, decided 09.08.2026 — G1 left this paragraph action-less because no manual
                exception command existed and promising one would have lied. The command exists
                now (open_manual_exception, 0087), owner/office only: they get the button, and
                kitchen — the role actually standing at the truck — gets the true next step
                (report to them) instead of a control that would refuse on submit. */}
            {data.delivered.unmatched.length > 0 && (
              <div>
                שורות בתעודה שלא זוהו במחירון הספק ולכן לא מולאו: {data.delivered.unmatched.join(', ')}.
                <span className="block mt-1">
                  פריט שהגיע ואינו בהזמנה אינו יכול להתווסף לקבלה הזו — הקבלה נשמרת מול שורות ההזמנה בלבד.
                  {canOpenException
                    ? ' אפשר לפתוח חריג לבירור — הוא יופיע במסך החריגים בשיוך למנהל הרכש.'
                    : ' יש לרשום את הפער בהערה של שורה קרובה ולעדכן את מנהל הרכש — פתיחת חריג לבירור זמינה למנהל ולמנהל הרכש בלבד.'}
                </span>
                {canOpenException && (
                  <button className="btn-secondary mt-2" onClick={() => setExceptionOpen(true)}>
                    פתיחת חריג לבירור
                  </button>
                )}
              </div>
            )}
          </div>
        </Note>
      )}

      {order.items.map((item) => {
        const line = lines[item.id];
        if (!line) return null;
        const remaining = Math.max(0, item.qty - item.received_qty);
        const scanned = highlightItemId === item.id;
        return (
          <div key={item.id} className={`card p-4 border-2 ${CARD[RECEIPT_LINE_STATUS[line.status].tone]} ${scanned ? 'ring-2 ring-action-line' : ''}`}>
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
                ref={(element) => { qtyInputs.current[item.id] = element; }}
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
        פתיחת דרישות זיכוי אוטומטית לחוסרים, לפריטים פגומים ולהחזרות
      </label>
      {/* #49, decided 09.08.2026: damaged/returned joined the same automation (0087). The
          credit is the full unusable quantity at the order's snapshot price. */}
      <p className="px-1 text-xs text-ink-muted">פריט פגום או שהוחזר אינו נספר כאספקה תקינה; כשהתיבה מסומנת נפתחת עליו דרישת זיכוי אוטומטית לפי מחיר ההזמנה.</p>
      {/* sticky action bar */}
      <div className="phone-taskbar fixed inset-x-0 lg:ms-60 bg-surface border-t border-line p-3 flex gap-2 z-30">
        {busy && <span className="sr-only" role="status" aria-live="polite">שומר את הקבלה</span>}
        {/* Rewritten with finding 7: the camera is no longer suppressed on this route, so "צילום
            החשבונית יתאפשר מיד לאחר סיום הקבלה" became false the moment the FAB kept its capture
            action. What is still true is the narrower claim — the shot taken now lands in the
            documents folder unattached, and it is the completion screen that ties it to THIS
            receipt. Saying only that keeps the sentence honest in both directions. */}
        <div className="hidden sm:flex items-center text-xs text-ink-muted me-auto ps-2">
          <Camera size={14} className="me-1" /> אפשר לצלם עכשיו — הצילום נשמר בתיקיית המסמכים; צירופו לקבלה זו מיד לאחר סיומה
        </div>
        <button className="btn-secondary flex-1 sm:flex-none" disabled={busy || !receiptKey} onClick={() => void save(false)}>
          <Save size={15} /> שמירת ביניים
        </button>
        <button className="btn-primary flex-1 sm:flex-none px-6!" disabled={busy || !receiptKey} onClick={() => void save(true)}>
          <CheckCircle2 size={16} /> סיום קבלה ({progress.total} פריטים)
        </button>
      </div>

      <ReceiptConflictDialog conflict={conflict} busy={busy}
        onClose={() => setConflict(null)}
        onResolve={(resolution) => void resolveConflict(resolution)} />

      <ConfirmDialog open={exceptionOpen} onClose={() => setExceptionOpen(false)}
        onConfirm={(reason) => void openManualException(reason ?? '')}
        title="פתיחת חריג לבירור"
        message={`ייפתח חריג "פריט שלא הוזמן" על הזמנה #${order?.number ?? ''}. הוא יופיע במסך החריגים בשיוך למנהל הרכש.`}
        confirmLabel="פתיחת חריג" requireReason busy={exceptionBusy} />
    </div>
  );

  async function openManualException(reason: string) {
    setExceptionBusy(true);
    const res = await supabase.rpc('open_manual_exception', {
      p_entity_type: 'purchase_orders',
      p_entity_id: orderId,
      p_type: 'item_not_ordered',
      p_reason: reason,
    });
    setExceptionBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    setExceptionOpen(false);
    toast((res.data as { idempotent?: boolean } | null)?.idempotent
      ? 'כבר קיים חריג פתוח על ההזמנה הזו — לא נפתח חריג כפול'
      : 'החריג נפתח ויופיע במסך החריגים');
  }
}

/** The exact `p_lines` array the RPC takes, from the screen's line state. */
function toOfflineLines(
  items: readonly { id: string }[],
  lines: Record<string, LineState>,
): OfflineReceiptLine[] {
  return items.map((item) => ({
    order_item_id: item.id,
    qty_received: lines[item.id]?.qty ?? 0,
    status: lines[item.id]?.status ?? 'full',
    notes: lines[item.id]?.notes.trim() || null,
  }));
}

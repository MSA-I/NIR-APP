import { useT } from '../lib/i18n/LocaleProvider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { PackageCheck, Save, CheckCircle2, FileText, Camera, ChevronDown } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { Breadcrumbs, Card, useToast, StatusBadge, EmptyState, ErrorNote, PageHeader, RecordHeader, RecordSkeleton, SkeletonList, Note, ConfirmDialog, Stepper, ICON } from '../components/ui';
import { useAuth } from '../auth/AuthContext';
import { DocumentList } from '../components/FileUpload';
import { deliveryNoteLines, matchDeliveryLineProduct } from '../components/document-review/model';
import BarcodeScanControl, { type BarcodeScanResult } from '../components/BarcodeScanner';
import OfflineQueueStatus from '../components/OfflineQueueStatus';
import ReceiptConflictDialog, {
  loadReceiptConflict, type ReceiptConflictResolution, type ReceiptConflictState,
} from '../components/ReceiptConflictDialog';
import { PO_STATUS, RECEIPT_LINE_STATUS, type Tone } from '../lib/status';
import { fmtDate, fmtDateTime, formatQuantity, productLabel, todayISO } from '../lib/format';
import {
  claimLegacyReceiptRecovery, createReceiptDraftAutosaver, ensureReceiptKey, getOpenOrder, getReceiptDraft,
  inspectLegacyReceiptRecovery, isOpenOrderStale,
  listOpenOrders, listUnsyncedDraftOrderIds, putOpenOrder,
  type OfflineReceiptLine, type ReceiptKeyResolution, type SaveGoodsReceiptPayload,
} from '../lib/offlineDb';
import { offlineQueue, useOfflineQueue } from '../lib/offlineQueue';
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
interface ReceivingProduct {
  id: string;
  /** The raw catalogue name. Matching a delivery-note line reads THIS, never the approved one. */
  name: string;
  display_name: string | null;
  unit: string;
  sku: string | null;
  barcode: string | null;
}
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
    product: { id: string; name: string; display_name: string | null; unit: string; sku: string | null; barcode: string | null };
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
        id: item.product.id, name: item.product.name, display_name: item.product.display_name, unit: item.product.unit,
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

/**
 * One line's opening value, resolved from the four sources in order of authority.
 *
 * Extracted from the effect below so it can be pinned by a test. The case that made that worth
 * doing: since 0090 a draft may be opened by the machine from a delivery note, and such a draft
 * carries ONLY the lines whose sku or barcode matched a product on the order. Every other ordered
 * line has no draft row at all and must still appear, at its remaining quantity — a line that
 * silently vanished from this map would be a line the receiving screen never asks about, and an
 * order that can never be completed.
 */
export function hydrateReceiptLines(input: {
  items: { id: string; product_id: string; qty: number; received_qty: number }[];
  localLines: Map<string, { qty_received: number; status: ReceiptLineStatus; notes: string | null }> | null;
  draftLines: { order_item_id: string; qty_received: number; status: ReceiptLineStatus; notes: string | null }[] | null;
  deliveredQty: Map<string, number> | null;
}): Record<string, LineState> {
  const init: Record<string, LineState> = {};
  for (const item of input.items) {
    const remaining = Math.max(0, item.qty - item.received_qty);
    const localLine = input.localLines?.get(item.id);
    if (localLine) {
      init[item.id] = { qty: localLine.qty_received, status: localLine.status, notes: localLine.notes ?? '' };
      continue;
    }
    const draftLine = input.draftLines?.find((d) => d.order_item_id === item.id);
    if (draftLine) {
      init[item.id] = { qty: draftLine.qty_received, status: draftLine.status, notes: draftLine.notes ?? '' };
      continue;
    }
    const delivered = input.deliveredQty?.get(item.product_id);
    const qty = delivered ?? remaining;
    init[item.id] = {
      qty,
      status: delivered === undefined ? 'full' : qty === 0 ? 'missing' : qty < remaining ? 'partial' : 'full',
      notes: '',
    };
  }
  return init;
}

/** A draft the machine opened from a delivery note, and the evidence that picked this order. */
interface MachineDraft {
  orderMatchedBy: 'by_number' | 'by_items' | 'single_open_order';
  matchedCount: number;
  waitingCount: number;
}

function ReceivingOrderCard({ order, today, localDraft, machineDraft, onOpen }: {
  order: ReceivingListOrder;
  today: string;
  localDraft: boolean;
  machineDraft: MachineDraft | null;
  onOpen: () => void;
}) {
  const { t } = useT();
  const attentionReason = order.status === 'partial'
    ? t('receiving.text')
    : order.expected_date && order.expected_date < today
      ? t('receiving.text_2')
      : order.expected_date === today
        ? t('receiving.text_3')
        : null;

  return (
    <button onClick={onOpen}
      className="card card-link-hover w-full text-start p-4 focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-ink text-base">{order.supplier.name}</div>
        <StatusBadge meta={PO_STATUS[order.status]} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-ink-muted">
        <span>{t('receiving.text_4')} <span className="num">#{order.number}</span></span>
        <span className="num">{order.items.length} פריטים</span>
        {order.expected_date && <span>אספקה: {fmtDate(order.expected_date)}</span>}
      </div>
      {attentionReason && <div className="mt-2 text-xs font-medium text-await-fg">{attentionReason}</div>}
      {/* A receipt recorded on this device that the server has not accepted yet. Shown on the card
          because the person who typed it needs to see it from the list, not only after opening. */}
      {localDraft && <div className="mt-1 text-xs font-medium text-alert-fg">{t('receiving.text_5')}</div>}
      {machineDraft && (
        <div className="mt-1 text-xs font-medium text-await-fg">
          טיוטה אוטומטית מתעודת משלוח — {machineDraft.matchedCount} שורות מוכנות לאישור
          {machineDraft.waitingCount > 0 && `, ${machineDraft.waitingCount} ממתינות`}
          {/* Named, not hidden. This is the tier that picked the order because it was the only one
              open — a real link, on the weakest evidence of the three, and the person standing at
              the delivery is the only one who can see whether it is the right order. */}
          {machineDraft.orderMatchedBy === 'single_open_order'
            && t('receiving.text_6')}
        </div>
      )}
    </button>
  );
}

/* ============ List of orders awaiting receiving — mobile-first cards ============ */
export function ReceivingList() {
  const { statusLabel, t } = useT();
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

  // Which of these orders already carry a draft the machine opened. Read from the decision ledger
  // rather than from goods_receipts, because a draft's own row cannot say who opened it —
  // save_goods_receipt leaves received_by null until completion (0023:1644), so a human's draft
  // and a machine's draft are byte-identical on that column.
  //
  // The ledger alone is not enough, though: a decision stays `draft_created` forever, while the
  // draft it opened stops existing the moment a person completes it (and reversal is the only
  // path that stamps reverted_at). Intersecting with the live drafts keeps the card honest — a
  // badge saying "מוכנות לאישור" over a receipt that was already completed is a claim about work
  // that no longer exists.
  const { data: machineDrafts } = useQuery(async () => {
    const [decisions, liveDrafts] = await Promise.all([
      supabase.from('delivery_note_interpretation_decisions')
        .select('order_id, order_matched_by, matched_count, waiting_count')
        .eq('outcome', 'draft_created')
        .is('reverted_at', null),
      supabase.from('goods_receipts').select('order_id').eq('status', 'draft'),
    ]);
    // `?? []`: a null body with no error is "no rows", not a crash — PostgREST never sends it for
    // a list select, but the browser gate's receiving scenario stubs goods_receipts with
    // `json: null` (check-browser-smoke.cjs), and a badge query must degrade to "no badge".
    const rows = (unwrap(decisions) ?? []) as {
      order_id: string;
      order_matched_by: MachineDraft['orderMatchedBy'];
      matched_count: number;
      waiting_count: number;
    }[];
    const stillDraft = new Set(((unwrap(liveDrafts) ?? []) as { order_id: string }[]).map((d) => d.order_id));
    return new Map(rows.filter((row) => stillDraft.has(row.order_id)).map((row) => [row.order_id, {
      orderMatchedBy: row.order_matched_by,
      matchedCount: row.matched_count,
      waitingCount: row.waiting_count,
    }]));
  });

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
          <span className="min-w-0 flex-1">
            הרשימה מוצגת מהמכשיר, לא מהשרת. נקראה לאחרונה ב<span className="num">{fmtDateTime(data.readAt ? new Date(data.readAt) : null)}</span>
            {data.stale && t('receiving.text_7')}. מופיעות כאן רק הזמנות שנפתחו במכשיר הזה בעבר.
          </span>
        </Note>
      )}
      {documentId && (
        <Note tone={source ? 'await' : 'alert'}>
          {source
            ? <>קליטה מתעודת המשלוח {source.fileName ? <strong>{source.fileName}</strong> : t('receiving.text_8')}
                {supplierName ? <> {t('receiving.text_9')} <strong>{supplierName}</strong></> : null}. בחר את ההזמנה שאליה הסחורה הגיעה — הכמויות ימולאו מהתעודה.</>
            : t('receiving.text_10')}
        </Note>
      )}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <label className="sr-only" htmlFor="receiving-search">{t('receiving.text_11')}</label>
          <input id="receiving-search" type="search" className="input min-h-11"
            placeholder={t('receiving.placeholder')}
            value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <select className="input min-h-11 sm:w-auto!" aria-label={t('receiving.aria_label')}
          value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="all">{t('receiving.text_12')}</option>
          <option value="attention">{t('receiving.text_13')}</option>
          {/* Read from PO_STATUS rather than retyped, so the filter cannot drift from the badge
              beside it — which is exactly what happened to "נשלחה" before it became "נשלחה לספק". */}
          <option value="sent">{statusLabel(PO_STATUS.sent)}</option>
          <option value="confirmed">{statusLabel(PO_STATUS.confirmed)}</option>
          <option value="partial">{statusLabel(PO_STATUS.partial)}</option>
        </select>
      </div>

      {!orders.length ? (
        <div className="card"><EmptyState title="אין הזמנות שממתינות לקבלה" subtitle={`הזמנות בסטטוס ${statusLabel(PO_STATUS.sent)} / ${statusLabel(PO_STATUS.confirmed)} יופיעו כאן`} /></div>
      ) : !filtered.length ? (
        <div className="card"><EmptyState title={t('receiving.title')} subtitle={t('receiving.subtitle')} /></div>
      ) : !focusedQueue ? (
        // section, not div: aria-label on a roleless div is dropped by screen readers, so this list
        // of results arrived unnamed. Matches the labelled section in the focused-queue branch below.
        <section className="space-y-3" aria-label={t('receiving.aria_label_2')}>
          {filtered.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} localDraft={isLocalDraft(order.id)} machineDraft={machineDrafts?.get(order.id) ?? null} onOpen={() => openOrder(order.id)} />)}
        </section>
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="receiving-attention-title">
            <div className="flex items-center justify-between gap-2">
              <h2 id="receiving-attention-title" className="section-title">{t('receiving.text_14')}</h2>
              <span className="badge-await num">{attention.length}</span>
            </div>
            {attention.length
              ? attention.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} localDraft={isLocalDraft(order.id)} machineDraft={machineDrafts?.get(order.id) ?? null} onOpen={() => openOrder(order.id)} />)
              : <div className="card"><EmptyState title={t('receiving.title_2')} subtitle={t('receiving.subtitle_2')} icon={<PackageCheck size={ICON.hero} />} /></div>}
          </section>

          {remaining.length > 0 && (
            <>
              <details className="group sm:hidden">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg px-2 text-sm font-medium text-action hover:bg-surface-hover active:bg-surface-selected focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
                  הצג הכל ({filtered.length})
                  <ChevronDown size={ICON.sm} className="transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
                </summary>
                <div className="space-y-3 pt-2">
                  {remaining.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} localDraft={isLocalDraft(order.id)} machineDraft={machineDrafts?.get(order.id) ?? null} onOpen={() => openOrder(order.id)} />)}
                </div>
              </details>
              <section className="hidden space-y-3 sm:block" aria-labelledby="receiving-other-title">
                <h2 id="receiving-other-title" className="section-title">{t('receiving.text_15')}</h2>
                {remaining.map((order) => <ReceivingOrderCard key={order.id} order={order} today={today} localDraft={isLocalDraft(order.id)} machineDraft={machineDrafts?.get(order.id) ?? null} onOpen={() => openOrder(order.id)} />)}
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

const REASON_COMPLETE_KEY = 'receiving.text_16';
const REASON_DRAFT_KEY = 'receiving.text_17';

export function ReceiveOrder() {
  const { errorText, locale, t } = useT();
  const { orderId } = useParams<{ orderId: string }>();
  const [params] = useSearchParams();
  const documentId = params.get('document');
  const navigate = useNavigate();
  const toast = useToast();
  const { profile } = useAuth();
  const [lines, setLines] = useState<Record<string, LineState>>({});
  const [openCredits, setOpenCredits] = useState(true);
  // A manual exception is an owner/office command.
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
  const [donePendingSync, setDonePendingSync] = useState(false);
  const offlineSnapshot = useOfflineQueue();

  useEffect(() => {
    if (!donePendingSync || !doneReceiptId || offlineSnapshot.lastSuccessfulSyncAt === null) return;
    if (!offlineSnapshot.actions.some((action) => action.idempotencyKey === doneReceiptId)) {
      setDonePendingSync(false);
    }
  }, [donePendingSync, doneReceiptId, offlineSnapshot.actions, offlineSnapshot.lastSuccessfulSyncAt]);

  const [conflict, setConflict] = useState<ReceiptConflictState | null>(null);
  const [conflictComplete, setConflictComplete] = useState(false);
  const [conflictQueueRef, setConflictQueueRef] = useState<{ id: number; syncVersion: number } | null>(null);
  const [scan, setScan] = useState<BarcodeScanResult | null>(null);
  const [highlightItemId, setHighlightItemId] = useState<string | null>(null);
  const [recoveringLegacy, setRecoveringLegacy] = useState(false);
  const qtyInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const draftAutosaver = useRef(createReceiptDraftAutosaver());
  const lastDraftFingerprint = useRef<string | null>(null);

  const { data, loading, error, refetch } = useQuery(async () => {
    try {
      const order = toReceivingOrder(unwrap(await supabase.from('purchase_orders')
        .select('*, supplier:suppliers(id, name), items:purchase_order_items(*, product:products(id, name, display_name, unit, sku, barcode))')
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
          // MATCHING, not display. The name here is compared against what the delivery note says,
          // and a note says whatever the supplier wrote. The raw name is what that was ever
          // matched against; an approved name we composed would only stop matching.
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
      const legacyRecovery = await inspectLegacyReceiptRecovery(order.id);
      return { order, draft, delivered, fromDevice: false, readAt: null as number | null, stale: false, legacyRecovery };
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
        legacyRecovery: null,
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
    if (data.legacyRecovery) {
      setReceiptKey(null);
      setLocalDraftPending(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const local = await getReceiptDraft(data.order.id);
      const queueState = await offlineQueue.refresh();
      const localLines = local && local.syncedAt === null
        ? new Map(local.lines.map((line) => [line.order_item_id, line]))
        : null;
      const init = hydrateReceiptLines({
        items: data.order.items,
        localLines,
        draftLines: data.draft?.items ?? null,
        deliveredQty: data.delivered?.matchedQty ?? null,
      });
      if (cancelled) return;
      setLines(init);
      if (local) setOpenCredits(local.openCredits);
      setLocalDraftPending(!!local && local.syncedAt === null);
      if (local?.completed && queueState?.actions.some((action) => (
        action.idempotencyKey === local.receiptId && action.complete && action.state !== 'conflict'
      ))) {
        setDoneReceiptId(local.receiptId);
        setDonePendingSync(true);
      }
      const resolution = await ensureReceiptKey({
        orderId: data.order.id,
        // Only a successful server read can contribute the server draft's id; offline this is null
        // and a device UUID is minted. Either way the stored value is the key from here on.
        serverDraftId: data.draft?.id ?? null,
        lines: toOfflineLines(data.order.items, init),
        openCredits: local?.openCredits ?? true,
      });
      if (cancelled) return;
      lastDraftFingerprint.current = JSON.stringify({
        lines: toOfflineLines(data.order.items, init),
        openCredits: local?.openCredits ?? true,
      });
      setReceiptKey(resolution);
      const queuedConflict = queueState.actions.find((action) => (
        action.idempotencyKey === resolution.receiptId && action.conflictCode
      ));
      if (queuedConflict?.conflictCode) {
        setConflictComplete(queuedConflict.complete);
        setConflictQueueRef({ id: queuedConflict.id, syncVersion: queuedConflict.syncVersion });
        const conflictLines = local?.lines ?? toOfflineLines(data.order.items, init);
        const products = new Map(data.order.items.map((item) => [
          item.id, { label: productLabel(item.product), unit: item.product.unit },
        ]));
        const hydratedConflict = await loadReceiptConflict({
          orderId: data.order.id,
          receiptId: resolution.receiptId,
          orderNumber: data.order.number,
          supplierName: data.order.supplier.name,
          localLines: conflictLines,
          products,
          localObservedAt: queuedConflict.observedAt,
          code: queuedConflict.conflictCode,
        }).catch((): ReceiptConflictState => ({
          code: queuedConflict.conflictCode!,
          orderId: data.order.id,
          orderNumber: data.order.number,
          supplierName: data.order.supplier.name,
          receiptId: resolution.receiptId,
          lines: conflictLines.map((line) => ({
            orderItemId: line.order_item_id,
            productName: products.get(line.order_item_id)?.label ?? '—',
            unit: products.get(line.order_item_id)?.unit ?? '',
            localQty: line.qty_received,
            localStatus: line.status,
            localNotes: line.notes,
            orderedQty: null,
            serverReceivedQty: null,
            serverRemaining: null,
            serverDraftQty: null,
          })),
          localObservedAt: queuedConflict.observedAt,
          serverReceiptId: null,
          serverReceiptStatus: null,
          serverReceiptAt: null,
          serverActorName: '—',
          serverOrderStatus: null,
          rereadError: t('receiving.text_18'),
        }));
        if (!cancelled) setConflict(hydratedConflict);
      }
    })();
    return () => { cancelled = true; };
  }, [data]);

  const order = data?.order;

  useEffect(() => {
    if (!order || !receiptKey || doneReceiptId
      || Object.keys(lines).length !== order.items.length) return;
    const offlineLines = toOfflineLines(order.items, lines);
    const fingerprint = JSON.stringify({ lines: offlineLines, openCredits });
    if (lastDraftFingerprint.current === fingerprint) return;
    lastDraftFingerprint.current = fingerprint;
    const observedAt = Date.now();
    void draftAutosaver.current.save({
      orderId: order.id,
      receiptId: receiptKey.receiptId,
      keySource: receiptKey.keySource,
      lines: offlineLines,
      openCredits,
      notes: null,
      observedAt,
      updatedAt: observedAt,
      syncedAt: null,
      completed: false,
    }).then(() => {
      setLocalDraftPending(true);
    }).catch((autosaveError) => {
      if (lastDraftFingerprint.current === fingerprint) lastDraftFingerprint.current = null;
      toast(errorText(autosaveError), 'error');
    });
  }, [doneReceiptId, lines, openCredits, order, receiptKey, toast]);

  useEffect(() => {
    if (!order || doneReceiptId) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const flushBeforeLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      event.stopPropagation();
      void draftAutosaver.current.flush().then(() => {
        navigate(`${url.pathname}${url.search}${url.hash}`);
      }).catch((saveError) => {
        toast(`${errorText(saveError)} לא ניתן לעבור מסך לפני שמירת טיוטת הקבלה.`, 'error');
      });
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', flushBeforeLink, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', flushBeforeLink, true);
    };
  }, [doneReceiptId, navigate, order, toast]);

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

  async function recoverLegacyWork() {
    if (!order || !data?.legacyRecovery) return;
    setRecoveringLegacy(true);
    try {
      const recovered = await claimLegacyReceiptRecovery(order.id);
      if (!recovered) throw new Error('legacy_receipt_recovery_missing');
      toast(t('receiving.toast'));
      await refetch();
    } catch (recoveryError) {
      toast(errorText(recoveryError), 'error');
    } finally {
      setRecoveringLegacy(false);
    }
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
    await draftAutosaver.current.save({
      orderId: order.id,
      receiptId: receiptKey.receiptId,
      keySource: receiptKey.keySource,
      lines: payloadLines,
      openCredits,
      notes: null,
      observedAt,
      updatedAt: observedAt,
      syncedAt: null,
      completed: (existing?.completed ?? false) || complete,
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
        setDonePendingSync(false);
        setLocalDraftPending(false);
        if (complete) {
          // Atomic queue finalization already deleted the exact accepted draft. Do not issue a
          // second unconditional delete here: another tab may have persisted a newer draft while
          // the server request was in flight, and the finalizer deliberately preserves that row.
          setDoneReceiptId(outcome.receiptId);
          toast(t('receiving.toast_2'));
        } else {
          toast(t('receiving.toast_3'));
          navigate('/receiving');
        }
        return;
      case 'queued':
        setConflict(null);
        toast(outcome.reason);
        if (complete) {
          setDonePendingSync(true);
          setDoneReceiptId(receiptKey.receiptId);
        } else navigate('/receiving');
        return;
      case 'conflict':
        setConflictComplete(complete);
        {
          const queuedConflict = offlineQueue.getSnapshot().actions.find((action) => (
            action.idempotencyKey === receiptKey.receiptId && action.state === 'conflict'
          ));
          setConflictQueueRef(queuedConflict
            ? { id: queuedConflict.id, syncVersion: queuedConflict.syncVersion }
            : null);
        }
        toast(outcome.message, 'error');
        setConflict(await loadReceiptConflict({
          orderId: order.id,
          receiptId: receiptKey.receiptId,
          orderNumber: order.number,
          supplierName: order.supplier.name,
          localLines: payloadLines,
          products: new Map(order.items.map((item) => [item.id, { label: productLabel(item.product), unit: item.product.unit }])),
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
      await send(complete, currentLines(), t(complete ? REASON_COMPLETE_KEY : REASON_DRAFT_KEY));
    } catch (e) {
      toast(errorText(e), 'error');
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
        toast(t('receiving.toast_4'));
        return;
      }
      if (resolution.kind === 'discard-local') {
        if (!conflictQueueRef) {
          toast(t('receiving.toast_5'), 'error');
          return;
        }
        const discarded = await offlineQueue.discardAction(
          conflictQueueRef.id, conflictQueueRef.syncVersion, 'conflict',
        );
        if (!discarded) {
          setConflict(null);
          setConflictQueueRef(null);
          toast(t('receiving.toast_6'), 'error');
          return;
        }
        setConflict(null);
        setConflictQueueRef(null);
        setLocalDraftPending(false);
        toast(t('receiving.toast_7'));
        navigate('/receiving');
        return;
      }
      const base = t(conflictComplete ? REASON_COMPLETE_KEY : REASON_DRAFT_KEY);
      setConflict(null);
      await send(conflictComplete, resolution.lines, `${base} · הכרעת קונפליקט: ${resolution.explanation}`);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <RecordSkeleton />;
  if (error || !order) return <ErrorNote message={error ?? t('receiving.text_19')} />;

  /* completion screen: attach invoice photo + optional invoice creation */
  if (doneReceiptId) {
    return (
      <div
        className="max-w-xl mx-auto space-y-4 text-center pt-6"
        data-testid="receiving-completion"
        data-sync-state={donePendingSync ? 'pending' : 'synced'}
      >
        <CheckCircle2 size={ICON.hero} className={donePendingSync ? 'text-await-fg mx-auto' : 'text-done-fg mx-auto'} />
        <h1 className="page-title">{donePendingSync ? t('receiving.text_20') : t('receiving.text_21')}</h1>
        <p className="text-sm text-ink-muted">{donePendingSync
          ? t('receiving.text_22')
          : t('receiving.text_23')}</p>
        <OfflineQueueStatus />
        <Card className="text-start">
          <DocumentList entityType="goods_receipt" entityId={doneReceiptId} capture />
        </Card>
        <div className="flex flex-col sm:flex-row gap-2 justify-center">
          {/* Was "הזנת חשבונית להזמנה זו" → /invoices/new (G1, 10.08.2026). Nobody at a delivery
              types an invoice; the invoice is a piece of paper in their hand. The capture control
              directly above this row already files it against this receipt, and the gallery is
              where it is read and approved. */}
          <button className="btn-primary" disabled={donePendingSync}
            onClick={() => navigate('/documents')}>
            <FileText size={ICON.sm} aria-hidden="true" /> לצילום החשבונית שהתקבלה
          </button>
          <button className="btn-secondary" onClick={() => navigate('/receiving')}>{t('receiving.navigate')}</button>
        </div>
      </div>
    );
  }

  const statusButtons: { key: ReceiptLineStatus; label: string }[] = [
    { key: 'full', label: t('receiving.text_24') }, { key: 'partial', label: t('receiving.text_25') }, { key: 'missing', label: t('receiving.text_26') },
    { key: 'damaged', label: t('receiving.text_27') }, { key: 'returned', label: t('receiving.text_28') },
  ];
  // Single source: the tone comes from RECEIPT_LINE_STATUS (lib/status.ts), so re-colouring
  // a status there recolours both the selected button and the card border here (§4.5).
  // The old amber-500 shade folds into await-solid, away from the off-by-one shade (§3.6ה).
  const SOLID: Record<Tone, string> = {
    done: 'bg-done-solid text-on-solid border-done-solid',
    await: 'bg-await-solid text-on-solid border-await-solid',
    alert: 'bg-alert-solid text-on-solid border-alert-solid',
    info: 'bg-info-solid text-on-solid border-info-solid',
    idle: 'bg-idle-solid text-on-solid border-idle-solid',
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
          title={<span className="flex items-center gap-2"><PackageCheck size={ICON.xl} aria-hidden="true" /> {t('receiving.text_29')}</span>}
          status={<StatusBadge meta={PO_STATUS[order.status]} />}
          meta={<><span>{order.supplier.name}</span><span>{t('receiving.text_30')} <span className="num">#{order.number}</span></span><span><span className="num">{progress.done}</span> {t('receiving.text_31')} <span className="num">{progress.total}</span> {t('receiving.text_32')}</span></>} />
        {data?.draft && <div className="mt-1 text-xs text-await-fg">{t('receiving.text_33')}</div>}
        {localDraftPending && <div className="mt-1 text-xs font-medium text-alert-fg" data-testid="receiving-local-draft">{t('receiving.text_34')}</div>}
        {receiptKey && !receiptKey.persisted && (
          <div className="mt-1 text-xs text-alert-fg">
            {t('receiving.text_35')}
          </div>
        )}
      </div>

      <OfflineQueueStatus />

      {data?.legacyRecovery && !data.fromDevice && (
        <Note tone="await">
          <div className="space-y-2">
            <p>
              {t('receiving.text_36')}
              {data.legacyRecovery.queuedActions > 0 && <> · <span className="num">{data.legacyRecovery.queuedActions}</span> {t('receiving.text_37')}</>}
              {data.legacyRecovery.pendingPhotos > 0 && <> · <span className="num">{data.legacyRecovery.pendingPhotos}</span> {t('receiving.text_38')}</>}.
              {t('receiving.text_39')}
            </p>
            <button type="button" className="btn-secondary" disabled={recoveringLegacy}
              onClick={() => void recoverLegacyWork()}>
              {recoveringLegacy ? t('receiving.text_40') : t('receiving.text_41')}
            </button>
          </div>
        </Note>
      )}

      {data?.fromDevice && (
        <Note tone={data.stale ? 'alert' : 'await'}>
          <span className="min-w-0 flex-1">
            ההזמנה מוצגת מהמכשיר. נקראה ב<span className="num">{fmtDateTime(data.readAt ? new Date(data.readAt) : null)}</span>
            {data.stale && t('receiving.text_42')}. הקבלה תישלח כשיהיה חיבור.
          </span>
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
                  (PriceListReviewConfirmation.tsx). The link is the step;
                  quick-create in place depends on finding 5 and is not worth it alone. The second
                  half is the honest limit: a product created now is still not on THIS order, so
                  the receipt cannot take it either. */}
              {scan.kind === 'none' && (
                <>
                  {' '}הקוד אינו מוכר בשורות ההזמנה. אם המוצר חסר בקטלוג אפשר להוסיף אותו במסך{' '}
                  <Link className="link" to="/products">{t('receiving.text_43')}</Link>{' '}— אך מוצר שנוסף עכשיו עדיין אינו חלק מההזמנה הזו,
                  {t('receiving.text_44')}
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
              <div className="font-medium">{t('receiving.text_45')}</div>
            )}
            {data?.draft
              ? <div>{t('receiving.text_46')}</div>
              : <div>
                  הכמויות מולאו מתעודת המשלוח עבור <span className="num">{data.delivered.matchedQty.size}</span> פריטים.
                  {t('receiving.text_47')}
                </div>}
            {/* #116, decided 09.08.2026 — G1 left this paragraph action-less because no manual
                exception command existed and promising one would have lied. The command exists
                now (open_manual_exception, 0087), owner/office only. */}
            {data.delivered.unmatched.length > 0 && (
              <div>
                שורות בתעודה שלא זוהו במחירון הספק ולכן לא מולאו: {data.delivered.unmatched.join(', ')}.
                <span className="block mt-1">
                  {t('receiving.text_48')}
                  {canOpenException
                    ? t('receiving.text_49')
                    : t('receiving.text_50')}
                </span>
                {canOpenException && (
                  <button className="btn-secondary mt-2" onClick={() => setExceptionOpen(true)}>
                    {t('receiving.text_51')}
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
                <div className="font-semibold text-ink"><bdi>{productLabel(item.product)}</bdi></div>
                <div className="text-xs text-ink-muted mt-0.5">
                  הוזמן: <span className="num">{formatQuantity(item.qty, item.product.unit, locale)}</span>
                  {item.received_qty > 0 && <> {t('receiving.formatQuantity')} <span className="num">{formatQuantity(item.received_qty, item.product.unit, locale)}</span></>}
                </div>
              </div>
              <StatusBadge meta={RECEIPT_LINE_STATUS[line.status]} />
            </div>

            <div className="flex items-center gap-2 mt-3">
              <span className="text-sm text-ink-soft w-16">{t('receiving.text_52')}</span>
              {/* The field keeps its own size. This is the number the screen exists to capture,
                  read at arm's length by someone holding a crate — a deliberate difference, not
                  drift, so convergence does not get to delete it. */}
              {/* The two button names are the screen's own sentences, not the primitive's
                  composition: „הגדלת הכמות שהתקבלה עבור X" names the action, the product AND what
                  the number means, which „הוספה — כמות שהתקבלה עבור X" only gestures at. They are
                  also what a screen-reader user on this screen has been hearing since the control
                  was hand-rolled here, and convergence had no mandate to change that. */}
              <Stepper value={line.qty} min={0} inputStep="any"
                inputClassName="w-24! text-lg! py-2.5! font-semibold"
                label={`כמות שהתקבלה עבור ${productLabel(item.product)}`}
                decrementLabel={`הפחתת הכמות שהתקבלה עבור ${productLabel(item.product)}`}
                incrementLabel={`הגדלת הכמות שהתקבלה עבור ${productLabel(item.product)}`}
                inputRef={(element) => { qtyInputs.current[item.id] = element; }}
                onChange={(next) => setLine(item.id, { qty: next }, item)} />
              {line.qty !== remaining && (
                <button type="button" className="btn-ghost btn-sm" aria-label={`סימון מלוא הכמות שנותרה עבור ${productLabel(item.product)}: ${formatQuantity(remaining, item.product.unit, locale)}`} onClick={() => setLine(item.id, { qty: remaining }, item)}>מלא ({formatQuantity(remaining, item.product.unit, locale)})</button>
              )}
            </div>

            <div className="grid grid-cols-5 gap-1.5 mt-3">
              {statusButtons.map((b) => (
                <button key={b.key}
                  className={`rounded-lg border min-h-11 flex items-center justify-center text-xs font-medium transition-colors ${line.status === b.key ? SOLID[RECEIPT_LINE_STATUS[b.key].tone] : 'border-line text-ink-soft hover:bg-surface-hover'}`}
                  aria-label={`${b.label} עבור ${productLabel(item.product)}`}
                  aria-pressed={line.status === b.key}
                  onClick={() => setLine(item.id, { status: b.key, ...(b.key === 'missing' ? { qty: 0 } : {}) })}>
                  {b.label}
                </button>
              ))}
            </div>

            {line.status !== 'full' && (
              <input className="input mt-2.5" placeholder={t('receiving.placeholder_2')}
                aria-label={`הערה לקבלת ${productLabel(item.product)}`}
                value={line.notes} onChange={(e) => setLine(item.id, { notes: e.target.value })} />
            )}
          </div>
        );
      })}

      <label className="flex items-center gap-2 text-sm text-ink-mid px-1">
        <input type="checkbox" className="rounded" checked={openCredits} onChange={(e) => setOpenCredits(e.target.checked)} />
        {t('receiving.text_53')}
      </label>
      {/* #49, decided 09.08.2026: damaged/returned joined the same automation (0087). The
          credit is the full unusable quantity at the order's snapshot price. */}
      <p className="px-1 text-xs text-ink-muted">{t('receiving.text_54')}</p>
      {/* sticky action bar */}
      {/* lg:ms-60 cleared with the sidebar (T7.1 top navigation): the bar spans the full width. */}
      <div className="phone-taskbar fixed inset-x-0 bg-surface border-t border-line p-3 flex gap-2 z-30">
        {busy && <span className="sr-only" role="status" aria-live="polite">{t('receiving.text_55')}</span>}
        {/* Rewritten with finding 7: the camera is no longer suppressed on this route, so "צילום
            החשבונית יתאפשר מיד לאחר סיום הקבלה" became false the moment the FAB kept its capture
            action. What is still true is the narrower claim — the shot taken now lands in the
            documents folder unattached, and it is the completion screen that ties it to THIS
            receipt. Saying only that keeps the sentence honest in both directions. */}
        <div className="hidden sm:flex items-center text-xs text-ink-muted me-auto ps-2">
          <Camera size={ICON.xs} className="me-1" aria-hidden="true" /> אפשר לצלם עכשיו — הצילום נשמר בתיקיית המסמכים; צירופו לקבלה זו מיד לאחר סיומה
        </div>
        <button className="btn-secondary flex-1 sm:flex-none" disabled={busy || !receiptKey} onClick={() => void save(false)}>
          <Save size={ICON.sm} aria-hidden="true" /> שמירת ביניים
        </button>
        <button type="button" className="btn-primary flex-1 sm:flex-none" disabled={busy || !receiptKey} onClick={() => void save(true)}>
          <CheckCircle2 size={ICON.sm} aria-hidden="true" /> סיום קבלה ({progress.total} פריטים)
        </button>
      </div>

      <ReceiptConflictDialog conflict={conflict} busy={busy}
        onClose={() => setConflict(null)}
        onResolve={(resolution) => void resolveConflict(resolution)} />

      <ConfirmDialog open={exceptionOpen} onClose={() => setExceptionOpen(false)}
        onConfirm={(reason) => void openManualException(reason ?? '')}
        title={t('receiving.title_3')}
        message={`ייפתח חריג "פריט שלא הוזמן" על הזמנה #${order?.number ?? ''}. הוא יופיע במסך החריגים בשיוך למנהל הרכש.`}
        confirmLabel={t('receiving.confirmLabel')} requireReason busy={exceptionBusy} />
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
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    setExceptionOpen(false);
    toast((res.data as { idempotent?: boolean } | null)?.idempotent
      ? t('receiving.text_56')
      : t('receiving.text_57'));
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

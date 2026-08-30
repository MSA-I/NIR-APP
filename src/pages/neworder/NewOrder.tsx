import { useT } from '../../lib/i18n/LocaleProvider';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Check, CheckCircle2, Clock3, Loader2, MessageCircle, XCircle } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useQuery, unwrap } from '../../lib/useQuery';
import { useAuth } from '../../auth/AuthContext';
import { ConfirmDialog, ErrorNote, Modal, RecordSkeleton, PageHeader, ICON, useToast } from '../../components/ui';
import { useCategories } from '../Suppliers';
import {
  cancelOrderDraft,
  finalizeOrderDraft,
  ORDER_DRAFT_FLUSH_EVENT,
  saveOrderDraft,
  type DraftItemInput,
  type OrderDraftFlushDetail,
} from '../../lib/orderDrafts';
import {
  resolveSplit,
  splitReducer,
  type CartState,
  type ResolutionOption,
  type SplitInput,
  type SplitLine,
} from '../../lib/orderSplit';
import { centsFromUnits, hundredths, lineUnits, moneyFromCents } from '../../lib/orderSavings';
import { deferProduct, dismissNextOrderItem, listNextOrderItems, type NextOrderItem } from '../../lib/nextOrderItems';
import { fmtMoneyExact, productLabel } from '../../lib/format';
import { NEW_COMMERCE_SUPPLIER_STATUSES } from '../../lib/status';
import { markOrderSentToSupplier } from '../../lib/share';
import { WhatsAppSendDialog } from '../../components/WhatsAppSendDialog';
import { QuickCreateProduct } from '../../components/QuickCreateProduct';
import type { Product, PurchaseOrder, Supplier, SupplierProduct } from '../../lib/types';
import ProductStep from './ProductStep';
import SupplierSplitStep from './SupplierSplitStep';
import SummaryStep from './SummaryStep';
import { SUPPLIER_COLUMNS } from '../../lib/supplierColumns';

interface CartItem extends SplitLine {
  product: Product;
}

const EMPTY_CART: CartState = { order: [], byId: {}, products: {} };

interface DraftRow {
  id: string;
  number: number;
  notes: string | null;
  expected_date: string | null;
  editor_step: number;
  updated_at: string;
  items: { product_id: string; qty: number; chosen_supplier_id: string | null; pinned_supplier_id: string | null; product: Product | null }[];
}

interface SourceOrder {
  supplier_id: string;
  notes: string | null;
  expected_date: string | null;
  items: { product_id: string; qty: number; product: Product | null }[];
}

type QueueOrder = PurchaseOrder & {
  supplier: { name: string; phone: string | null; whatsapp: string | null };
  items: { qty: number; unit_price: number; product: { name: string; unit: string; sku: string | null } }[];
};

interface DraftSnapshot {
  requestId: string | null;
  notes: string;
  expectedDate: string;
  editorStep: 1 | 2 | 3;
  items: DraftItemInput[];
}

interface PriceSnapshotLine {
  productId: string;
  productName: string;
  supplierId: string;
  supplierName: string;
  /** The supplier's own currency, which is the currency the line was priced in (0217). */
  currency: string;
  qty: number;
  assignmentMode: 'auto' | 'pinned';
}

interface PriceSnapshot {
  prices: Map<string, number>;
  lines: PriceSnapshotLine[];
  oldTotal: number | null;
}

interface PendingPriceDiff extends PriceSnapshot {
  refreshId: number;
  sourceOffers: readonly SupplierProduct[] | null;
}

interface PriceDiffLine extends PriceSnapshotLine {
  newSupplierId: string | null;
  newSupplierName: string;
  oldUnitPrice: number;
  newUnitPrice: number | null;
  oldLineTotal: number;
  newLineTotal: number | null;
  delta: number | null;
}

interface PriceDiffReport {
  lines: PriceDiffLine[];
  /**
   * The basket's one currency, or null when it holds more than one — in which case there is no
   * order total to compare, and `fmtMoneyExact` draws an em dash rather than a figure.
   */
  currency: string | null;
  oldTotal: number | null;
  newTotal: number | null;
}

const draftSignature = (draft: DraftSnapshot) => JSON.stringify([
  draft.notes.trim(), draft.expectedDate, draft.editorStep,
  draft.items.map((item) => [item.product_id, item.qty, item.chosen_supplier_id, item.pinned_supplier_id]),
]);

export default function NewOrder() {
  const { errorText, t } = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromOrderId = params.get('from');
  const explicitDraftId = params.get('draft');
  const startFresh = params.get('fresh') === '1';
  const loadKey = fromOrderId ? `from:${fromOrderId}` : explicitDraftId ? `draft:${explicitDraftId}` : startFresh ? 'fresh' : 'latest';
  const { profile, org, organizationAccess } = useAuth();
  const toast = useToast();
  const { data: categories } = useCategories();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [createProductOpen, setCreateProductOpen] = useState(false);
  /**
   * The catalogue's own rule, not a new one: `/products` gates "מוצר חדש" on owner/office
   * (`Products.tsx`), RLS allows the INSERT for the same two roles (`0022:131-132`), and this
   * route is already STAFF-only. Stated here so the button and the write agree.
   */
  const canCreateProduct = organizationAccess.canWrite
    && (profile?.role === 'owner' || profile?.role === 'office');
  const [state, dispatch] = useReducer(splitReducer, EMPTY_CART);
  const cart = useMemo(() => state.order.flatMap((productId) => {
    const line = state.byId[productId];
    const product = state.products[productId];
    return line && product ? [{ ...line, product }] : [];
  }), [state]);
  const [notes, setNotes] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftNumber, setDraftNumber] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [sendQueue, setSendQueue] = useState<QueueOrder[] | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  // Orders whose WhatsApp window we opened. Not "sent" — only the operator can say that.
  const [openedInWhatsApp, setOpenedInWhatsApp] = useState<ReadonlySet<string>>(new Set());
  const [waTarget, setWaTarget] = useState<QueueOrder | null>(null);
  const [nextOrderItems, setNextOrderItems] = useState<NextOrderItem[]>([]);
  const [nextOrderBusyId, setNextOrderBusyId] = useState<string | null>(null);
  const [pendingNextOrderAdd, setPendingNextOrderAdd] = useState<NextOrderItem | null>(null);
  const [priceDiff, setPriceDiff] = useState<PriceDiffReport | null>(null);
  const [priceRefreshVersion, setPriceRefreshVersion] = useState(0);

  const latestDraftRef = useRef<DraftSnapshot | null>(null);
  const lastSavedSignatureRef = useRef('');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePendingRef = useRef(false);
  const forceSaveRef = useRef(false);
  const activeSaveRef = useRef<Promise<boolean> | null>(null);
  const mountedRef = useRef(true);
  const finalizedRef = useRef(false);
  const appliedLoadKeyRef = useRef<string | null>(null);
  const previousAutoRef = useRef<{ immediate: string; text: string } | null>(null);
  const previousStepRef = useRef<1 | 2 | 3 | null>(null);
  const priceSnapshotRef = useRef<Map<string, number>>(new Map());
  const priceSnapshotLinesRef = useRef<PriceSnapshotLine[]>([]);
  const pendingPriceDiffRef = useRef<PendingPriceDiff | null>(null);
  const priceRefreshSequenceRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!org?.id) { setNextOrderItems([]); return; }
    let active = true;
    void listNextOrderItems(org.id)
      .then((items) => {
        if (!active) return;
        const visible = items.filter((item) => item.product.active);
        setNextOrderItems(visible);
        if (visible.length !== items.length) toast(t('newOrder.toast'));
      })
      .catch((failure) => { if (active) toast(errorText(failure), 'error'); });
    return () => { active = false; };
  // Intentionally load once per organization. useToast returns a new callback after each toast.
  }, [org?.id]);

  useEffect(() => {
    appliedLoadKeyRef.current = null;
    previousAutoRef.current = null;
    previousStepRef.current = null;
    priceSnapshotRef.current = new Map();
    priceSnapshotLinesRef.current = [];
    pendingPriceDiffRef.current = null;
    setPriceDiff(null);
    setHydrated(false);
  }, [loadKey]);

  useEffect(() => {
    if (step > 1 && cart.length === 0) setStep(1);
  }, [cart.length, step]);

  const { data, loading, error, refetch } = useQuery(async () => {
    const [products, sps, suppliers] = await Promise.all([
      supabase.from('products').select('*').eq('active', true).order('name'),
      supabase.from('supplier_products').select('*').eq('available', true),
      supabase.from('suppliers').select(SUPPLIER_COLUMNS).is('deleted_at', null).in('status', NEW_COMMERCE_SUPPLIER_STATUSES),
    ]);
    let draft: DraftRow | null = null;
    let source: SourceOrder | null = null;
    if (fromOrderId) {
      source = unwrap(await supabase.from('purchase_orders')
        .select('supplier_id, notes, expected_date, items:purchase_order_items(product_id, qty, product:products(*))')
        .eq('id', fromOrderId).maybeSingle()) as SourceOrder | null;
    } else if (!startFresh && profile) {
      let query = supabase.from('purchase_requests')
        .select('id, number, notes, expected_date, editor_step, updated_at, items:purchase_request_items(product_id, qty, chosen_supplier_id, pinned_supplier_id, product:products(*))')
        .eq('status', 'draft').eq('created_by', profile.id);
      query = explicitDraftId
        ? query.eq('id', explicitDraftId)
        : query.order('updated_at', { ascending: false }).limit(1);
      draft = unwrap(await query.maybeSingle()) as DraftRow | null;
    }
    return {
      loadKey,
      products: unwrap(products) as Product[],
      sps: unwrap(sps) as SupplierProduct[],
      suppliers: unwrap(suppliers) as Supplier[],
      draft,
      source,
    };
  }, [loadKey, profile?.id]);

  const supplierById = useMemo(() => new Map((data?.suppliers ?? []).map((supplier) => [supplier.id, supplier])), [data]);
  const offersByProduct = useMemo(() => {
    const map = new Map<string, SupplierProduct[]>();
    for (const offer of data?.sps ?? []) {
      if (!supplierById.has(offer.supplier_id)) continue;
      const offers = map.get(offer.product_id) ?? [];
      offers.push(offer);
      map.set(offer.product_id, offers);
    }
    for (const offers of map.values()) offers.sort((a, b) =>
      a.current_price - b.current_price
      || (a.supplier_id < b.supplier_id ? -1 : a.supplier_id > b.supplier_id ? 1 : 0));
    return map;
  }, [data, supplierById]);

  useEffect(() => {
    if (!data || data.loadKey !== loadKey || appliedLoadKeyRef.current === loadKey) return;
    appliedLoadKeyRef.current = loadKey;
    let nextCart: CartItem[] = [];
    let nextNotes = '';
    let nextExpectedDate = '';
    let nextStep: 1 | 2 | 3 = 1;
    let nextDraftId: string | null = null;
    let nextDraftNumber: number | null = null;
    let draftNeedsRepair = false;

    if (data.source) {
      let skipped = 0;
      nextCart = data.source.items.flatMap((item) => {
        if (!item.product?.active) { skipped += 1; return []; }
        const sourceStillAvailable = (offersByProduct.get(item.product_id) ?? []).some((offer) => offer.supplier_id === data.source!.supplier_id);
        return [{
          product: item.product,
          productId: item.product_id,
          qty: item.qty,
          assignment: sourceStillAvailable
            ? { mode: 'pinned' as const, supplierId: data.source!.supplier_id }
            : { mode: 'auto' as const },
        }];
      });
      nextNotes = data.source.notes ?? '';
      nextExpectedDate = data.source.expected_date ?? '';
      if (skipped) toast(t('newOrder.skippedItems', { count: skipped }));
    } else if (data.draft) {
      nextCart = data.draft.items.flatMap((item) => {
        if (!item.product?.active) { draftNeedsRepair = true; return []; }
        return [{
          product: item.product,
          productId: item.product_id,
          qty: item.qty,
          assignment: item.pinned_supplier_id
            ? { mode: 'pinned' as const, supplierId: item.pinned_supplier_id }
            : { mode: 'auto' as const },
        }];
      });
      nextNotes = data.draft.notes ?? '';
      nextExpectedDate = data.draft.expected_date ?? '';
      nextStep = nextCart.length && (data.draft.editor_step === 2 || data.draft.editor_step === 3)
        ? data.draft.editor_step
        : 1;
      nextDraftId = data.draft.id;
      nextDraftNumber = data.draft.number;
      if (draftNeedsRepair) toast(t('newOrder.toast_2'));
    } else if (explicitDraftId) {
      toast(t('newOrder.toast_3'), 'error');
    }

    const snapshot: DraftSnapshot = {
      requestId: nextDraftId,
      notes: nextNotes,
      expectedDate: nextExpectedDate,
      editorStep: nextStep,
      items: data.draft && !draftNeedsRepair
        ? data.draft.items.map((item) => ({
          product_id: item.product_id,
          qty: item.qty,
          chosen_supplier_id: item.chosen_supplier_id,
          pinned_supplier_id: item.pinned_supplier_id,
        }))
        : nextCart.map((item) => ({
          product_id: item.productId,
          qty: item.qty,
          chosen_supplier_id: item.assignment.mode === 'pinned' ? item.assignment.supplierId : null,
          pinned_supplier_id: item.assignment.mode === 'pinned' ? item.assignment.supplierId : null,
        })),
    };
    latestDraftRef.current = snapshot;
    lastSavedSignatureRef.current = nextDraftId && !draftNeedsRepair ? draftSignature(snapshot) : '';
    finalizedRef.current = false;
    dispatch({
      type: 'HYDRATE',
      state: {
        order: nextCart.map((item) => item.productId),
        byId: Object.fromEntries(nextCart.map(({ product: _product, ...line }) => [line.productId, line])),
        products: Object.fromEntries(nextCart.map((item) => [item.productId, item.product])),
      },
    });
    setNotes(nextNotes);
    setExpectedDate(nextExpectedDate);
    setStep(nextStep);
    setDraftId(nextDraftId);
    setDraftNumber(nextDraftNumber);
    setSaveError('');
    setSaveStatus(nextDraftId ? 'saved' : 'idle');
    setHydrated(true);
  }, [data, explicitDraftId, loadKey, offersByProduct, toast]);

  const splitInput = useMemo<SplitInput>(() => ({
    lines: cart.map(({ product: _product, ...line }) => line),
    offersByProduct: new Map([...offersByProduct].map(([productId, offers]) => [productId, offers.map((offer) => ({
      supplierId: offer.supplier_id,
      unitPrice: offer.current_price,
      currency: offer.currency,
      minQty: offer.min_qty,
    }))])),
    suppliers: new Map([...supplierById].map(([supplierId, supplier]) => [supplierId, {
      id: supplier.id,
      name: supplier.name,
      minOrderAmount: supplier.min_order_amount,
      // The supplier's own money: the unit their minimum order is stated in, and the only currency
      // an offer of theirs may be priced in (orderSplit.usableOffers).
      currency: supplier.default_currency,
    }])),
  }), [cart, offersByProduct, supplierById]);
  const split = useMemo(() => resolveSplit(splitInput), [splitInput]);
  const resolvedByProduct = useMemo(() => new Map([
    ...split.groups.flatMap((group) => group.lines),
    ...split.blocked,
  ].map((line) => [line.productId, line])), [split]);
  const draftItems = useMemo<DraftItemInput[]>(() => cart.map((item) => ({
    product_id: item.productId,
    qty: item.qty,
    chosen_supplier_id: resolvedByProduct.get(item.productId)?.supplierId ?? null,
    pinned_supplier_id: item.assignment.mode === 'pinned' ? item.assignment.supplierId : null,
  })), [cart, resolvedByProduct]);
  latestDraftRef.current = { requestId: draftId, notes, expectedDate, editorStep: step, items: draftItems };

  const currentPriceSnapshot = useMemo<PriceSnapshot>(() => {
    const prices = new Map<string, number>();
    const lines: PriceSnapshotLine[] = [];
    for (const group of split.groups) {
      for (const line of group.lines) {
        if (line.unitPrice == null) continue;
        prices.set(priceKey(line.productId, group.supplier.id), line.unitPrice);
        lines.push({
          productId: line.productId,
          productName: (() => {
            const product = state.products[line.productId];
            return product ? productLabel(product) : t('newOrder.productLabel');
          })(),
          supplierId: group.supplier.id,
          supplierName: group.supplier.name,
          currency: group.currency,
          qty: line.qty,
          assignmentMode: line.assignment.mode,
        });
      }
    }
    return { prices, lines, oldTotal: split.savings.splitTotal };
  }, [split, state.products]);

  useEffect(() => {
    if (!hydrated) return;
    if (step === 3 && previousStepRef.current !== 3) {
      priceSnapshotRef.current = new Map(currentPriceSnapshot.prices);
      priceSnapshotLinesRef.current = currentPriceSnapshot.lines.map((line) => ({ ...line }));
    }
    previousStepRef.current = step;
  }, [currentPriceSnapshot, hydrated, step]);

  useEffect(() => {
    const pending = pendingPriceDiffRef.current;
    if (!pending || pending.refreshId !== priceRefreshVersion || pending.sourceOffers === data?.sps) return;
    const nextLinesByProduct = new Map(currentPriceSnapshot.lines.map((line) => [line.productId, line]));
    const changes: PriceDiffLine[] = [];
    for (const oldLine of pending.lines) {
      const oldUnitPrice = pending.prices.get(priceKey(oldLine.productId, oldLine.supplierId));
      if (oldUnitPrice == null) continue;
      const nextMeta = nextLinesByProduct.get(oldLine.productId) ?? null;
      const nextResolved = resolvedByProduct.get(oldLine.productId) ?? null;
      const newUnitPrice = nextResolved?.unitPrice ?? null;
      if (nextMeta?.supplierId === oldLine.supplierId && newUnitPrice === oldUnitPrice) continue;
      const oldLineTotal = exactLineTotal(oldLine.qty, oldUnitPrice);
      const newLineTotal = nextResolved?.lineTotal ?? null;
      changes.push({
        ...oldLine,
        newSupplierId: nextMeta?.supplierId ?? null,
        newSupplierName: nextMeta?.supplierName ?? t('newOrder.text'),
        oldUnitPrice,
        newUnitPrice,
        oldLineTotal,
        newLineTotal,
        delta: newLineTotal == null ? null : moneyFromCents(hundredths(newLineTotal) - hundredths(oldLineTotal)),
      });
    }
    pendingPriceDiffRef.current = null;
    priceSnapshotRef.current = new Map(currentPriceSnapshot.prices);
    priceSnapshotLinesRef.current = currentPriceSnapshot.lines.map((line) => ({ ...line }));
    setPriceDiff({
      lines: changes,
      currency: split.basketCurrency,
      oldTotal: pending.oldTotal,
      newTotal: split.savings.splitTotal,
    });
  }, [currentPriceSnapshot, data?.sps, priceRefreshVersion, resolvedByProduct, split.basketCurrency, split.savings.splitTotal]);

  const runSaveQueue = useCallback((force = false): Promise<boolean> => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    savePendingRef.current = true;
    forceSaveRef.current ||= force;
    if (activeSaveRef.current) return activeSaveRef.current;

    const task = (async () => {
      while (savePendingRef.current) {
        savePendingRef.current = false;
        const snapshot = latestDraftRef.current;
        if (!snapshot || finalizedRef.current || (!snapshot.requestId && snapshot.items.length === 0)) continue;
        const signature = draftSignature(snapshot);
        const mustSave = forceSaveRef.current || signature !== lastSavedSignatureRef.current;
        forceSaveRef.current = false;
        if (!mustSave) continue;
        if (mountedRef.current) { setSaveStatus('saving'); setSaveError(''); }
        try {
          const saved = await saveOrderDraft(snapshot);
          lastSavedSignatureRef.current = signature;
          if (!latestDraftRef.current?.requestId) {
            latestDraftRef.current = { ...latestDraftRef.current!, requestId: saved.request_id };
            if (mountedRef.current) {
              setDraftId(saved.request_id);
              const draftUrl = new URL(window.location.href);
              draftUrl.search = `?draft=${encodeURIComponent(saved.request_id)}`;
              window.history.replaceState(window.history.state, '', draftUrl);
            }
          }
          if (draftSignature(latestDraftRef.current!) !== signature) savePendingRef.current = true;
          else if (mountedRef.current) setSaveStatus('saved');
        } catch (saveFailure) {
          const message = errorText(saveFailure);
          if (mountedRef.current) { setSaveError(message); setSaveStatus('error'); }
          return false;
        }
      }
      return true;
    })();
    activeSaveRef.current = task;
    void task.finally(() => { if (activeSaveRef.current === task) activeSaveRef.current = null; });
    return task;
  }, []);

  useEffect(() => {
    if (!pendingNextOrderAdd) return;
    let active = true;
    const item = pendingNextOrderAdd;
    void (async () => {
      if (!await runSaveQueue(true)) return;
      await dismissNextOrderItem(item.id);
      if (active) setNextOrderItems((current) => current.filter((candidate) => candidate.id !== item.id));
    })()
      .catch((failure) => { if (active) toast(errorText(failure), 'error'); })
      .finally(() => {
        if (!active) return;
        setPendingNextOrderAdd(null);
        setNextOrderBusyId(null);
      });
    return () => { active = false; };
  // useToast is intentionally unstable; depending on it would restart this transaction after a toast.
  }, [pendingNextOrderAdd, runSaveQueue]);

  const scheduleSave = useCallback((delay: number) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('dirty');
    saveTimerRef.current = setTimeout(() => { saveTimerRef.current = null; void runSaveQueue(); }, delay);
  }, [runSaveQueue]);

  const immediateSignature = JSON.stringify([step, draftItems.map((item) => [item.product_id, item.qty, item.chosen_supplier_id, item.pinned_supplier_id])]);
  const textSignature = JSON.stringify([notes, expectedDate]);
  useEffect(() => {
    if (!hydrated || finalizedRef.current) return;
    const previous = previousAutoRef.current;
    previousAutoRef.current = { immediate: immediateSignature, text: textSignature };
    if (!previous) {
      const current = latestDraftRef.current;
      if ((!draftId && cart.length) || (draftId && current && draftSignature(current) !== lastSavedSignatureRef.current)) scheduleSave(0);
      return;
    }
    if (!draftId && cart.length === 0) return;
    if (previous.immediate !== immediateSignature) scheduleSave(0);
    else if (previous.text !== textSignature) scheduleSave(600);
  }, [cart.length, draftId, hydrated, immediateSignature, scheduleSave, textSignature]);

  useEffect(() => {
    const hasUnsavedChanges = () => {
      const current = latestDraftRef.current;
      return !!current && !finalizedRef.current && (!!current.requestId || current.items.length > 0)
        && draftSignature(current) !== lastSavedSignatureRef.current;
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const preserveBeforeLink = (event: MouseEvent) => {
      if (!hasUnsavedChanges() || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!target || target.target === '_blank' || target.hasAttribute('download')) return;
      const url = new URL(target.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      event.stopPropagation();
      void runSaveQueue().then((saved) => {
        if (saved) navigate(`${url.pathname}${url.search}${url.hash}`);
        else toast(t('newOrder.toast_4'), 'error');
      });
    };
    const flushBeforeSignOut = (event: Event) => {
      if (!hasUnsavedChanges()) return;
      const detail = (event as CustomEvent<OrderDraftFlushDetail>).detail;
      if (detail) detail.pending.push(runSaveQueue());
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener(ORDER_DRAFT_FLUSH_EVENT, flushBeforeSignOut);
    document.addEventListener('click', preserveBeforeLink, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener(ORDER_DRAFT_FLUSH_EVENT, flushBeforeSignOut);
      document.removeEventListener('click', preserveBeforeLink, true);
      if (hasUnsavedChanges()) void runSaveQueue();
    };
  }, [navigate, runSaveQueue, toast]);

  const { savings } = split;
  const singleSupplierName = savings.singleSupplierId ? supplierById.get(savings.singleSupplierId)?.name ?? null : null;

  async function goToSummary() {
    if (!cart.length || split.blocked.length) return;
    if (await runSaveQueue()) setStep(3);
    else toast(t('newOrder.toast_5'), 'error');
  }

  function applyResolution(option: ResolutionOption, fromSupplierId: string) {
    if (option.kind === 'increase_qty') {
      dispatch({ type: 'BUMP_QTY', productId: option.productId, toQty: option.toQty });
      return;
    }
    if (option.kind === 'move_line') {
      if (option.requiresQty != null) dispatch({ type: 'BUMP_QTY', productId: option.productId, toQty: option.requiresQty });
      dispatch({ type: 'PIN_SUPPLIER', productId: option.productId, supplierId: option.toSupplierId });
      return;
    }
    if (option.kind === 'move_group') {
      dispatch({
        type: 'MOVE_GROUP',
        fromSupplierId,
        toSupplierId: option.toSupplierId,
        productIds: option.productIds,
        quantityChanges: option.quantityChanges,
      });
      return;
    }
    if (option.kind === 'remove_line') {
      dispatch({ type: 'REMOVE_PRODUCT', productId: option.productId });
      return;
    }
    const line = state.byId[option.productId];
    if (!line || !org?.id) return;
    void deferProduct(org.id, option.productId, line.qty, latestDraftRef.current?.requestId ?? null)
      .then(() => {
        dispatch({ type: 'DEFER_PRODUCT', productId: option.productId });
        toast(t('newOrder.toast_6'));
      })
      .catch((failure) => toast(errorText(failure), 'error'));
  }

  function addNextOrderItem(item: NextOrderItem) {
    setNextOrderBusyId(item.id);
    const product = data?.products.find((candidate) => candidate.id === item.product_id);
    if (!product?.active) {
      toast(t('newOrder.toast_7'), 'error');
      setNextOrderBusyId(null);
      return;
    }
    dispatch({ type: 'ADD_PRODUCT', product });
    dispatch({ type: 'SET_QTY', productId: product.id, qty: item.qty });
    setPendingNextOrderAdd(item);
  }

  async function dismissNextItem(item: NextOrderItem) {
    setNextOrderBusyId(item.id);
    try {
      await dismissNextOrderItem(item.id);
      setNextOrderItems((current) => current.filter((candidate) => candidate.id !== item.id));
    } catch (failure) {
      toast(errorText(failure), 'error');
    } finally {
      setNextOrderBusyId(null);
    }
  }

  async function cancelDraft(reason?: string) {
    setBusy(true);
    const saved = await runSaveQueue();
    const requestId = latestDraftRef.current?.requestId;
    try {
      if (!saved) throw new Error(t('newOrder.Error'));
      if (requestId) await cancelOrderDraft(requestId, reason ?? t('newOrder.cancelOrderDraft'));
      finalizedRef.current = true;
      toast(t('newOrder.toast_8'));
      navigate('/orders');
    } catch (failure) {
      toast(errorText(failure), 'error');
    } finally {
      setBusy(false);
      setCancelOpen(false);
    }
  }

  async function finalizeDraft() {
    if (savings.splitTotal === null) return;
    setBusy(true);
    try {
      if (!await runSaveQueue()) throw new Error(t('newOrder.runSaveQueue'));
      const requestId = latestDraftRef.current?.requestId;
      if (!requestId) throw new Error(t('newOrder.Error_2'));
      const finalized = await finalizeOrderDraft(requestId, savings.splitTotal);
      finalizedRef.current = true;
      const orders = unwrap(await supabase.from('purchase_orders')
        .select('*, supplier:suppliers(name, phone, whatsapp), items:purchase_order_items(qty, unit_price, product:products(name, unit, sku))')
        .in('id', finalized.order_ids).order('number')) as QueueOrder[];
      setSendQueue(orders);
      toast(t('newOrder.ordersCreated', { count: finalized.order_count }));
    } catch (failure) {
      const raw = failure instanceof Error ? failure.message : String(failure);
      if (raw.includes('draft_price_changed')) {
        const refreshId = ++priceRefreshSequenceRef.current;
        pendingPriceDiffRef.current = {
          prices: new Map(priceSnapshotRef.current.size ? priceSnapshotRef.current : currentPriceSnapshot.prices),
          lines: (priceSnapshotLinesRef.current.length ? priceSnapshotLinesRef.current : currentPriceSnapshot.lines).map((line) => ({ ...line })),
          oldTotal: savings.splitTotal,
          refreshId,
          sourceOffers: data?.sps ?? null,
        };
        const saved = await runSaveQueue(true);
        if (!saved) {
          pendingPriceDiffRef.current = null;
          toast(t('newOrder.toast_9'), 'error');
          return;
        }
        if (!await refetch()) {
          pendingPriceDiffRef.current = null;
          toast(t('newOrder.toast_10'), 'error');
          return;
        }
        setPriceRefreshVersion(refreshId);
        toast(t('newOrder.toast_11'), 'error');
      } else if (raw.includes('draft_supplier_unavailable')) {
        await refetch();
        setStep(2);
        toast(t('newOrder.toast_12'), 'error');
      } else {
        toast(errorText(failure), 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  function sendQueuedOrder(order: QueueOrder) {
    setWaTarget(order); // two-step dialog; the row offers the confirmation after it closes
  }

  async function confirmQueuedOrderSent(order: QueueOrder) {
    setSendingId(order.id);
    const result = await markOrderSentToSupplier(order.id);
    setSendingId(null);
    if (result.error) { toast(result.error, 'error'); return; }
    setSendQueue((queue) => queue?.map((row) => row.id === order.id
      ? { ...row, status: 'sent', sent_at: new Date().toISOString() }
      : row) ?? null);
    toast(t('newOrder.toast_13'));
  }

  if (loading) return <RecordSkeleton />;
  if (error) return <ErrorNote message={error} />;
  if (!hydrated) return <RecordSkeleton />;

  const saveLabel = saveStatus === 'saving' ? t('newOrder.text_2')
    : saveStatus === 'dirty' ? t('newOrder.text_3')
      : saveStatus === 'saved' ? t('newOrder.text_4')
        : saveStatus === 'error' ? t('newOrder.text_5')
          : t('newOrder.text_6');

  /**
   * One source for the three steps. The two renderings below — phone dots and desktop chip strip —
   * read the same labels, the same enablement rules and the same go-handlers, so the wizard cannot
   * enable a step on one width and refuse it on the other.
   */
  const steps = [
    { number: '01', label: t('newOrder.setStep'), disabled: false, go: () => setStep(1) },
    { number: '02', label: t('newOrder.setStep_2'), disabled: !cart.length, go: () => setStep(2) },
    { number: '03', label: t('newOrder.goToSummary'), disabled: !cart.length || split.blocked.length > 0, go: () => void goToSummary() },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div data-tour-anchor="new-order-flow">
      <PageHeader
        title={t('newOrder.title')}
        description={t('newOrder.description')}
        meta={(
          <>
          <div className={`flex min-h-6 items-center gap-1.5 text-xs ${saveStatus === 'error' ? 'text-alert-fg' : 'text-ink-muted'}`} role="status" aria-live="polite">
            {saveStatus === 'saving' ? <Loader2 size={ICON.xs} className="animate-spin" aria-hidden="true" /> : saveStatus === 'saved' ? <Check size={ICON.xs} aria-hidden="true" /> : <Clock3 size={ICON.xs} aria-hidden="true" />}
            <span>{draftNumber ? <>{t('newOrder.text_7')} <span className="num">#{draftNumber}</span> · </> : null}{saveLabel}</span>
            {saveStatus === 'error' && <button type="button" className="font-semibold underline" onClick={() => void runSaveQueue()}>{t('newOrder.runSaveQueue_2')}</button>}
          </div>
          {saveError && saveStatus === 'error' && <p role="alert" className="text-xs text-alert-fg">{saveError}</p>}
          </>
        )}
        actions={(
          <div className="flex flex-col items-stretch gap-1 sm:items-end">
          <div className="flex flex-wrap gap-2">
            {(draftId || cart.length > 0) && <button type="button" className="btn-danger" disabled={busy} onClick={() => setCancelOpen(true)}><XCircle size={ICON.sm} aria-hidden="true" /> {t('newOrder.setCancelOpen')}</button>}
            <button type="button" className="btn-primary" disabled={busy || !cart.length || split.blocked.length > 0} onClick={() => void goToSummary()}>
              <CheckCircle2 size={ICON.sm} aria-hidden="true" /> {t('newOrder.reviewAndConfirm')}
            </button>
          </div>
          {split.blocked.length > 0 && <p className="text-xs text-alert-fg sm:text-end">{t('newOrder.text_8')} <span className="num">{split.blocked.length}</span> {t('newOrder.text_9')}</p>}
          </div>
        )} />
      </div>

      {/* T7.3: the wizard steps speak the floating-pill language — a white pill strip with the
          active step as a solid oceanic pill, replacing the ruled underline tabs.
          Two renderings, one nav: the pill strip needs room for three worded chips, and at phone
          width it wrapped onto a second line, turning the rounded-full plate into a blurred
          ellipse (owner screenshot). `hidden` is display:none, so exactly one rendering is in the
          accessibility tree at a time — no aria-hidden, no six-button announcement. */}
      <nav aria-label={t('newOrder.aria_label')}>
        <div className="flex items-center gap-2 sm:hidden">
          {steps.map((entry, index) => {
            const active = step === index + 1;
            return (
              <button key={entry.number} type="button" disabled={entry.disabled} onClick={entry.go}
                aria-current={active ? 'step' : undefined}
                className={`grid size-11 shrink-0 place-items-center rounded-full text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'bg-action text-on-solid' : 'bg-action-wash text-ink-mid'}`}>
                {/* The number is NOT aria-hidden, and that is the point: this button and its
                    desktop twin below are the same control, so they must announce the same name.
                    Hiding the digit here left a phone user hearing "מוצרים וכמויות" where a desktop
                    user hears "01 מוצרים וכמויות" — a step control that drops its step number on
                    the one viewport where the label is the only thing on screen. */}
                <span className="num">{entry.number}</span>
                <span className="sr-only">{entry.label}</span>
              </button>
            );
          })}
          <span className="min-w-0 truncate text-sm font-semibold text-ink-body">{steps[step - 1].label}</span>
        </div>
        <div className="hidden w-fit max-w-full flex-wrap items-center gap-1 rounded-full bg-surface/90 p-1.5 shadow-card sm:flex">
          {steps.map((entry, index) => (
            <button key={entry.number} type="button" disabled={entry.disabled} onClick={entry.go}
              aria-current={step === index + 1 ? 'step' : undefined}
              className={`chip-filter gap-2 disabled:cursor-not-allowed disabled:opacity-50 ${step === index + 1 ? 'chip-filter-active' : ''}`}>
              <span className="num text-xs">{entry.number}</span><span className="font-semibold">{entry.label}</span>
            </button>
          ))}
        </div>
      </nav>

      {step === 1 ? (
        <ProductStep products={data?.products ?? []} categories={categories ?? []} offersByProduct={offersByProduct}
          cart={cart} q={q} setQ={setQ} cat={cat} setCat={setCat}
          onAdd={(product) => dispatch({ type: 'ADD_PRODUCT', product })}
          onRemove={(productId) => dispatch({ type: 'REMOVE_PRODUCT', productId })}
          onQty={(productId, qty) => dispatch(qty > 0 ? { type: 'SET_QTY', productId, qty } : { type: 'REMOVE_PRODUCT', productId })}
          onContinue={() => setStep(2)} nextOrderItems={nextOrderItems} nextOrderBusyId={nextOrderBusyId}
          onAddNextOrderItem={(item) => void addNextOrderItem(item)} onDismissNextOrderItem={(item) => void dismissNextItem(item)}
          onCreateProduct={canCreateProduct ? () => setCreateProductOpen(true) : null} />
      ) : step === 2 ? (
        <SupplierSplitStep baseCurrency={org?.base_currency} cart={cart} offersByProduct={offersByProduct} supplierById={supplierById} split={split} input={splitInput}
          notes={notes} setNotes={setNotes} expectedDate={expectedDate} setExpectedDate={setExpectedDate} busy={busy}
          onSupplier={(productId, supplierId) => dispatch(supplierId
            ? { type: 'PIN_SUPPLIER', productId, supplierId }
            : { type: 'UNPIN', productId })}
          onRemove={(productId) => dispatch({ type: 'REMOVE_PRODUCT', productId })}
          onQty={(productId, qty) => dispatch({ type: 'BUMP_QTY', productId, toQty: qty })}
          onResolve={applyResolution}
          onConsolidate={(supplierId) => dispatch({ type: 'CONSOLIDATE', supplierId })}
          onBack={() => setStep(1)} onContinue={() => void goToSummary()} />
      ) : (
        <SummaryStep split={split} products={new Map(Object.entries(state.products))} singleSupplierName={singleSupplierName}
          productCount={cart.length} notes={notes} expectedDate={expectedDate} busy={busy}
          onBack={() => setStep(2)} onConfirm={() => void finalizeDraft()} />
      )}

      <PriceDiffModal report={priceDiff} onClose={() => setPriceDiff(null)} />

      {createProductOpen && (
        <QuickCreateProduct suppliers={data?.suppliers ?? []} initialName={q}
          onClose={() => setCreateProductOpen(false)}
          onCreated={async (product) => {
            setCreateProductOpen(false);
            // Refetch BEFORE adding to the cart: `offersByProduct` is derived from this query, and
            // a line whose offer has not arrived yet resolves to `no_offers` and lands in the
            // blocked list on step 2. Awaiting keeps the product's one offer present the whole
            // time, so no pin is needed — resolveSplit picks the only supplier there is.
            await refetch();
            dispatch({ type: 'ADD_PRODUCT', product });
            // The search that found nothing would now hide the row that answers it.
            setQ('');
            setCat('');
          }} />
      )}

      <WhatsAppSendDialog order={waTarget} orgName={org?.name ?? ''}
        onClose={(openedText) => {
          const target = waTarget;
          setWaTarget(null);
          // Opening the window is not sending. The row now offers the confirmation instead.
          if (openedText && target) setOpenedInWhatsApp((ids) => new Set(ids).add(target.id));
        }} />

      <Modal open={sendQueue !== null} onClose={() => navigate('/orders')} title={t('newOrder.title_2')} busy={sendingId !== null} statusMessage={sendingId ? t('newOrder.navigate') : undefined}>
        <p className="mb-3 text-sm text-ink-soft">
          {t('newOrder.whatsappPreparesOnly')}
        </p>
        <div className="divide-y divide-line-soft border-y border-line-strong">
          {sendQueue?.map((order) => {
            const hasWhatsApp = !!(order.supplier.whatsapp || order.supplier.phone);
            const opened = openedInWhatsApp.has(order.id);
            return (
              <div key={order.id} className="flex flex-wrap items-center gap-2 py-3">
                <div><div className="font-medium text-ink-body">{order.supplier.name}</div><div className="text-xs text-ink-muted">{t('newOrder.text_12')}<span className="num">{order.number}</span></div></div>
                <div className="ms-auto flex flex-wrap items-center gap-2">
                  {order.status === 'sent' ? <span className="badge badge-done">{t('newOrder.text_13')}</span>
                    : hasWhatsApp ? (
                      <>
                        <button type="button" className={opened ? 'btn-secondary' : 'btn-primary'} disabled={sendingId !== null} onClick={() => sendQueuedOrder(order)}>
                          <MessageCircle size={ICON.sm} aria-hidden="true" /> {opened ? t('newOrder.text_14') : t('newOrder.text_15')}
                        </button>
                        {opened && (
                          <button type="button" className="btn-primary" disabled={sendingId !== null} onClick={() => void confirmQueuedOrderSent(order)}>
                            {sendingId === order.id ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={ICON.sm} aria-hidden="true" />} {t('newOrder.markAsSent')}
                          </button>
                        )}
                      </>
                    )
                      : <span className="text-xs text-await-fg">{t('newOrder.text_16')}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-5 flex justify-end"><button type="button" className="btn-primary" disabled={sendingId !== null} onClick={() => navigate('/orders')}>{t('newOrder.navigate_2')}</button></div>
      </Modal>

      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)} onConfirm={(reason) => void cancelDraft(reason)}
        title={t('newOrder.title_3')} message={t('newOrder.message')}
        confirmLabel={t('newOrder.confirmLabel')} danger requireReason busy={busy} />
    </div>
  );
}

function PriceDiffModal({ report, onClose }: { report: PriceDiffReport | null; onClose: () => void }) {
  const { t } = useT();
  const totalDelta = report?.oldTotal != null && report.newTotal != null
    ? moneyFromCents(hundredths(report.newTotal) - hundredths(report.oldTotal))
    : null;
  return (
    <Modal open={report !== null} onClose={onClose} title={t('newOrder.title_4')} description={t('newOrder.description_2')} wide>
      {report?.lines.length ? (
        <div className="divide-y divide-line-strong border-y border-line-strong">
          {report.lines.map((line) => (
            <div key={line.productId} className="px-3 py-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">{/* dir="auto" = <bdi> semantics without a new element: the browser smoke anchors on this
    exact-text node and climbs two parents, so wrapping would break its locator depth. */}
<strong className="text-ink-body" dir="auto">{line.productName}</strong><span className={line.assignmentMode === 'pinned' ? 'badge-info' : 'badge-idle'}>{line.assignmentMode === 'pinned' ? t('newOrder.text_17') : line.newSupplierId !== line.supplierId ? t('newOrder.text_18') : t('newOrder.text_19')}</span></div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] sm:items-center">
                <div><span className="block text-xs text-ink-muted">{t('newOrder.priceBefore', { supplier: line.supplierName })}</span><span className="num font-semibold">{fmtMoneyExact(line.oldUnitPrice, line.currency)}</span> {t('newOrder.fmtMoneyExact')}</div>
                <span className="text-ink-faint" aria-hidden="true">←</span>
                <div><span className="block text-xs text-ink-muted">{t('newOrder.priceNow', { supplier: line.newSupplierName })}</span><span className="num font-semibold">{fmtMoneyExact(line.newUnitPrice, line.currency)}</span> {t('newOrder.fmtMoneyExact_2')}</div>
                <div className={`font-semibold sm:text-end ${line.delta == null ? 'text-ink-muted' : `num ${line.delta > 0 ? 'text-await-fg' : 'text-done-fg'}`}`}>{line.delta == null ? t('newOrder.unavailable') : signedMoney(line.delta, line.currency)}</div>
              </div>
              <div className="mt-1 text-xs text-ink-muted">{t('newOrder.fmtMoneyExact_3')} <span className="num">{fmtMoneyExact(line.oldLineTotal, line.currency)}</span> ← <span className="num font-semibold text-ink">{fmtMoneyExact(line.newLineTotal, line.currency)}</span></div>
            </div>
          ))}
        </div>
      ) : report ? <div className="note-info">{t('newOrder.text_20')}</div> : null}
      {report && <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-y border-line-strong py-3 text-sm"><span>{t('newOrder.orderTotal')}</span><strong className="num">{fmtMoneyExact(report.oldTotal, report.currency)} ← {fmtMoneyExact(report.newTotal, report.currency)}{totalDelta != null ? ` · ${signedMoney(totalDelta, report.currency)}` : ''}</strong></div>}
      <div className="mt-5 flex justify-end"><button type="button" className="btn-primary" onClick={onClose}>{t('newOrder.text_21')}</button></div>
    </Modal>
  );
}

function priceKey(productId: string, supplierId: string): string {
  return `${productId}|${supplierId}`;
}

function exactLineTotal(qty: number, unitPrice: number): number {
  return moneyFromCents(centsFromUnits(lineUnits(qty, unitPrice)));
}

function signedMoney(value: number, currency: string | null | undefined): string {
  if (value === 0) return fmtMoneyExact(0, currency);
  return `${value > 0 ? '+' : '−'}${fmtMoneyExact(Math.abs(value), currency)}`;
}

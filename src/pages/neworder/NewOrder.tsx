import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, CheckCircle2, Clock3, Loader2, MessageCircle, XCircle } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useQuery, unwrap } from '../../lib/useQuery';
import { useAuth } from '../../auth/AuthContext';
import { ConfirmDialog, ErrorNote, Modal, PageLoader, useToast } from '../../components/ui';
import { useCategories } from '../Suppliers';
import { toHebrewError } from '../../lib/errors';
import {
  cancelOrderDraft,
  finalizeOrderDraft,
  ORDER_DRAFT_FLUSH_EVENT,
  saveOrderDraft,
  type DraftItemInput,
  type OrderDraftFlushDetail,
} from '../../lib/orderDrafts';
import { resolveSplit, splitReducer, type CartState, type SplitLine } from '../../lib/orderSplit';
import { sendOrderWhatsApp } from '../../lib/share';
import type { Product, PurchaseOrder, Supplier, SupplierProduct } from '../../lib/types';
import ProductStep from './ProductStep';
import SupplierSplitStep from './SupplierSplitStep';
import SummaryStep from './SummaryStep';

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
  items: { product_id: string; qty: number; chosen_supplier_id: string | null; product: Product | null }[];
}

interface SourceOrder {
  supplier_id: string;
  notes: string | null;
  expected_date: string | null;
  items: { product_id: string; qty: number; product: Product | null }[];
}

type QueueOrder = PurchaseOrder & {
  supplier: { name: string; phone: string | null; whatsapp: string | null };
  items: { qty: number; unit_price: number; product: { name: string; unit: string } }[];
};

interface DraftSnapshot {
  requestId: string | null;
  notes: string;
  expectedDate: string;
  editorStep: 1 | 2;
  items: DraftItemInput[];
}

const draftSignature = (draft: DraftSnapshot) => JSON.stringify([
  draft.notes.trim(), draft.expectedDate, draft.editorStep,
  draft.items.map((item) => [item.product_id, item.qty, item.chosen_supplier_id]),
]);

export default function NewOrder() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromOrderId = params.get('from');
  const explicitDraftId = params.get('draft');
  const startFresh = params.get('fresh') === '1';
  const loadKey = fromOrderId ? `from:${fromOrderId}` : explicitDraftId ? `draft:${explicitDraftId}` : startFresh ? 'fresh' : 'latest';
  const { profile, org } = useAuth();
  const toast = useToast();
  const { data: categories } = useCategories();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [state, dispatch] = useReducer(splitReducer, EMPTY_CART);
  const cart = useMemo(() => state.order.flatMap((productId) => {
    const line = state.byId[productId];
    const product = state.products[productId];
    return line && product ? [{ ...line, product }] : [];
  }), [state]);
  const [notes, setNotes] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [step, setStep] = useState<1 | 2>(1);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftNumber, setDraftNumber] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [sendQueue, setSendQueue] = useState<QueueOrder[] | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    appliedLoadKeyRef.current = null;
    previousAutoRef.current = null;
    setHydrated(false);
  }, [loadKey]);

  useEffect(() => {
    if (step === 2 && cart.length === 0) setStep(1);
  }, [cart.length, step]);

  const { data, loading, error, refetch } = useQuery(async () => {
    const [products, sps, suppliers] = await Promise.all([
      supabase.from('products').select('*').eq('active', true).order('name'),
      supabase.from('supplier_products').select('*').eq('available', true),
      supabase.from('suppliers').select('*').is('deleted_at', null).in('status', ['active', 'problematic']),
    ]);
    let draft: DraftRow | null = null;
    let source: SourceOrder | null = null;
    if (fromOrderId) {
      source = unwrap(await supabase.from('purchase_orders')
        .select('supplier_id, notes, expected_date, items:purchase_order_items(product_id, qty, product:products(*))')
        .eq('id', fromOrderId).maybeSingle()) as SourceOrder | null;
    } else if (!startFresh && profile) {
      let query = supabase.from('purchase_requests')
        .select('id, number, notes, expected_date, editor_step, updated_at, items:purchase_request_items(product_id, qty, chosen_supplier_id, product:products(*))')
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
    let nextStep: 1 | 2 = 1;
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
      if (skipped) toast(`${skipped} פריטים מההזמנה המקורית דולגו — המוצר כבר אינו קיים`);
    } else if (data.draft) {
      nextCart = data.draft.items.flatMap((item) => {
        if (!item.product?.active) { draftNeedsRepair = true; return []; }
        return [{
          product: item.product,
          productId: item.product_id,
          qty: item.qty,
          assignment: item.chosen_supplier_id
            ? { mode: 'pinned' as const, supplierId: item.chosen_supplier_id }
            : { mode: 'auto' as const },
        }];
      });
      nextNotes = data.draft.notes ?? '';
      nextExpectedDate = data.draft.expected_date ?? '';
      nextStep = data.draft.editor_step === 2 && nextCart.length ? 2 : 1;
      nextDraftId = data.draft.id;
      nextDraftNumber = data.draft.number;
      if (draftNeedsRepair) toast('מוצרים שאינם פעילים הוסרו מהטיוטה והיא תישמר מחדש');
    } else if (explicitDraftId) {
      toast('הטיוטה לא נמצאה או שאינה שייכת למשתמש הנוכחי', 'error');
    }

    const snapshot: DraftSnapshot = {
      requestId: nextDraftId,
      notes: nextNotes,
      expectedDate: nextExpectedDate,
      editorStep: nextStep,
      items: nextCart.map((item) => ({
        product_id: item.productId,
        qty: item.qty,
        chosen_supplier_id: item.assignment.mode === 'pinned' ? item.assignment.supplierId : null,
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

  const split = useMemo(() => resolveSplit({
    lines: cart.map(({ product: _product, ...line }) => line),
    offersByProduct: new Map([...offersByProduct].map(([productId, offers]) => [productId, offers.map((offer) => ({
      supplierId: offer.supplier_id,
      unitPrice: offer.current_price,
      minQty: offer.min_qty,
    }))])),
    suppliers: new Map([...supplierById].map(([supplierId, supplier]) => [supplierId, {
      id: supplier.id,
      name: supplier.name,
      minOrderAmount: supplier.min_order_amount,
    }])),
  }), [cart, offersByProduct, supplierById]);
  const resolvedByProduct = useMemo(() => new Map([
    ...split.groups.flatMap((group) => group.lines),
    ...split.blocked,
  ].map((line) => [line.productId, line])), [split]);
  const draftItems = useMemo<DraftItemInput[]>(() => cart.map((item) => ({
    product_id: item.productId,
    qty: item.qty,
    chosen_supplier_id: resolvedByProduct.get(item.productId)?.supplierId ?? null,
  })), [cart, resolvedByProduct]);
  latestDraftRef.current = { requestId: draftId, notes, expectedDate, editorStep: step, items: draftItems };

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
          const message = toHebrewError(saveFailure);
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

  const scheduleSave = useCallback((delay: number) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('dirty');
    saveTimerRef.current = setTimeout(() => { saveTimerRef.current = null; void runSaveQueue(); }, delay);
  }, [runSaveQueue]);

  const immediateSignature = JSON.stringify([step, draftItems.map((item) => [item.product_id, item.qty, item.chosen_supplier_id])]);
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
        else toast('לא ניתן לעבור מסך לפני שמירת הטיוטה', 'error');
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

  function effective(item: CartItem): { sp: SupplierProduct | null; recommended: SupplierProduct | null } {
    const offers = offersByProduct.get(item.productId) ?? [];
    const recommended = offers.find((offer) => meetsMin(offer, item.qty)) ?? null;
    const supplierId = resolvedByProduct.get(item.productId)?.supplierId;
    return { sp: supplierId ? offers.find((offer) => offer.supplier_id === supplierId) ?? null : null, recommended };
  }

  const { total, savings } = split;
  const singleSupplierName = savings.singleSupplierId ? supplierById.get(savings.singleSupplierId)?.name ?? null : null;

  async function openReview() {
    if (!cart.length || split.blocked.length) return;
    setStep(2);
    if (await runSaveQueue()) setReviewOpen(true);
    else toast('יש לתקן את שגיאת השמירה לפני אישור ההזמנה', 'error');
  }

  async function cancelDraft(reason?: string) {
    setBusy(true);
    const saved = await runSaveQueue();
    const requestId = latestDraftRef.current?.requestId;
    try {
      if (!saved) throw new Error('שמירת הטיוטה נכשלה');
      if (requestId) await cancelOrderDraft(requestId, reason ?? 'ביטול הטיוטה');
      finalizedRef.current = true;
      toast('הטיוטה בוטלה');
      navigate('/orders');
    } catch (failure) {
      toast(toHebrewError(failure), 'error');
    } finally {
      setBusy(false);
      setCancelOpen(false);
    }
  }

  async function finalizeDraft() {
    if (savings.splitTotal === null) return;
    setBusy(true);
    try {
      if (!await runSaveQueue()) throw new Error('שמירת הטיוטה נכשלה');
      const requestId = latestDraftRef.current?.requestId;
      if (!requestId) throw new Error('הטיוטה טרם נשמרה');
      const finalized = await finalizeOrderDraft(requestId, savings.splitTotal);
      finalizedRef.current = true;
      const orders = unwrap(await supabase.from('purchase_orders')
        .select('*, supplier:suppliers(name, phone, whatsapp), items:purchase_order_items(qty, unit_price, product:products(name, unit))')
        .in('id', finalized.order_ids).order('number')) as QueueOrder[];
      setReviewOpen(false);
      setSendQueue(orders);
      toast(`נוצרו ${finalized.order_count} הזמנות ספק`);
    } catch (failure) {
      const raw = failure instanceof Error ? failure.message : String(failure);
      if (raw.includes('draft_price_changed')) {
        await runSaveQueue(true);
        await refetch();
        toast('המחירים השתנו. הסיכום רוענן — יש לעבור עליו ולאשר שוב.', 'error');
      } else if (raw.includes('draft_supplier_unavailable')) {
        await refetch();
        toast('אחד הספקים אינו זמין עוד. יש לבחור ספק מחדש.', 'error');
      } else {
        toast(toHebrewError(failure), 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendQueuedOrder(order: QueueOrder) {
    setSendingId(order.id);
    const result = await sendOrderWhatsApp(order, org?.name ?? '');
    setSendingId(null);
    if (result.error) { toast(result.error, 'error'); return; }
    if (!result.opened) return;
    if (result.statusChanged) {
      setSendQueue((queue) => queue?.map((row) => row.id === order.id
        ? { ...row, status: 'sent', sent_at: new Date().toISOString() }
        : row) ?? null);
      toast('ההזמנה נפתחה ב-WhatsApp וסומנה כנשלחה');
    }
  }

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;
  if (!hydrated) return <PageLoader />;

  const saveLabel = saveStatus === 'saving' ? 'שומר…'
    : saveStatus === 'dirty' ? 'ממתין לשמירה…'
      : saveStatus === 'saved' ? 'נשמר'
        : saveStatus === 'error' ? 'השמירה נכשלה'
          : 'יישמר אוטומטית עם הוספת מוצר';

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">הזמנה חדשה</h1>
          <p className="mt-1 text-sm text-ink-muted">בחירת מוצרים תחילה, אישור ספקים ומחירים לאחר מכן</p>
          <div className={`mt-2 flex min-h-6 items-center gap-1.5 text-xs ${saveStatus === 'error' ? 'text-alert-fg' : 'text-ink-muted'}`} role="status" aria-live="polite">
            {saveStatus === 'saving' ? <Loader2 size={13} className="animate-spin" /> : saveStatus === 'saved' ? <Check size={13} /> : <Clock3 size={13} />}
            <span>{draftNumber ? `טיוטה #${draftNumber} · ` : ''}{saveLabel}</span>
            {saveStatus === 'error' && <button type="button" className="font-semibold underline" onClick={() => void runSaveQueue()}>ניסיון חוזר</button>}
          </div>
          {saveError && saveStatus === 'error' && <p role="alert" className="text-xs text-alert-fg">{saveError}</p>}
        </div>
        <div className="flex flex-col items-stretch gap-1 sm:items-end">
          <div className="flex flex-wrap gap-2">
            {(draftId || cart.length > 0) && <button type="button" className="btn-ghost text-alert-solid" disabled={busy} onClick={() => setCancelOpen(true)}><XCircle size={15} /> ביטול טיוטה</button>}
            <button type="button" className="btn-primary" disabled={busy || !cart.length || split.blocked.length > 0} onClick={() => void openReview()}>
              <CheckCircle2 size={15} /> סקירה ואישור
            </button>
          </div>
          {split.blocked.length > 0 && <p className="text-xs text-alert-fg sm:text-end">יש {split.blocked.length} פריטים מתחת למינימום הזמנה — הגדל כמות או הסר כדי להמשיך</p>}
        </div>
      </div>

      <nav aria-label="שלבי הזמנה" className="grid grid-cols-2 border-y border-line-strong bg-surface">
        <button type="button" onClick={() => setStep(1)} aria-current={step === 1 ? 'step' : undefined}
          className={`flex min-h-14 items-center gap-2 border-b-2 px-4 text-start transition-colors ${step === 1 ? 'border-action bg-action-wash/50 text-ink' : 'border-transparent text-ink-muted hover:bg-surface-sunken'}`}>
          <span className="num text-xs">01</span><span className="text-sm font-semibold">מוצרים וכמויות</span>
        </button>
        <button type="button" disabled={!cart.length} onClick={() => setStep(2)} aria-current={step === 2 ? 'step' : undefined}
          className={`flex min-h-14 items-center gap-2 border-b-2 border-s border-line-soft px-4 text-start transition-colors disabled:opacity-50 ${step === 2 ? 'border-b-action bg-action-wash/50 text-ink' : 'border-b-transparent text-ink-muted hover:bg-surface-sunken'}`}>
          <span className="num text-xs">02</span><span className="text-sm font-semibold">ספקים וסיכום</span>
        </button>
      </nav>

      {step === 1 ? (
        <ProductStep products={data?.products ?? []} categories={categories ?? []} offersByProduct={offersByProduct}
          cart={cart} q={q} setQ={setQ} cat={cat} setCat={setCat}
          onAdd={(product) => dispatch({ type: 'ADD_PRODUCT', product })}
          onQty={(productId, qty) => dispatch(qty > 0 ? { type: 'SET_QTY', productId, qty } : { type: 'REMOVE_PRODUCT', productId })}
          onContinue={() => setStep(2)} />
      ) : (
        <SupplierSplitStep cart={cart} offersByProduct={offersByProduct} supplierById={supplierById} effective={effective}
          groups={split.groups} blocked={split.blocked} total={total}
          notes={notes} setNotes={setNotes} expectedDate={expectedDate} setExpectedDate={setExpectedDate} busy={busy}
          onSupplier={(productId, supplierId) => dispatch(supplierId
            ? { type: 'PIN_SUPPLIER', productId, supplierId }
            : { type: 'UNPIN', productId })}
          onRemove={(productId) => dispatch({ type: 'REMOVE_PRODUCT', productId })}
          onQty={(productId, qty) => dispatch({ type: 'BUMP_QTY', productId, toQty: qty })}
          onBack={() => setStep(1)} />
      )}

      <Modal open={reviewOpen} onClose={() => setReviewOpen(false)} title="סיכום ההזמנה" busy={busy} statusMessage={busy ? 'יוצר את ההזמנות לספקים' : undefined}>
        <SummaryStep savings={savings} singleSupplierName={singleSupplierName} productCount={cart.length} busy={busy}
          onBack={() => setReviewOpen(false)} onConfirm={() => void finalizeDraft()} />
      </Modal>

      <Modal open={sendQueue !== null} onClose={() => navigate('/orders')} title="שליחת הזמנות לספקים" busy={sendingId !== null} statusMessage={sendingId ? 'פותח את הודעת הספק ומעדכן את ההזמנה' : undefined}>
        <p className="mb-3 text-sm text-ink-soft">כל הזמנה תסומן כנשלחה רק לאחר פתיחת הודעת WhatsApp שלה.</p>
        <div className="divide-y divide-line-soft border-y border-line-strong">
          {sendQueue?.map((order) => {
            const hasWhatsApp = !!(order.supplier.whatsapp || order.supplier.phone);
            return (
              <div key={order.id} className="flex flex-wrap items-center gap-2 py-3">
                <div><div className="font-medium text-ink-body">{order.supplier.name}</div><div className="text-xs text-ink-muted num">הזמנה #{order.number}</div></div>
                <div className="ms-auto">
                  {order.status === 'sent' ? <span className="badge badge-done">נשלחה</span>
                    : hasWhatsApp ? <button type="button" className="btn-primary" disabled={sendingId !== null} onClick={() => void sendQueuedOrder(order)}>{sendingId === order.id ? <Loader2 size={15} className="animate-spin" /> : <MessageCircle size={15} />} שליחה ב-WhatsApp</button>
                      : <span className="text-xs text-await-fg">אין מספר זמין · נשארה מוכנה</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-5 flex justify-end"><button type="button" className="btn-primary" disabled={sendingId !== null} onClick={() => navigate('/orders')}>סיום</button></div>
      </Modal>

      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)} onConfirm={(reason) => void cancelDraft(reason)}
        title="ביטול טיוטה" message="הטיוטה תבוטל ולא תופיע עוד להמשך. הפעולה תתועד ביומן הביקורת."
        confirmLabel="ביטול הטיוטה" danger requireReason busy={busy} />
    </div>
  );
}

/** Client-only guard: the server does not enforce min_qty, so the editor must not order below it. */
function meetsMin(offer: SupplierProduct, qty: number): boolean {
  return offer.min_qty == null || qty >= offer.min_qty;
}

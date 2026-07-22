import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, CheckCircle2, Clock3, Loader2, MessageCircle, Minus, Plus, Search, Split, Trash2, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { ConfirmDialog, ErrorNote, Modal, PageLoader, useToast } from '../components/ui';
import { useCategories } from './Suppliers';
import { fmtMoneyExact, todayISO } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import {
  cancelOrderDraft,
  finalizeOrderDraft,
  ORDER_DRAFT_FLUSH_EVENT,
  saveOrderDraft,
  type DraftItemInput,
  type OrderDraftFlushDetail,
} from '../lib/orderDrafts';
import { calculateOrderSavings } from '../lib/orderSavings';
import { sendOrderWhatsApp } from '../lib/share';
import type { Product, PurchaseOrder, Supplier, SupplierProduct } from '../lib/types';

interface CartItem {
  product: Product;
  qty: number;
  chosenSupplierId: string | null;
}

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
  const [cart, setCart] = useState<CartItem[]>([]);
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
    for (const offers of map.values()) offers.sort((a, b) => a.current_price - b.current_price);
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
        return [{ product: item.product, qty: item.qty, chosenSupplierId: sourceStillAvailable ? data.source!.supplier_id : null }];
      });
      nextNotes = data.source.notes ?? '';
      nextExpectedDate = data.source.expected_date ?? '';
      if (skipped) toast(`${skipped} פריטים מההזמנה המקורית דולגו — המוצר כבר אינו קיים`);
    } else if (data.draft) {
      nextCart = data.draft.items.flatMap((item) => {
        if (!item.product?.active) { draftNeedsRepair = true; return []; }
        return [{ product: item.product, qty: item.qty, chosenSupplierId: item.chosen_supplier_id }];
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
      items: nextCart.map((item) => ({ product_id: item.product.id, qty: item.qty, chosen_supplier_id: item.chosenSupplierId })),
    };
    latestDraftRef.current = snapshot;
    lastSavedSignatureRef.current = nextDraftId && !draftNeedsRepair ? draftSignature(snapshot) : '';
    finalizedRef.current = false;
    setCart(nextCart);
    setNotes(nextNotes);
    setExpectedDate(nextExpectedDate);
    setStep(nextStep);
    setDraftId(nextDraftId);
    setDraftNumber(nextDraftNumber);
    setSaveError('');
    setSaveStatus(nextDraftId ? 'saved' : 'idle');
    setHydrated(true);
  }, [data, explicitDraftId, loadKey, offersByProduct, toast]);

  const draftItems = useMemo<DraftItemInput[]>(() => cart.map((item) => ({
    product_id: item.product.id,
    qty: item.qty,
    chosen_supplier_id: item.chosenSupplierId,
  })), [cart]);
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

  const filteredProducts = (data?.products ?? []).filter((product) =>
    (!cat || product.category_id === cat) && (!q || product.name.toLowerCase().includes(q.toLowerCase())));
  const cartByProduct = useMemo(() => new Map(cart.map((item) => [item.product.id, item])), [cart]);

  function effective(item: CartItem): { sp: SupplierProduct | null; recommended: SupplierProduct | null } {
    const offers = offersByProduct.get(item.product.id) ?? [];
    const recommended = offers[0] ?? null;
    const sp = item.chosenSupplierId ? offers.find((offer) => offer.supplier_id === item.chosenSupplierId) ?? null : recommended;
    return { sp, recommended };
  }

  const split = useMemo(() => {
    const groups = new Map<string, { supplier: Supplier; items: { item: CartItem; sp: SupplierProduct }[]; subtotal: number }>();
    const noSupplier: CartItem[] = [];
    for (const item of cart) {
      const offers = offersByProduct.get(item.product.id) ?? [];
      const sp = item.chosenSupplierId ? offers.find((offer) => offer.supplier_id === item.chosenSupplierId) ?? null : offers[0] ?? null;
      if (!sp) { noSupplier.push(item); continue; }
      const supplier = supplierById.get(sp.supplier_id);
      if (!supplier) { noSupplier.push(item); continue; }
      const group = groups.get(supplier.id) ?? { supplier, items: [], subtotal: 0 };
      group.items.push({ item, sp });
      group.subtotal += sp.current_price * item.qty;
      groups.set(supplier.id, group);
    }
    return { groups: [...groups.values()], noSupplier };
  }, [cart, offersByProduct, supplierById]);
  const total = split.groups.reduce((sum, group) => sum + group.subtotal, 0);
  const savings = useMemo(() => calculateOrderSavings(cart.map((item) => ({
    productId: item.product.id,
    qty: item.qty,
    chosenSupplierId: item.chosenSupplierId,
    offers: (offersByProduct.get(item.product.id) ?? []).map((offer) => ({ supplierId: offer.supplier_id, unitPrice: offer.current_price })),
  }))), [cart, offersByProduct]);
  const singleSupplierName = savings.singleSupplierId ? supplierById.get(savings.singleSupplierId)?.name ?? null : null;

  async function openReview() {
    if (!cart.length || split.noSupplier.length) return;
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
    if (!result.opened) { toast('לספק אין מספר WhatsApp זמין', 'error'); return; }
    if (result.error) { toast(result.error, 'error'); return; }
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
          <div className={`mt-2 flex min-h-6 items-center gap-1.5 text-xs ${saveStatus === 'error' ? 'text-alert-fg' : 'text-ink-muted'}`} aria-live="polite">
            {saveStatus === 'saving' ? <Loader2 size={13} className="animate-spin" /> : saveStatus === 'saved' ? <Check size={13} /> : <Clock3 size={13} />}
            <span>{draftNumber ? `טיוטה #${draftNumber} · ` : ''}{saveLabel}</span>
            {saveStatus === 'error' && <button type="button" className="font-semibold underline" onClick={() => void runSaveQueue()}>ניסיון חוזר</button>}
          </div>
          {saveError && saveStatus === 'error' && <p className="text-xs text-alert-fg">{saveError}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {(draftId || cart.length > 0) && <button type="button" className="btn-ghost text-alert-solid" disabled={busy} onClick={() => setCancelOpen(true)}><XCircle size={15} /> ביטול טיוטה</button>}
          <button type="button" className="btn-primary" disabled={busy || !cart.length || split.noSupplier.length > 0} onClick={() => void openReview()}>
            <CheckCircle2 size={15} /> סקירה ואישור
          </button>
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
        <section aria-labelledby="product-picker-title" className="border-y border-line-strong bg-surface">
          <div className="space-y-3 border-b border-line-soft p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="product-picker-title" className="section-title">בחירת מוצרים</h2>
              <span className="text-sm text-ink-muted"><span className="num font-semibold text-ink">{cart.length}</span> מוצרים נבחרו</span>
            </div>
            <div className="relative">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-faint" aria-hidden="true" />
              <input className="input ps-9!" aria-label="חיפוש מוצר" placeholder="חיפוש מוצר..." value={q} onChange={(event) => setQ(event.target.value)} />
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="סינון לפי קטגוריה">
              <button type="button" className={`min-h-11 border px-3 text-xs font-medium ${!cat ? 'border-action bg-action text-white' : 'border-line text-ink-soft hover:bg-surface-sunken'}`} onClick={() => setCat('')}>הכול</button>
              {categories?.map((category) => (
                <button type="button" key={category.id} className={`min-h-11 border px-3 text-xs font-medium ${cat === category.id ? 'border-action bg-action text-white' : 'border-line text-ink-soft hover:bg-surface-sunken'}`} onClick={() => setCat(category.id)}>{category.name}</button>
              ))}
            </div>
          </div>

          <div className="max-h-[32rem] divide-y divide-line-soft overflow-y-auto">
            {filteredProducts.map((product) => {
              const offers = offersByProduct.get(product.id) ?? [];
              const carted = cartByProduct.get(product.id);
              return (
                <div key={product.id} className={`flex min-h-14 items-center ${carted ? 'bg-action-wash/45' : ''}`}>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-start hover:bg-surface-sunken sm:px-4"
                    onClick={() => { if (!carted) setCart((current) => [...current, { product, qty: 1, chosenSupplierId: null }]); }}>
                    <span className={`grid size-6 shrink-0 place-items-center border ${carted ? 'border-done-line bg-done-soft text-done-fg' : 'border-line text-transparent'}`} aria-hidden="true"><Check size={14} /></span>
                    <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium text-ink-body sm:truncate">{product.name}</span><span className="text-xs text-ink-muted">{product.unit}</span></span>
                    <span className="shrink-0 text-xs text-ink-muted num">{offers.length ? `₪${offers[0].current_price.toFixed(2)}` : 'אין ספק'}</span>
                  </button>
                  {carted && (
                    <div className="me-3 flex shrink-0 items-center border border-line-strong bg-surface sm:me-4" aria-label={`כמות ${product.name}`}>
                      <button type="button" className="grid size-11 place-items-center hover:bg-surface-sunken" aria-label={`הפחתת כמות ${product.name}`} onClick={() => setCart((current) => current.flatMap((item) => item.product.id !== product.id ? [item] : item.qty > 1 ? [{ ...item, qty: item.qty - 1 }] : []))}><Minus size={14} /></button>
                      <span className="min-w-10 border-x border-line py-2 text-center text-sm font-semibold num">{carted.qty}</span>
                      <button type="button" className="grid size-11 place-items-center hover:bg-surface-sunken" aria-label={`הוספת כמות ${product.name}`} onClick={() => setCart((current) => current.map((item) => item.product.id === product.id ? { ...item, qty: item.qty + 1 } : item))}><Plus size={14} /></button>
                    </div>
                  )}
                </div>
              );
            })}
            {!filteredProducts.length && <div className="px-4 py-10 text-center text-sm text-ink-muted">לא נמצאו מוצרים</div>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-strong px-3 py-3 sm:px-4">
            <div className="text-sm text-ink-muted">{cart.length ? `${cart.length} מוצרים מוכנים לשלב הספקים` : 'בחר לפחות מוצר אחד'}</div>
            <button type="button" className="btn-primary" disabled={!cart.length} onClick={() => setStep(2)}>המשך לספקים</button>
          </div>
        </section>
      ) : (
        <div className="space-y-4">
          <section aria-labelledby="selected-products-title" className="border-y border-line-strong bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-3 py-3 sm:px-4">
              <h2 id="selected-products-title" className="section-title">פריטים וספקים</h2>
              <span className="text-sm text-ink-muted">סה״כ משוער <b className="num text-ink">{fmtMoneyExact(total)}</b></span>
            </div>
            <div className="divide-y divide-line-soft">
              {cart.map((item, index) => {
                const offers = offersByProduct.get(item.product.id) ?? [];
                const { sp, recommended } = effective(item);
                return (
                  <div key={item.product.id} className="grid items-center gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_5rem_minmax(13rem,1fr)_7rem_2.75rem] sm:px-4">
                    <div className="min-w-0"><div className="break-words text-sm font-medium text-ink-body sm:truncate">{item.product.name}</div><div className="text-xs text-ink-muted">{item.product.unit}</div></div>
                    <div className="text-sm"><span className="text-ink-muted">כמות </span><b className="num">{item.qty}</b></div>
                    <select className="input" aria-label={`ספק עבור ${item.product.name}`} value={item.chosenSupplierId ?? ''}
                      onChange={(event) => setCart((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, chosenSupplierId: event.target.value || null } : row))}>
                      <option value="">{recommended ? `הזול ביותר: ${supplierById.get(recommended.supplier_id)?.name} — ₪${recommended.current_price.toFixed(2)}` : 'אין ספק זמין'}</option>
                      {offers.map((offer) => <option key={offer.id} value={offer.supplier_id}>{supplierById.get(offer.supplier_id)?.name} — ₪{offer.current_price.toFixed(2)}</option>)}
                    </select>
                    <div className="text-sm font-semibold num">{sp ? fmtMoneyExact(sp.current_price * item.qty) : '—'}</div>
                    <button type="button" className="grid size-11 place-items-center text-ink-faint hover:bg-surface-sunken hover:text-alert-solid" onClick={() => setCart((current) => current.filter((_, rowIndex) => rowIndex !== index))} aria-label={`הסרת ${item.product.name}`}><Trash2 size={15} /></button>
                  </div>
                );
              })}
            </div>
          </section>

          <SupplierComparison cart={cart} offersByProduct={offersByProduct} supplierById={supplierById} effective={effective} />

          <section aria-labelledby="supplier-split-title" className="border-y border-line-strong bg-surface">
            <div className="flex items-center gap-2 border-b border-line-soft px-3 py-3 sm:px-4"><Split size={17} aria-hidden="true" /><h2 id="supplier-split-title" className="section-title">פיצול הזמנות לספקים</h2></div>
            {split.noSupplier.length > 0 && <div className="flex items-start gap-2 border-b border-alert-line bg-alert-wash px-3 py-2.5 text-sm text-alert-fg sm:px-4"><AlertTriangle size={16} className="mt-0.5 shrink-0" />ללא ספק זמין: {split.noSupplier.map((item) => item.product.name).join(', ')}</div>}
            <div className="divide-y divide-line-soft">
              {split.groups.map((group) => {
                const underMin = group.supplier.min_order_amount != null && group.subtotal < group.supplier.min_order_amount;
                return (
                  <div key={group.supplier.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 sm:px-4 ${underMin ? 'bg-await-wash' : ''}`}>
                    <span className="font-medium text-ink-body">{group.supplier.name}</span><span className="text-xs text-ink-muted">{group.items.length} פריטים</span>
                    <span className="ms-auto font-semibold num">{fmtMoneyExact(group.subtotal)}</span>
                    {underMin && <span className="w-full text-xs text-await-fg">מתחת למינימום הזמנה של {fmtMoneyExact(group.supplier.min_order_amount!)}</span>}
                  </div>
                );
              })}
            </div>
          </section>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2"><label className="label">הערות</label><input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="למשל: אספקה לכניסה הראשית" /></div>
            <div><label className="label">אספקה מבוקשת</label><input type="date" className="input" value={expectedDate} min={todayISO()} onChange={(event) => setExpectedDate(event.target.value)} /></div>
          </div>
          <div className="flex items-center border-t border-line-strong bg-surface px-3 py-3 sm:px-4">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setStep(1)}>חזרה למוצרים וכמויות</button>
            <span className="ms-auto text-xs text-ink-muted">האישור נמצא בראש המסך</span>
          </div>
        </div>
      )}

      <Modal open={reviewOpen} onClose={() => { if (!busy) setReviewOpen(false); }} title="סיכום ההזמנה">
        <div className="divide-y divide-line-soft border-y border-line-strong text-sm">
          <SummaryRow label="מספר ספקים" value={String(savings.supplierCount)} />
          <SummaryRow label="מספר מוצרים" value={String(cart.length)} />
          <SummaryRow label="עלות לאחר חלוקה" value={fmtMoneyExact(savings.splitTotal)} />
          <SummaryRow label="מחיר אצל ספק יחיד" value={savings.singleSupplierTotal === null ? '—' : `${fmtMoneyExact(savings.singleSupplierTotal)}${singleSupplierName ? ` · ${singleSupplierName}` : ''}`} />
          <SummaryRow label={savings.savings !== null && savings.savings < 0 ? 'תוספת עלות לעומת ספק יחיד' : 'חיסכון לעומת ספק יחיד'}
            value={savings.savings === null ? '—' : `${fmtMoneyExact(Math.abs(savings.savings))} (${Math.abs(savings.savingsPercent ?? 0).toFixed(1)}%)`} />
          <SummaryRow label="כל המוצרים הוקצו לספק הזול ביותר" value={savings.allCheapest ? '✓ כן' : 'לא'} tone={savings.allCheapest ? 'done' : 'await'} />
        </div>
        {savings.singleSupplierTotal === null && <p className="mt-3 text-sm text-ink-muted">אין ספק יחיד שמציע את כל מוצרי הסל, ולכן לא מוצגת טענת חיסכון.</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setReviewOpen(false)}>חזרה לעריכה</button>
          <button type="button" className="btn-primary" disabled={busy || savings.splitTotal === null} onClick={() => void finalizeDraft()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} אשר ושלח הזמנה
          </button>
        </div>
      </Modal>

      <Modal open={sendQueue !== null} onClose={() => navigate('/orders')} title="שליחת הזמנות לספקים">
        <p className="mb-3 text-sm text-ink-soft">כל הזמנה תסומן כנשלחה רק לאחר פתיחת הודעת WhatsApp שלה.</p>
        <div className="divide-y divide-line-soft border-y border-line-strong">
          {sendQueue?.map((order) => {
            const hasWhatsApp = !!(order.supplier.whatsapp || order.supplier.phone);
            return (
              <div key={order.id} className="flex flex-wrap items-center gap-2 py-3">
                <div><div className="font-medium text-ink-body">{order.supplier.name}</div><div className="text-xs text-ink-muted">הזמנה #{order.number}</div></div>
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

function SummaryRow({ label, value, tone }: { label: string; value: string; tone?: 'done' | 'await' }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 py-3"><span className="text-ink-muted">{label}</span><strong className={`num text-end ${tone === 'done' ? 'text-done-fg' : tone === 'await' ? 'text-await-fg' : 'text-ink'}`}>{value}</strong></div>;
}

function SupplierComparison({ cart, offersByProduct, supplierById, effective }: {
  cart: CartItem[];
  offersByProduct: Map<string, SupplierProduct[]>;
  supplierById: Map<string, Supplier>;
  effective: (item: CartItem) => { sp: SupplierProduct | null; recommended: SupplierProduct | null };
}) {
  const rows = cart.map((item) => {
    const { sp } = effective(item);
    const cheapest = (offersByProduct.get(item.product.id) ?? [])[0] ?? null;
    const delta = sp && cheapest ? Math.max(0, (sp.current_price - cheapest.current_price) * item.qty) : 0;
    return { item, sp, cheapest, delta };
  });
  if (!rows.length) return null;
  const saving = rows.reduce((sum, row) => sum + row.delta, 0);
  return (
    <section aria-labelledby="supplier-comparison-title" className="border-y border-line-strong bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line-soft px-3 py-3 sm:px-4">
        <div><h2 id="supplier-comparison-title" className="section-title">השוואת מחיר לכל מוצר</h2><p className="mt-0.5 text-xs text-ink-muted">המחיר נשמר בהזמנה לפי הספק שנבחר ברגע השליחה.</p></div>
        <div className="text-start sm:text-end"><span className="block text-xs text-ink-muted">חיסכון אפשרי בבחירה הזולה</span><strong className={`num text-base ${saving > 0 ? 'text-await-fg' : 'text-done-fg'}`}>{fmtMoneyExact(saving)}</strong></div>
      </div>
      <div className="divide-y divide-line-soft">
        {rows.map(({ item, sp, cheapest, delta }) => {
          const selectedName = sp ? supplierById.get(sp.supplier_id)?.name ?? 'ספק לא זמין' : 'לא נבחר ספק';
          const cheapestName = cheapest ? supplierById.get(cheapest.supplier_id)?.name ?? 'ספק לא זמין' : null;
          const selectedIsCheapest = !!sp && !!cheapest && sp.current_price === cheapest.current_price;
          return (
            <div key={item.product.id} className="grid gap-2 px-3 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center sm:px-4">
              <div className="min-w-0"><div className="font-medium text-ink-body">{item.product.name}</div><div className="mt-0.5 text-xs text-ink-muted">כמות <span className="num">{item.qty}</span></div></div>
              {cheapest ? <div className="min-w-0"><div className="text-xs text-ink-muted">המחיר הזול ביותר</div><div className="mt-0.5 text-ink-body">{cheapestName} · <span className="num font-medium">{fmtMoneyExact(cheapest.current_price)}</span></div></div>
                : <div className="text-alert-fg">אין הצעת מחיר פעילה למוצר</div>}
              <div className="sm:min-w-40 sm:text-end">
                {sp ? <><div className="text-xs text-ink-muted">נבחר: {selectedName} · <span className="num">{fmtMoneyExact(sp.current_price)}</span></div><div className={`mt-0.5 font-medium ${selectedIsCheapest ? 'text-done-fg' : 'text-await-fg'}`}>{selectedIsCheapest ? 'הבחירה הזולה ביותר' : `אפשר לחסוך ${fmtMoneyExact(delta)}`}</div></>
                  : <div className="font-medium text-alert-fg">לא ניתן להזמין כרגע</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

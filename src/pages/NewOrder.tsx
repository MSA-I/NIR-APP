import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Trash2, AlertTriangle, Split, Plus, Minus, Check } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { PageLoader, useToast, ErrorNote } from '../components/ui';
import { useCategories } from './Suppliers';
import { fmtMoneyExact, todayISO } from '../lib/format';
import type { Product, Supplier, SupplierProduct } from '../lib/types';

interface CartItem {
  product: Product;
  qty: number;
  chosenSupplierId: string | null; // null = follow recommendation
}

export default function NewOrder() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromOrderId = params.get('from'); // ?from=<orderId> — duplicate an existing order into the cart
  const seededRef = useRef(false);
  const { profile } = useAuth();
  const toast = useToast();
  const { data: categories } = useCategories();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notes, setNotes] = useState('');
  // Requested delivery date (OPEN-DECISIONS #32): the date WE ask for. Written to every split
  // order's expected_date, which the supplier on-time metric measures against. Optional — blank
  // leaves the metric as "—" for that order rather than a false 0%.
  const [expectedDate, setExpectedDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);

  useEffect(() => {
    if (step === 2 && cart.length === 0) setStep(1);
  }, [cart.length, step]);

  const { data, loading, error } = useQuery(async () => {
    const [products, sps, suppliers] = await Promise.all([
      supabase.from('products').select('*').eq('active', true).order('name'),
      supabase.from('supplier_products').select('*').eq('available', true),
      supabase.from('suppliers').select('*').is('deleted_at', null).in('status', ['active', 'problematic']),
    ]);
    return {
      products: unwrap(products) as Product[],
      sps: unwrap(sps) as SupplierProduct[],
      suppliers: unwrap(suppliers) as Supplier[],
    };
  });

  const supplierById = useMemo(() => new Map((data?.suppliers ?? []).map((s) => [s.id, s])), [data]);
  const offersByProduct = useMemo(() => {
    const map = new Map<string, SupplierProduct[]>();
    for (const sp of data?.sps ?? []) {
      if (!supplierById.has(sp.supplier_id)) continue;
      const arr = map.get(sp.product_id) ?? [];
      arr.push(sp);
      map.set(sp.product_id, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.current_price - b.current_price);
    return map;
  }, [data, supplierById]);

  // ?from=<orderId> ("שכפול" on the Orders list): seed the cart with the source order's items,
  // pinned to the source supplier. Only products that are still active AND still have an offer
  // enter the cart; when the source supplier no longer offers a product the item falls back to
  // the recommendation (null) instead of landing in the "אין ספק" bucket. Skipped items are
  // reported in one short toast — never silently different from the source order without a word.
  useEffect(() => {
    if (!fromOrderId || !data || seededRef.current) return;
    seededRef.current = true;
    void (async () => {
      const res = await supabase.from('purchase_orders')
        .select('supplier_id, items:purchase_order_items(product_id, qty)')
        .eq('id', fromOrderId).maybeSingle();
      if (res.error || !res.data) { toast('טעינת הזמנת המקור נכשלה', 'error'); return; }
      const src = res.data as unknown as { supplier_id: string; items: { product_id: string; qty: number }[] };
      const productById = new Map(data.products.map((p) => [p.id, p]));
      const items: CartItem[] = [];
      let skipped = 0;
      for (const it of src.items) {
        const product = productById.get(it.product_id);
        const offers = offersByProduct.get(it.product_id) ?? [];
        if (!product || offers.length === 0) { skipped++; continue; }
        const srcSupplierOffers = offers.some((o) => o.supplier_id === src.supplier_id);
        items.push({ product, qty: it.qty, chosenSupplierId: srcSupplierOffers ? src.supplier_id : null });
      }
      setCart(items);
      if (skipped > 0) toast(`${skipped} פריטים מההזמנה המקורית דולגו — המוצר אינו פעיל או שאין לו ספק זמין`);
    })();
  }, [fromOrderId, data, offersByProduct, toast]);

  // Carted products stay visible in the picker (in a "carted" state with an inline stepper) —
  // hiding them gave zero feedback on tap and forced a scroll down to the cart to fix a quantity.
  const filteredProducts = (data?.products ?? []).filter((p) =>
    (!cat || p.category_id === cat) &&
    (!q || p.name.toLowerCase().includes(q.toLowerCase())));

  const cartByProduct = useMemo(() => new Map(cart.map((c) => [c.product.id, c])), [cart]);

  function addToCart(p: Product) {
    setCart((c) => [...c, { product: p, qty: 1, chosenSupplierId: null }]);
  }

  // Shared qty logic for picker rows and cart rows — one source of truth, no duplication.
  function incQty(productId: string) {
    setCart((c) => c.map((x) => (x.product.id === productId ? { ...x, qty: x.qty + 1 } : x)));
  }

  // Minus at qty 1 removes the item entirely — same behavior in the picker and in the cart.
  function decQty(productId: string) {
    setCart((c) => c.flatMap((x) =>
      x.product.id !== productId ? [x] : x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : []));
  }

  function effective(item: CartItem): { sp: SupplierProduct | null; recommended: SupplierProduct | null } {
    const offers = offersByProduct.get(item.product.id) ?? [];
    const recommended = offers[0] ?? null;
    const sp = item.chosenSupplierId ? offers.find((o) => o.supplier_id === item.chosenSupplierId) ?? null : recommended;
    return { sp, recommended };
  }

  // Split preview: group by supplier
  const split = useMemo(() => {
    const groups = new Map<string, { supplier: Supplier; items: { item: CartItem; sp: SupplierProduct }[]; subtotal: number }>();
    let noSupplier: CartItem[] = [];
    for (const item of cart) {
      const { sp } = effective(item);
      if (!sp) { noSupplier.push(item); continue; }
      const supplier = supplierById.get(sp.supplier_id)!;
      const g = groups.get(supplier.id) ?? { supplier, items: [], subtotal: 0 };
      g.items.push({ item, sp });
      g.subtotal += sp.current_price * item.qty;
      groups.set(supplier.id, g);
    }
    return { groups: [...groups.values()], noSupplier };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, offersByProduct, supplierById]);

  const total = split.groups.reduce((s, g) => s + g.subtotal, 0);

  async function saveRequest(splitToOrders: boolean) {
    if (!cart.length) return;
    setBusy(true);
    try {
      const req = unwrap(await supabase.from('purchase_requests').insert({
        org_id: profile!.org_id, status: splitToOrders ? 'split' : 'draft', notes: notes || null, created_by: profile!.id,
      }).select('id').single()) as { id: string };

      const itemRows = cart.map((item) => {
        const { sp, recommended } = effective(item);
        return {
          request_id: req.id, product_id: item.product.id, qty: item.qty,
          recommended_supplier_id: recommended?.supplier_id ?? null,
          chosen_supplier_id: sp?.supplier_id ?? null,
          unit_price: sp?.current_price ?? null,
        };
      });
      const ins = await supabase.from('purchase_request_items').insert(itemRows);
      if (ins.error) throw new Error(ins.error.message);

      if (splitToOrders) {
        for (const g of split.groups) {
          const po = unwrap(await supabase.from('purchase_orders').insert({
            org_id: profile!.org_id, supplier_id: g.supplier.id, request_id: req.id,
            status: 'ready', expected_date: expectedDate || null, notes: notes || null, created_by: profile!.id,
          }).select('id').single()) as { id: string };
          const poItems = g.items.map(({ item, sp }) => ({
            order_id: po.id, product_id: item.product.id, qty: item.qty, unit_price: sp.current_price,
          }));
          const insItems = await supabase.from('purchase_order_items').insert(poItems);
          if (insItems.error) throw new Error(insItems.error.message);
        }
        toast(`נוצרו ${split.groups.length} הזמנות ספק`);
        navigate('/orders');
      } else {
        toast('הרשימה נשמרה כטיוטה');
        navigate('/orders');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'שגיאה בשמירה', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="page-title">הזמנה חדשה</h1>
        <p className="mt-1 text-sm text-ink-muted">בחירת מוצרים תחילה, אישור ספקים ומחירים לאחר מכן</p>
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
                    onClick={() => { if (!carted) addToCart(product); }}>
                    <span className={`grid size-6 shrink-0 place-items-center border ${carted ? 'border-done-line bg-done-soft text-done-fg' : 'border-line text-transparent'}`} aria-hidden="true">
                      <Check size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium text-ink-body sm:truncate">{product.name}</span>
                      <span className="text-xs text-ink-muted">{product.unit}</span>
                    </span>
                    <span className="shrink-0 text-xs text-ink-muted num">{offers.length ? `₪${offers[0].current_price.toFixed(2)}` : 'אין ספק'}</span>
                  </button>
                  {carted && (
                    <div className="me-3 flex shrink-0 items-center border border-line-strong bg-surface sm:me-4" aria-label={`כמות ${product.name}`}>
                      <button type="button" className="grid size-11 place-items-center hover:bg-surface-sunken" aria-label={`הפחתת כמות ${product.name}`} onClick={() => decQty(product.id)}><Minus size={14} /></button>
                      <span className="min-w-10 border-x border-line py-2 text-center text-sm font-semibold num">{carted.qty}</span>
                      <button type="button" className="grid size-11 place-items-center hover:bg-surface-sunken" aria-label={`הוספת כמות ${product.name}`} onClick={() => incQty(product.id)}><Plus size={14} /></button>
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
                    <span className="font-medium text-ink-body">{group.supplier.name}</span>
                    <span className="text-xs text-ink-muted">{group.items.length} פריטים</span>
                    <span className="ms-auto font-semibold num">{fmtMoneyExact(group.subtotal)}</span>
                    {underMin && <span className="w-full text-xs text-await-fg">מתחת למינימום הזמנה של {fmtMoneyExact(group.supplier.min_order_amount!)}</span>}
                  </div>
                );
              })}
            </div>
          </section>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2"><label className="label">הערות</label><input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="למשל: אירוע יום חמישי — 300 אורחים" /></div>
            <div><label className="label">אספקה מבוקשת</label><input type="date" className="input" value={expectedDate} min={todayISO()} onChange={(event) => setExpectedDate(event.target.value)} /></div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-strong bg-surface px-3 py-3 sm:px-4">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setStep(1)}>חזרה למוצרים וכמויות</button>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void saveRequest(false)}>שמירה כטיוטה</button>
              <button type="button" className="btn-primary" disabled={busy || split.groups.length === 0} onClick={() => void saveRequest(true)}><Split size={15} /> יצירת {split.groups.length} הזמנות ספק</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* Explicit "who is cheapest" summary (CLAUDE.md §12): before saving, the manager sees per item
   whether the chosen supplier is the cheapest offer and what switching would save — a decision
   surface, not decoration. Items without any offer are skipped (the "אין ספק" note covers them). */
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
        <div>
          <h2 id="supplier-comparison-title" className="section-title">השוואת מחיר לכל מוצר</h2>
          <p className="mt-0.5 text-xs text-ink-muted">המחיר נשמר בהזמנה לפי הספק שנבחר ברגע השליחה.</p>
        </div>
        <div className="text-start sm:text-end">
          <span className="block text-xs text-ink-muted">חיסכון אפשרי</span>
          <strong className={`num text-base ${saving > 0 ? 'text-await-fg' : 'text-done-fg'}`}>{fmtMoneyExact(saving)}</strong>
        </div>
      </div>
      <div className="divide-y divide-line-soft">
        {rows.map(({ item, sp, cheapest, delta }) => {
          const selectedName = sp ? supplierById.get(sp.supplier_id)?.name ?? 'ספק לא זמין' : 'לא נבחר ספק';
          const cheapestName = cheapest ? supplierById.get(cheapest.supplier_id)?.name ?? 'ספק לא זמין' : null;
          const selectedIsCheapest = !!sp && !!cheapest && sp.supplier_id === cheapest.supplier_id;
          return (
            <div key={item.product.id} className="grid gap-2 px-3 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center sm:px-4">
              <div className="min-w-0">
                <div className="font-medium text-ink-body">{item.product.name}</div>
                <div className="mt-0.5 text-xs text-ink-muted">כמות <span className="num">{item.qty}</span></div>
              </div>
              {cheapest ? (
                <div className="min-w-0">
                  <div className="text-xs text-ink-muted">המחיר הזול ביותר</div>
                  <div className="mt-0.5 text-ink-body">{cheapestName} · <span className="num font-medium">{fmtMoneyExact(cheapest.current_price)}</span></div>
                </div>
              ) : (
                <div className="text-alert-fg">אין הצעת מחיר פעילה למוצר</div>
              )}
              <div className="sm:min-w-40 sm:text-end">
                {sp ? (
                  <>
                    <div className="text-xs text-ink-muted">נבחר: {selectedName} · <span className="num">{fmtMoneyExact(sp.current_price)}</span></div>
                    <div className={`mt-0.5 font-medium ${selectedIsCheapest ? 'text-done-fg' : 'text-await-fg'}`}>
                      {selectedIsCheapest ? 'הבחירה הזולה ביותר' : `אפשר לחסוך ${fmtMoneyExact(delta)}`}
                    </div>
                  </>
                ) : (
                  <div className="font-medium text-alert-fg">לא ניתן להזמין כרגע</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

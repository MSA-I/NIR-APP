import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Trash2, AlertTriangle, Split, Plus, Minus, Check } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { PageLoader, useToast, ErrorNote, Note } from '../components/ui';
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
    <div className="space-y-4">
      <h1 className="page-title">הזמנה חדשה</h1>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
        {/* Product picker */}
        <div className="card lg:col-span-2 overflow-hidden">
          <div className="p-3 border-b border-line-soft space-y-2">
            <div className="relative">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-faint" />
              <input className="input ps-9!" placeholder="חיפוש מוצר..." value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="flex gap-1.5 flex-wrap">
              <button className={`badge ${!cat ? 'bg-action-solid text-white' : 'bg-idle-soft text-ink-soft'}`} onClick={() => setCat('')}>הכל</button>
              {categories?.map((c) => (
                <button key={c.id} className={`badge ${cat === c.id ? 'bg-action-solid text-white' : 'bg-idle-soft text-ink-soft'}`} onClick={() => setCat(c.id)}>{c.name}</button>
              ))}
            </div>
          </div>
          <div className="max-h-[26rem] overflow-y-auto divide-y divide-line-soft">
            {filteredProducts.map((p) => {
              const offers = offersByProduct.get(p.id) ?? [];
              const carted = cartByProduct.get(p.id);
              // The stepper buttons are siblings of the row-body button (nested buttons are
              // invalid HTML); body click adds / increments, the stepper fine-tunes in place.
              return (
                <div key={p.id} className={`flex items-center ${carted ? 'bg-action-wash/60' : ''}`}>
                  <button
                    className={`flex-1 min-w-0 flex items-center justify-between gap-3 px-4 py-2.5 text-start ${carted ? 'hover:bg-action-wash' : 'hover:bg-action-wash/50'}`}
                    onClick={() => (carted ? incQty(p.id) : addToCart(p))}>
                    <span className="flex items-center gap-1.5 min-w-0">
                      {carted && <Check size={14} className="text-done-fg shrink-0" aria-hidden="true" />}
                      <span className="text-sm font-medium text-ink-body truncate">{p.name}</span>
                      <span className="text-xs text-ink-muted shrink-0">{p.unit}</span>
                    </span>
                    <span className="text-xs text-ink-muted num shrink-0">
                      {offers.length ? `₪${offers[0].current_price.toFixed(2)}` : 'אין ספק'}
                    </span>
                  </button>
                  {carted && (
                    <div className="flex items-center gap-0.5 pe-2 shrink-0">
                      <button className="btn-ghost p-1.5! min-w-10 min-h-10" aria-label="הפחת כמות"
                        onClick={(e) => { e.stopPropagation(); decQty(p.id); }}><Minus size={14} /></button>
                      <span className="num text-sm font-medium min-w-6">{carted.qty}</span>
                      <button className="btn-ghost p-1.5! min-w-10 min-h-10" aria-label="הוסף כמות"
                        onClick={(e) => { e.stopPropagation(); incQty(p.id); }}><Plus size={14} /></button>
                    </div>
                  )}
                </div>
              );
            })}
            {!filteredProducts.length && <div className="px-4 py-8 text-center text-sm text-ink-muted">לא נמצאו מוצרים</div>}
          </div>
        </div>

        {/* Cart + split preview */}
        <div className="lg:col-span-3 space-y-4">
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-line-soft flex items-center justify-between">
              <span className="section-title">פריטים ברשימה ({cart.length})</span>
              <span className="text-sm text-ink-muted">סה״כ משוער: <b className="num">{fmtMoneyExact(total)}</b></span>
            </div>
            {cart.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-ink-muted">בחר מוצרים מהרשימה משמאל כדי להתחיל</div>
            ) : (
              <div className="divide-y divide-line-soft">
                {cart.map((item, idx) => {
                  const offers = offersByProduct.get(item.product.id) ?? [];
                  const { sp, recommended } = effective(item);
                  return (
                    <div key={item.product.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                      <div className="flex-1 min-w-40">
                        <div className="text-sm font-medium text-ink-body">{item.product.name}</div>
                        <div className="text-xs text-ink-muted">{item.product.unit}</div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button className="btn-secondary p-1.5! min-w-10 min-h-10" onClick={() => decQty(item.product.id)} aria-label="הפחת כמות"><Minus size={14} /></button>
                        <input type="number" min={0.1} step="any" className="input w-20! num text-center" value={item.qty}
                          onChange={(e) => setCart((c) => c.map((x, i) => i === idx ? { ...x, qty: Number(e.target.value) || 1 } : x))} />
                        <button className="btn-secondary p-1.5! min-w-10 min-h-10" onClick={() => incQty(item.product.id)} aria-label="הוסף כמות"><Plus size={14} /></button>
                      </div>
                      <select className="input sm:w-56!" value={item.chosenSupplierId ?? ''}
                        onChange={(e) => setCart((c) => c.map((x, i) => i === idx ? { ...x, chosenSupplierId: e.target.value || null } : x))}>
                        <option value="">
                          {recommended ? `מומלץ: ${supplierById.get(recommended.supplier_id)?.name} — ₪${recommended.current_price.toFixed(2)}` : 'אין ספק זמין'}
                        </option>
                        {offers.map((o) => (
                          <option key={o.id} value={o.supplier_id}>
                            {supplierById.get(o.supplier_id)?.name} — ₪{o.current_price.toFixed(2)}
                          </option>
                        ))}
                      </select>
                      <div className="w-24 text-sm font-medium num ms-auto">{sp ? fmtMoneyExact(sp.current_price * item.qty) : '—'}</div>
                      <button className="btn-ghost p-1.5! min-w-10 min-h-10 text-ink-faint hover:text-alert-solid" onClick={() => setCart((c) => c.filter((_, i) => i !== idx))} aria-label="הסרה"><Trash2 size={15} /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {cart.length > 0 && (
            <div className="card card-pad space-y-3">
              <div className="section-title flex items-center gap-2"><Split size={17} /> פיצול לפי ספקים</div>
              {split.noSupplier.length > 0 && (
                <Note tone="alert">
                  ללא ספק זמין: {split.noSupplier.map((i) => i.product.name).join(', ')}
                </Note>
              )}
              <div className="space-y-2">
                {split.groups.map((g) => {
                  const underMin = g.supplier.min_order_amount != null && g.subtotal < g.supplier.min_order_amount;
                  return (
                    <Note key={g.supplier.id} tone={underMin ? 'await' : 'idle'}>
                      <div className="w-full">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium text-ink-body">{g.supplier.name} <span className="text-ink-muted font-normal">({g.items.length} פריטים)</span></span>
                          <span className="font-semibold num">{fmtMoneyExact(g.subtotal)}</span>
                        </div>
                        {underMin && (
                          <div className="flex items-center gap-1.5 text-xs text-await-fg mt-1">
                            <AlertTriangle size={13} />
                            מתחת למינימום הזמנה ({fmtMoneyExact(g.supplier.min_order_amount!)})
                          </div>
                        )}
                      </div>
                    </Note>
                  );
                })}
              </div>
              <SupplierComparison cart={cart} offersByProduct={offersByProduct} supplierById={supplierById} effective={effective} />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="label">הערות</label>
                  <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="למשל: אירוע יום חמישי — 300 אורחים" />
                </div>
                <div>
                  <label className="label">אספקה מבוקשת</label>
                  <input type="date" className="input" value={expectedDate} min={todayISO()} onChange={(e) => setExpectedDate(e.target.value)} />
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <button className="btn-secondary" disabled={busy} onClick={() => void saveRequest(false)}>שמירה כטיוטה</button>
                <button className="btn-primary" disabled={busy || split.groups.length === 0} onClick={() => void saveRequest(true)}>
                  <Split size={15} /> פיצול ל־{split.groups.length} הזמנות ספק
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
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
  const rows: { item: CartItem; sp: SupplierProduct; cheapest: SupplierProduct; delta: number }[] = [];
  for (const item of cart) {
    const { sp } = effective(item);
    const cheapest = (offersByProduct.get(item.product.id) ?? [])[0]; // offers sorted ascending by price
    if (!sp || !cheapest) continue;
    rows.push({ item, sp, cheapest, delta: (sp.current_price - cheapest.current_price) * item.qty });
  }
  if (!rows.length) return null;
  const saving = rows.reduce((s, r) => s + r.delta, 0);
  if (saving <= 0) return <Note tone="done">כל הפריטים הוזמנו מהספק הזול ביותר</Note>;
  return (
    <div className="border border-line-soft rounded-lg divide-y divide-line-soft">
      {rows.map(({ item, sp, cheapest, delta }) => (
        <div key={item.product.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-1.5 text-sm">
          <span className="min-w-0">
            <span className="font-medium text-ink-body">{item.product.name}</span>
            <span className="text-xs text-ink-muted ms-2">
              {supplierById.get(sp.supplier_id)?.name} · <span className="num">{fmtMoneyExact(sp.current_price)}</span>
            </span>
          </span>
          {delta > 0 && (
            <span className="text-xs text-await-fg">
              הזול ביותר: {supplierById.get(cheapest.supplier_id)?.name} · <span className="num">{fmtMoneyExact(cheapest.current_price)}</span> · הפרש <span className="num">{fmtMoneyExact(delta)}</span>
            </span>
          )}
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
        <span className="text-ink-soft">חיסכון אפשרי אם עוברים לזול ביותר:</span>
        <b className="num text-await-fg">{fmtMoneyExact(saving)}</b>
      </div>
    </div>
  );
}

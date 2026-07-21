import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Trash2, AlertTriangle, Split, Plus, Minus } from 'lucide-react';
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

  const filteredProducts = (data?.products ?? []).filter((p) =>
    (!cat || p.category_id === cat) &&
    (!q || p.name.toLowerCase().includes(q.toLowerCase())) &&
    !cart.some((c) => c.product.id === p.id));

  function addToCart(p: Product) {
    setCart((c) => [...c, { product: p, qty: 1, chosenSupplierId: null }]);
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
          <div className="p-3 border-b border-slate-100 space-y-2">
            <div className="relative">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-slate-400" />
              <input className="input ps-9!" placeholder="חיפוש מוצר..." value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="flex gap-1.5 flex-wrap">
              <button className={`badge ${!cat ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`} onClick={() => setCat('')}>הכל</button>
              {categories?.map((c) => (
                <button key={c.id} className={`badge ${cat === c.id ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`} onClick={() => setCat(c.id)}>{c.name}</button>
              ))}
            </div>
          </div>
          <div className="max-h-[26rem] overflow-y-auto divide-y divide-slate-50">
            {filteredProducts.map((p) => {
              const offers = offersByProduct.get(p.id) ?? [];
              return (
                <button key={p.id} className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-indigo-50/50 text-start" onClick={() => addToCart(p)}>
                  <span>
                    <span className="text-sm font-medium text-slate-800">{p.name}</span>
                    <span className="text-xs text-slate-500 ms-2">{p.unit}</span>
                  </span>
                  <span className="text-xs text-slate-500 num">
                    {offers.length ? `₪${offers[0].current_price.toFixed(2)}` : 'אין ספק'}
                  </span>
                </button>
              );
            })}
            {!filteredProducts.length && <div className="px-4 py-8 text-center text-sm text-slate-500">לא נמצאו מוצרים</div>}
          </div>
        </div>

        {/* Cart + split preview */}
        <div className="lg:col-span-3 space-y-4">
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <span className="section-title">פריטים ברשימה ({cart.length})</span>
              <span className="text-sm text-slate-500">סה״כ משוער: <b className="num">{fmtMoneyExact(total)}</b></span>
            </div>
            {cart.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-slate-500">בחר מוצרים מהרשימה משמאל כדי להתחיל</div>
            ) : (
              <div className="divide-y divide-slate-50">
                {cart.map((item, idx) => {
                  const offers = offersByProduct.get(item.product.id) ?? [];
                  const { sp, recommended } = effective(item);
                  return (
                    <div key={item.product.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                      <div className="flex-1 min-w-40">
                        <div className="text-sm font-medium text-slate-800">{item.product.name}</div>
                        <div className="text-xs text-slate-500">{item.product.unit}</div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button className="btn-secondary p-1.5!" onClick={() => setCart((c) => c.map((x, i) => i === idx ? { ...x, qty: Math.max(1, x.qty - 1) } : x))} aria-label="הפחתה"><Minus size={14} /></button>
                        <input type="number" min={0.1} step="any" className="input w-20! num text-center" value={item.qty}
                          onChange={(e) => setCart((c) => c.map((x, i) => i === idx ? { ...x, qty: Number(e.target.value) || 1 } : x))} />
                        <button className="btn-secondary p-1.5!" onClick={() => setCart((c) => c.map((x, i) => i === idx ? { ...x, qty: x.qty + 1 } : x))} aria-label="הוספה"><Plus size={14} /></button>
                      </div>
                      <select className="input w-56!" value={item.chosenSupplierId ?? ''}
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
                      <div className="w-24 text-sm font-medium num">{sp ? fmtMoneyExact(sp.current_price * item.qty) : '—'}</div>
                      <button className="btn-ghost p-1.5! text-slate-400 hover:text-rose-600" onClick={() => setCart((c) => c.filter((_, i) => i !== idx))} aria-label="הסרה"><Trash2 size={15} /></button>
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
                <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-3 py-2">
                  ללא ספק זמין: {split.noSupplier.map((i) => i.product.name).join(', ')}
                </div>
              )}
              <div className="space-y-2">
                {split.groups.map((g) => {
                  const underMin = g.supplier.min_order_amount != null && g.subtotal < g.supplier.min_order_amount;
                  return (
                    <div key={g.supplier.id} className={`rounded-lg border px-3 py-2.5 ${underMin ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-slate-800">{g.supplier.name} <span className="text-slate-500 font-normal">({g.items.length} פריטים)</span></span>
                        <span className="font-semibold num">{fmtMoneyExact(g.subtotal)}</span>
                      </div>
                      {underMin && (
                        <div className="flex items-center gap-1.5 text-xs text-amber-700 mt-1">
                          <AlertTriangle size={13} />
                          מתחת למינימום הזמנה ({fmtMoneyExact(g.supplier.min_order_amount!)})
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
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

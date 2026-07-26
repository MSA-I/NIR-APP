import { Check, Minus, Plus, Search } from 'lucide-react';
import type { Category, Product, SupplierProduct } from '../../lib/types';

interface ProductCartItem {
  product: Product;
  qty: number;
}

interface ProductStepProps {
  products: readonly Product[];
  categories: readonly Category[];
  offersByProduct: ReadonlyMap<string, readonly SupplierProduct[]>;
  cart: readonly ProductCartItem[];
  q: string;
  setQ: (value: string) => void;
  cat: string;
  setCat: (value: string) => void;
  onAdd: (product: Product) => void;
  onQty: (productId: string, qty: number) => void;
  onContinue: () => void;
}

export default function ProductStep({ products, categories, offersByProduct, cart, q, setQ, cat, setCat, onAdd, onQty, onContinue }: ProductStepProps) {
  const filteredProducts = products.filter((product) =>
    (!cat || product.category_id === cat) && (!q || product.name.toLowerCase().includes(q.toLowerCase())));
  const cartByProduct = new Map(cart.map((item) => [item.product.id, item]));

  return (
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
          <button type="button" aria-pressed={!cat} className={`min-h-11 border px-3 text-xs font-medium ${!cat ? 'border-action bg-action text-white' : 'border-line text-ink-soft hover:bg-surface-sunken'}`} onClick={() => setCat('')}>הכול</button>
          {categories.map((category) => (
            <button type="button" key={category.id} aria-pressed={cat === category.id} className={`min-h-11 border px-3 text-xs font-medium ${cat === category.id ? 'border-action bg-action text-white' : 'border-line text-ink-soft hover:bg-surface-sunken'}`} onClick={() => setCat(category.id)}>{category.name}</button>
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
                aria-pressed={!!carted}
                aria-label={`${carted ? 'נבחר' : 'בחירת'} ${product.name}`}
                onClick={() => { if (!carted) onAdd(product); }}>
                <span className={`grid size-6 shrink-0 place-items-center border ${carted ? 'border-done-line bg-done-soft text-done-fg' : 'border-line text-transparent'}`} aria-hidden="true"><Check size={14} /></span>
                <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium text-ink-body sm:truncate">{product.name}</span><span className="text-xs text-ink-muted">{product.unit}</span></span>
                <span className="shrink-0 text-xs text-ink-muted num">{offers.length ? `₪${offers[0].current_price.toFixed(2)}` : 'אין ספק'}</span>
              </button>
              {carted && (
                <div className="me-3 flex shrink-0 items-center border border-line-strong bg-surface sm:me-4" aria-label={`כמות ${product.name}`}>
                  <button type="button" className="grid size-11 place-items-center hover:bg-surface-sunken" aria-label={`הפחתת כמות ${product.name}`} onClick={() => onQty(product.id, carted.qty - 1)}><Minus size={14} /></button>
                  <span className="min-w-10 border-x border-line py-2 text-center text-sm font-semibold num">{carted.qty}</span>
                  <button type="button" className="grid size-11 place-items-center hover:bg-surface-sunken" aria-label={`הוספת כמות ${product.name}`} onClick={() => onQty(product.id, carted.qty + 1)}><Plus size={14} /></button>
                </div>
              )}
            </div>
          );
        })}
        {!filteredProducts.length && <div className="px-4 py-10 text-center text-sm text-ink-muted">לא נמצאו מוצרים</div>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-strong px-3 py-3 sm:px-4">
        <div className="text-sm text-ink-muted">{cart.length ? `${cart.length} מוצרים מוכנים לשלב הספקים` : 'בחר לפחות מוצר אחד'}</div>
        <button type="button" className="btn-primary" disabled={!cart.length} onClick={onContinue}>המשך לספקים</button>
      </div>
    </section>
  );
}

import { Check, Minus, Plus, Search, ShoppingCart, X } from 'lucide-react';
import type { NextOrderItem } from '../../lib/nextOrderItems';
import type { Category, Product, SupplierProduct } from '../../lib/types';
import { fmtMoneyExact, formatQuantity, formatUnit } from '../../lib/format';

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
  nextOrderItems: readonly NextOrderItem[];
  nextOrderBusyId: string | null;
  onAddNextOrderItem: (item: NextOrderItem) => void;
  onDismissNextOrderItem: (item: NextOrderItem) => void;
  /**
   * Opens the quick-create dialog, or null when this user may not create products (the catalogue's
   * own owner/office rule). Null renders no button and no promise of one — the empty state stays
   * honest rather than offering a door that is not there.
   */
  onCreateProduct: (() => void) | null;
}

export default function ProductStep({ products, categories, offersByProduct, cart, q, setQ, cat, setCat, onAdd, onQty, onContinue, nextOrderItems, nextOrderBusyId, onAddNextOrderItem, onDismissNextOrderItem, onCreateProduct }: ProductStepProps) {
  const filteredProducts = products.filter((product) =>
    (!cat || product.category_id === cat) && (!q || product.name.toLowerCase().includes(q.toLowerCase())));
  const cartByProduct = new Map(cart.map((item) => [item.product.id, item]));

  return (
    <div className="space-y-4">
      {nextOrderItems.length > 0 && (
        <section className="note-info block" aria-labelledby="next-order-title">
          <div className="flex items-start gap-2"><ShoppingCart size={17} className="mt-0.5 shrink-0" aria-hidden="true" /><div><h2 id="next-order-title" className="font-semibold">נשמרו להזמנה הבאה</h2><p className="mt-0.5 text-xs">אפשר להחזיר את הפריטים לסל בכמות שנשמרה או להתעלם מהם.</p></div></div>
          <div className="mt-3 divide-y divide-info-line border-y border-info-line">
            {nextOrderItems.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1"><div className="font-medium text-ink-body"><bdi>{item.product.name}</bdi></div><div className="text-xs">כמות <span className="num font-semibold">{formatQuantity(item.qty, item.product.unit)}</span></div></div>
                <button type="button" className="btn-secondary" disabled={nextOrderBusyId !== null} onClick={() => onAddNextOrderItem(item)}><Plus size={15} aria-hidden="true" /> הוסף להזמנה</button>
                <button type="button" className="btn-ghost" disabled={nextOrderBusyId !== null} onClick={() => onDismissNextOrderItem(item)}><X size={15} aria-hidden="true" /> התעלם</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="product-picker-title" className="border-y border-line-strong bg-surface">
      <div className="space-y-3 border-b border-line-soft p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="product-picker-title" className="section-title">בחירת מוצרים</h2>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-ink-muted"><span className="num font-semibold text-ink">{cart.length}</span> מוצרים נבחרו</span>
            {onCreateProduct && (
              <button type="button" className="btn-secondary" onClick={onCreateProduct}>
                <Plus size={15} aria-hidden="true" /> מוצר חדש
              </button>
            )}
          </div>
        </div>
        <div className="relative">
          <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-faint" aria-hidden="true" />
          <input className="input ps-9!" aria-label="חיפוש מוצר" placeholder="חיפוש מוצר..." value={q} onChange={(event) => setQ(event.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="סינון לפי קטגוריה">
          <button type="button" aria-pressed={!cat} className={`chip-filter ${!cat ? 'chip-filter-active' : ''}`} onClick={() => setCat('')}>הכול</button>
          {categories.map((category) => (
            <button type="button" key={category.id} aria-pressed={cat === category.id} className={`chip-filter ${cat === category.id ? 'chip-filter-active' : ''}`} onClick={() => setCat(category.id)}>{category.name}</button>
          ))}
        </div>
      </div>

      <div className="max-h-[32rem] divide-y divide-line-soft overflow-y-auto">
        {filteredProducts.map((product) => {
          const offers = offersByProduct.get(product.id) ?? [];
          const carted = cartByProduct.get(product.id);
          return (
            <div key={product.id} className={`flex min-h-14 items-center ${carted ? 'bg-action-wash/45' : ''}`}>
              <button type="button" className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-start hover:bg-action-wash sm:px-4"
                aria-pressed={!!carted}
                aria-label={`${carted ? 'נבחר' : 'בחירת'} ${product.name}`}
                onClick={() => { if (!carted) onAdd(product); }}>
                <span className={`grid size-6 shrink-0 place-items-center border ${carted ? 'border-done-line bg-done-soft text-done-fg' : 'border-line text-transparent'}`} aria-hidden="true"><Check size={14} /></span>
                <span className="min-w-0 flex-1"><bdi className="block break-words text-sm font-medium text-ink-body sm:truncate">{product.name}</bdi><span className="text-xs text-ink-muted">{formatUnit(product.unit)}</span></span>
                <span className={`shrink-0 text-xs text-ink-muted ${offers.length ? 'num' : ''}`}>{offers.length ? fmtMoneyExact(offers[0].current_price) : 'אין ספק'}</span>
              </button>
              {carted && (
                <div className="me-3 flex shrink-0 items-center border border-line-strong bg-surface sm:me-4" role="group" aria-label={`כמות ${product.name}`}>
                  <button type="button" className="grid size-11 place-items-center hover:bg-action-wash" aria-label={`הפחתת כמות ${product.name}`} onClick={() => onQty(product.id, carted.qty - 1)}><Minus size={14} /></button>
                  <span className="min-w-10 border-x border-line py-2 text-center text-sm font-semibold num">{carted.qty}</span>
                  <button type="button" className="grid size-11 place-items-center hover:bg-action-wash" aria-label={`הוספת כמות ${product.name}`} onClick={() => onQty(product.id, carted.qty + 1)}><Plus size={14} /></button>
                </div>
              )}
            </div>
          );
        })}
        {/* The dead end the owner reported: this used to be the sentence and nothing else, so an
            item the system had never been taught could not be ordered at all. */}
        {!filteredProducts.length && (
          <div className="px-4 py-10 text-center text-sm text-ink-muted">
            <p>לא נמצאו מוצרים</p>
            {onCreateProduct && (
              <>
                <p className="mt-1">אפשר להוסיף את המוצר עכשיו, לבחור לו ספק ומחיר, ולהמשיך בהזמנה.</p>
                <button type="button" className="btn-primary mt-3" onClick={onCreateProduct}>
                  <Plus size={15} aria-hidden="true" /> מוצר חדש{q.trim() ? ` — ${q.trim()}` : ''}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-strong px-3 py-3 sm:px-4">
        <div className="text-sm text-ink-muted">{cart.length ? <><span className="num">{cart.length}</span> מוצרים מוכנים · המערכת תפצל את ההזמנה לפי הספק הזול לכל מוצר</> : 'בחר לפחות מוצר אחד'}</div>
        <button type="button" className="btn-primary" disabled={!cart.length} onClick={onContinue}>המשך לספקים</button>
      </div>
      </section>
    </div>
  );
}

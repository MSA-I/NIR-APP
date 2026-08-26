import { Check, Plus, Search, ShoppingCart, X } from 'lucide-react';
import { ICON, Stepper, ToggleGroup } from '../../components/ui';
import type { NextOrderItem } from '../../lib/nextOrderItems';
import type { Category, Product, SupplierProduct } from '../../lib/types';
import { fmtMoneyExact, formatQuantity, formatUnit, productLabel } from '../../lib/format';

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
  /**
   * Drops the product from the cart. The row carries `aria-pressed`, so it promises a toggle;
   * before this it only ever added, and a second press on a chosen product did nothing at all
   * (owner report, 19.08.2026). Removing also clears the line's quantity and supplier pin —
   * `REMOVE_PRODUCT` deletes the line, and re-adding re-seeds it at qty 1 in `auto` mode.
   */
  onRemove: (productId: string) => void;
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

export default function ProductStep({ products, categories, offersByProduct, cart, q, setQ, cat, setCat, onAdd, onRemove, onQty, onContinue, nextOrderItems, nextOrderBusyId, onAddNextOrderItem, onDismissNextOrderItem, onCreateProduct }: ProductStepProps) {
  const filteredProducts = products.filter((product) => (
    (!cat || product.category_id === cat)
    // Both names: the row now shows the approved one, and somebody ordering from a supplier's
    // sheet types what the sheet says. Searching more can only find more.
    && (!q || productLabel(product).toLowerCase().includes(q.toLowerCase())
      || product.name.toLowerCase().includes(q.toLowerCase()))
  ));
  const cartByProduct = new Map(cart.map((item) => [item.product.id, item]));

  return (
    <div className="space-y-4">
      {nextOrderItems.length > 0 && (
        <section className="note-info block" aria-labelledby="next-order-title">
          <div className="flex items-start gap-2"><ShoppingCart size={ICON.md} className="mt-0.5 shrink-0" aria-hidden="true" /><div><h2 id="next-order-title" className="font-semibold">נשמרו להזמנה הבאה</h2><p className="mt-0.5 text-xs">אפשר להחזיר את הפריטים לסל בכמות שנשמרה או להתעלם מהם.</p></div></div>
          <div className="mt-3 divide-y divide-info-line border-y border-info-line">
            {nextOrderItems.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1"><div className="font-medium text-ink-body"><bdi>{productLabel(item.product)}</bdi></div><div className="text-xs">כמות <span className="num font-semibold">{formatQuantity(item.qty, item.product.unit)}</span></div></div>
                <button type="button" className="btn-secondary" disabled={nextOrderBusyId !== null} onClick={() => onAddNextOrderItem(item)}><Plus size={ICON.sm} aria-hidden="true" /> הוסף להזמנה</button>
                <button type="button" className="btn-ghost" disabled={nextOrderBusyId !== null} onClick={() => onDismissNextOrderItem(item)}><X size={ICON.sm} aria-hidden="true" /> התעלם</button>
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
                <Plus size={ICON.sm} aria-hidden="true" /> מוצר חדש
              </button>
            )}
          </div>
        </div>
        <div className="relative">
          <Search size={ICON.sm} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-faint" aria-hidden="true" />
          <input className="input ps-9!" aria-label="חיפוש מוצר" placeholder="חיפוש מוצר..." value={q} onChange={(event) => setQ(event.target.value)} />
        </div>
        <ToggleGroup label="סינון לפי קטגוריה" value={cat} onChange={setCat}
          items={[{ key: '', label: 'הכול' }, ...categories.map((category) => ({ key: category.id, label: category.name }))]} />
      </div>

      <div className="max-h-[32rem] divide-y divide-line-soft overflow-y-auto">
        {filteredProducts.map((product) => {
          const offers = offersByProduct.get(product.id) ?? [];
          const carted = cartByProduct.get(product.id);
          return (
            <div key={product.id} className={`flex min-h-14 items-center ${carted ? 'bg-surface-selected' : ''}`}>
              <button type="button" className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-start hover:bg-surface-hover sm:px-4"
                aria-pressed={!!carted}
                aria-label={`${carted ? 'ביטול בחירת' : 'בחירת'} ${productLabel(product)}`}
                onClick={() => { if (carted) onRemove(product.id); else onAdd(product); }}>
                {/* Choosing is not completing. This box wore the done family, which claims a step
                    finished; a picker has nothing finished on it. The action family is what the
                    house already uses for a chosen option — the category ToggleGroup above paints
                    its selected chip `.chip-filter-active`, the same bg-action/text-on-solid pair
                    (the class moved into the primitive; it is no longer spelled out in this file),
                    and the row's own bg-surface-selected is documented as "chosen option".
                    Meaning does not rest on the hue either way:
                    the glyph appears only when carted, aria-pressed sits on the parent, the label
                    names the action, and the quantity stepper exists only for a chosen product. */}
                <span className={`grid size-6 shrink-0 place-items-center rounded-lg border ${carted ? 'border-action bg-action text-on-solid' : 'border-line text-transparent'}`} aria-hidden="true"><Check size={ICON.xs} /></span>
                <span className="min-w-0 flex-1"><bdi className="block break-words text-sm font-medium text-ink-body sm:truncate">{productLabel(product)}</bdi><span className="text-xs text-ink-muted">{formatUnit(product.unit)}</span></span>
                <span className={`shrink-0 text-xs text-ink-muted ${offers.length ? 'num' : ''}`}>{offers.length ? fmtMoneyExact(offers[0].current_price) : 'אין ספק'}</span>
              </button>
              {/* The shared Stepper (components/ui). `min={1}` is the one deliberate behaviour
                  change in this convergence: the old raw control had no floor, so decrementing
                  from 1 reached 0 and NewOrder mapped qty 0 to REMOVE_PRODUCT. That was the
                  legacy way out of the cart, and the spec beside this file records it as the
                  problem the row-as-toggle fixed (owner report, 19.08.2026) — the row is the
                  documented remove affordance now. A floor of 1 also keeps the newly editable
                  input safe: clearing it clamps to 1 instead of deleting the line mid-keystroke. */}
              {carted && (
                <Stepper className="me-3 shrink-0 sm:me-4" value={carted.qty} min={1}
                  label={`כמות ${productLabel(product)}`}
                  onChange={(next) => onQty(product.id, next)} />
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
                  <Plus size={ICON.sm} aria-hidden="true" /> מוצר חדש{q.trim() ? ` — ${q.trim()}` : ''}
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

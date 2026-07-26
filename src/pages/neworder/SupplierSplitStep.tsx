import { AlertTriangle, Split, Trash2 } from 'lucide-react';
import { fmtMoneyExact, todayISO } from '../../lib/format';
import type { Product, Supplier, SupplierProduct } from '../../lib/types';
import SupplierGroupCard from './SupplierGroupCard';

interface SupplierCartItem {
  product: Product;
  qty: number;
  chosenSupplierId: string | null;
}

interface SupplierSplitGroup {
  supplier: Supplier;
  items: { item: SupplierCartItem; sp: SupplierProduct }[];
  subtotal: number;
}

interface SupplierSplitStepProps {
  cart: readonly SupplierCartItem[];
  offersByProduct: ReadonlyMap<string, readonly SupplierProduct[]>;
  supplierById: ReadonlyMap<string, Supplier>;
  effective: (item: SupplierCartItem) => { sp: SupplierProduct | null; recommended: SupplierProduct | null };
  groups: readonly SupplierSplitGroup[];
  noSupplier: readonly SupplierCartItem[];
  total: number;
  notes: string;
  setNotes: (value: string) => void;
  expectedDate: string;
  setExpectedDate: (value: string) => void;
  busy: boolean;
  onSupplier: (productId: string, supplierId: string | null) => void;
  onRemove: (productId: string) => void;
  onQty: (productId: string, qty: number) => void;
  onBack: () => void;
}

export default function SupplierSplitStep({
  cart,
  offersByProduct,
  supplierById,
  effective,
  groups,
  noSupplier,
  total,
  notes,
  setNotes,
  expectedDate,
  setExpectedDate,
  busy,
  onSupplier,
  onRemove,
  onQty,
  onBack,
}: SupplierSplitStepProps) {
  return (
    <div className="space-y-4">
      <section aria-labelledby="selected-products-title" className="border-y border-line-strong bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-3 py-3 sm:px-4">
          <h2 id="selected-products-title" className="section-title">פריטים וספקים</h2>
          <span className="text-sm text-ink-muted">סה״כ משוער <b className="num text-ink">{fmtMoneyExact(total)}</b></span>
        </div>
        <div className="divide-y divide-line-soft">
          {cart.map((item) => {
            const offers = offersByProduct.get(item.product.id) ?? [];
            const { sp, recommended } = effective(item);
            return (
              <div key={item.product.id} className="grid items-center gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_5rem_minmax(13rem,1fr)_7rem_2.75rem] sm:px-4">
                <div className="min-w-0"><div className="break-words text-sm font-medium text-ink-body sm:truncate">{item.product.name}</div><div className="text-xs text-ink-muted">{item.product.unit}</div></div>
                <div className="text-sm"><span className="text-ink-muted">כמות </span><b className="num">{item.qty}</b></div>
                <select className="input" aria-label={`ספק עבור ${item.product.name}`} value={item.chosenSupplierId ?? ''}
                  onChange={(event) => onSupplier(item.product.id, event.target.value || null)}>
                  <option value="">{recommended ? `הזול ביותר: ${supplierById.get(recommended.supplier_id)?.name} — ₪${recommended.current_price.toFixed(2)}` : offers.length ? `הגדל כמות — מינימום הזמנה ${Math.min(...offers.map((o) => o.min_qty ?? 1))}` : 'אין ספק זמין'}</option>
                  {offers.map((offer) => <option key={offer.id} value={offer.supplier_id} disabled={!meetsMin(offer, item.qty)}>{supplierById.get(offer.supplier_id)?.name} — ₪{offer.current_price.toFixed(2)}{offer.min_qty && offer.min_qty > 1 ? ` · מינ׳ ${offer.min_qty}` : ''}</option>)}
                </select>
                <div className="text-sm font-semibold num">{sp ? fmtMoneyExact(sp.current_price * item.qty) : '—'}</div>
                <button type="button" className="grid size-11 place-items-center text-ink-faint hover:bg-surface-sunken hover:text-alert-solid" onClick={() => onRemove(item.product.id)} aria-label={`הסרת ${item.product.name}`}><Trash2 size={15} /></button>
              </div>
            );
          })}
        </div>
      </section>

      <SupplierComparison cart={cart} offersByProduct={offersByProduct} supplierById={supplierById} effective={effective}
        onChoose={(productId, supplierId) => onSupplier(productId, supplierId)} />

      <section aria-labelledby="supplier-split-title" className="border-y border-line-strong bg-surface">
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-3 sm:px-4"><Split size={17} aria-hidden="true" /><h2 id="supplier-split-title" className="section-title">פיצול הזמנות לספקים</h2></div>
        {noSupplier.length > 0 && <div className="border-b border-alert-line bg-alert-wash px-3 py-2.5 text-sm text-alert-fg sm:px-4">
          <div className="flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>ללא ספק זמין לכמות שנבחרה — הגדל כמות למינימום או הסר:</span></div>
          <ul className="mt-1.5 space-y-1.5">
            {noSupplier.map((item) => {
              const offers = offersByProduct.get(item.product.id) ?? [];
              const min = offers.reduce((current, offer) => Math.min(current, offer.min_qty ?? 1), Infinity);
              return (
                <li key={item.product.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 break-words">{item.product.name}{offers.length > 0 && Number.isFinite(min) ? ` · מינימום ${min}` : ' · אין הצעת ספק'}</span>
                  {offers.length > 0 && Number.isFinite(min) && (
                    <button type="button" className="btn-secondary py-1! text-xs" onClick={() => onQty(item.product.id, min)}>הגדל ל-{min}</button>
                  )}
                  <button type="button" className="btn-ghost py-1! text-xs" onClick={() => onRemove(item.product.id)}>הסר</button>
                </li>
              );
            })}
          </ul>
        </div>}
        <div className="divide-y divide-line-soft">
          {groups.map((group) => <SupplierGroupCard key={group.supplier.id} supplier={group.supplier} itemCount={group.items.length} subtotal={group.subtotal} />)}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2"><label className="label" htmlFor="new-order-notes">הערות</label><input id="new-order-notes" className="input" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="למשל: אספקה לכניסה הראשית" /></div>
        <div><label className="label" htmlFor="new-order-expected-date">אספקה מבוקשת</label><input id="new-order-expected-date" type="date" className="input" value={expectedDate} min={todayISO()} onChange={(event) => setExpectedDate(event.target.value)} /></div>
      </div>
      <div className="flex items-center border-t border-line-strong bg-surface px-3 py-3 sm:px-4">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>חזרה למוצרים וכמויות</button>
        <span className="ms-auto text-xs text-ink-muted">האישור נמצא בראש המסך</span>
      </div>
    </div>
  );
}

function SupplierComparison({ cart, offersByProduct, supplierById, effective, onChoose }: {
  cart: readonly SupplierCartItem[];
  offersByProduct: ReadonlyMap<string, readonly SupplierProduct[]>;
  supplierById: ReadonlyMap<string, Supplier>;
  effective: (item: SupplierCartItem) => { sp: SupplierProduct | null; recommended: SupplierProduct | null };
  onChoose: (productId: string, supplierId: string) => void;
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
        <div><h2 id="supplier-comparison-title" className="section-title">השוואת מחיר לכל מוצר</h2><p className="mt-0.5 text-xs text-ink-muted">לחצו על ספק כדי לבחור בו למוצר. המחיר נשמר בהזמנה לפי הספק שנבחר ברגע השליחה.</p></div>
        <div className="text-start sm:text-end"><span className="block text-xs text-ink-muted">חיסכון אפשרי בבחירה הזולה</span><strong className={`num text-base ${saving > 0 ? 'text-await-fg' : 'text-done-fg'}`}>{fmtMoneyExact(saving)}</strong></div>
      </div>
      <div className="divide-y divide-line-soft">
        {rows.map(({ item, sp, cheapest }) => {
          const offers = offersByProduct.get(item.product.id) ?? [];
          const cheapestTotal = cheapest ? cheapest.current_price * item.qty : 0;
          return (
            <div key={item.product.id} className="px-3 py-3 text-sm sm:px-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium text-ink-body">{item.product.name}</div>
                <div className="text-xs text-ink-muted">כמות <span className="num">{item.qty}</span></div>
              </div>
              {offers.length ? <div className="divide-y divide-line-soft border-y border-line-soft">
                {offers.map((offer) => {
                  const lineTotal = offer.current_price * item.qty;
                  const difference = Math.max(0, lineTotal - cheapestTotal);
                  const selected = sp?.supplier_id === offer.supplier_id;
                  return <button type="button" key={offer.id}
                    onClick={() => onChoose(item.product.id, offer.supplier_id)} aria-pressed={selected}
                    aria-label={`בחירת ${supplierById.get(offer.supplier_id)?.name ?? 'ספק'} עבור ${item.product.name}`}
                    className={`grid w-full gap-1 px-2 py-2 text-start row-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4 ${selected ? 'bg-action-wash/45' : ''}`}>
                    <div className="font-medium text-ink-body">{supplierById.get(offer.supplier_id)?.name ?? 'ספק לא זמין'}{selected && <span className="ms-2 text-xs text-action">נבחר</span>}</div>
                    <div className="text-xs text-ink-muted"><span className="num">{fmtMoneyExact(offer.current_price)}</span> × <span className="num">{item.qty}</span> = <strong className="num text-ink">{fmtMoneyExact(lineTotal)}</strong></div>
                    <div className={`text-xs font-medium sm:min-w-36 sm:text-end ${difference === 0 ? 'text-done-fg' : 'text-await-fg'}`}>{difference === 0 ? 'המחיר הנמוך ביותר' : `בחירה בזול תחסוך ${fmtMoneyExact(difference)}`}</div>
                  </button>;
                })}
              </div> : <div className="text-alert-fg">אין הצעת מחיר פעילה למוצר</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function meetsMin(offer: SupplierProduct, qty: number): boolean {
  return offer.min_qty == null || qty >= offer.min_qty;
}

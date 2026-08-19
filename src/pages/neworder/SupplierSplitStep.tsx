import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Split, Trash2 } from 'lucide-react';
import { fmtMoneyExact, formatQuantity, formatUnit, productLabel, todayISO } from '../../lib/format';
import { compareLine, summarizeComparison, type LineComparison } from '../../lib/orderComparison';
import { centsFromUnits, lineUnits, moneyFromCents } from '../../lib/orderSavings';
import {
  resolutionOptions,
  type OrderSplit,
  type ResolutionOption,
  type SplitInput,
  type SplitLine,
} from '../../lib/orderSplit';
import type { Product, Supplier, SupplierProduct } from '../../lib/types';
import MinimumFixPanel from './MinimumFixPanel';
import SupplierGroupCard from './SupplierGroupCard';

interface SupplierCartItem extends SplitLine {
  product: Product;
}

interface SupplierSplitStepProps {
  cart: readonly SupplierCartItem[];
  offersByProduct: ReadonlyMap<string, readonly SupplierProduct[]>;
  supplierById: ReadonlyMap<string, Supplier>;
  split: OrderSplit;
  input: SplitInput;
  notes: string;
  setNotes: (value: string) => void;
  expectedDate: string;
  setExpectedDate: (value: string) => void;
  busy: boolean;
  onSupplier: (productId: string, supplierId: string | null) => void;
  onRemove: (productId: string) => void;
  onQty: (productId: string, qty: number) => void;
  onResolve: (option: ResolutionOption, fromSupplierId: string) => void;
  onConsolidate: (supplierId: string) => void;
  onBack: () => void;
  onContinue: () => void;
}

export default function SupplierSplitStep({
  cart,
  offersByProduct,
  supplierById,
  split,
  input,
  notes,
  setNotes,
  expectedDate,
  setExpectedDate,
  busy,
  onSupplier,
  onRemove,
  onQty,
  onResolve,
  onConsolidate,
  onBack,
  onContinue,
}: SupplierSplitStepProps) {
  const [focusedSupplierId, setFocusedSupplierId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<'all' | 'move_group'>('all');
  const options = useMemo(
    () => (focusedSupplierId ? resolutionOptions(split, input, focusedSupplierId) : []),
    [focusedSupplierId, split, input],
  );
  const cartByProduct = new Map(cart.map((item) => [item.productId, item]));
  const productById = new Map(cart.map((item) => [item.productId, item.product]));
  const resolvedByProduct = new Map([...split.groups.flatMap((group) => group.lines), ...split.blocked]
    .map((line) => [line.productId, line]));
  const focusedGroup = focusedSupplierId
    ? split.groups.find((group) => group.supplier.id === focusedSupplierId) ?? null
    : null;
  const focusedSupplier = focusedSupplierId ? input.suppliers.get(focusedSupplierId) ?? null : null;
  const panelOptions = panelMode === 'move_group' ? options.filter((option) => option.kind === 'move_group') : options;

  useEffect(() => {
    if (!focusedSupplierId) return;
    const stillRelevant = split.groups.some((group) => group.supplier.id === focusedSupplierId)
      || split.blocked.some((line) => line.assignment.mode === 'pinned' && line.assignment.supplierId === focusedSupplierId);
    if (!stillRelevant) setFocusedSupplierId(null);
  }, [focusedSupplierId, split]);

  const openPanel = (supplierId: string, mode: 'all' | 'move_group' = 'all') => {
    setPanelMode(mode);
    setFocusedSupplierId(supplierId);
  };

  const singleSupplierId = split.savings.singleSupplierId;
  const singleSupplier = singleSupplierId ? supplierById.get(singleSupplierId) ?? null : null;
  const showConsolidation = !!singleSupplierId && !!singleSupplier && split.groups.length > 1 && split.blocked.length === 0;

  return (
    <div className="space-y-4">
      {split.blocked.length > 0 && (
        <BlockedSurface
          blocked={split.blocked}
          cartByProduct={cartByProduct}
          offersByProduct={offersByProduct}
          supplierById={supplierById}
          onQty={onQty}
          onRemove={onRemove}
          onUnpin={(productId) => onSupplier(productId, null)}
          onAlternatives={(supplierId) => openPanel(supplierId)}
        />
      )}

      {showConsolidation && (
        <section className="note-info flex-wrap items-center" aria-label="אפשרות איחוד הזמנה">
          <div className="min-w-0 flex-1">
            <strong className="block text-ink">אפשר לאחד את כל הסל אצל {singleSupplier.name}</strong>
            <span className="mt-0.5 block text-xs">
              <ConsolidationCost savings={split.savings.savings} /> · סה״כ <span className="num font-semibold">{fmtMoneyExact(split.savings.singleSupplierTotal)}</span>
            </span>
          </div>
          <button type="button" className="btn-secondary shrink-0" disabled={busy} onClick={() => onConsolidate(singleSupplierId)}>
            אחד אצל {singleSupplier.name}
          </button>
        </section>
      )}

      <section aria-labelledby="selected-products-title" className="border-y border-line-strong bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-3 py-3 sm:px-4">
          <h2 id="selected-products-title" className="section-title">פריטים שנבחרו</h2>
          <span className="text-sm text-ink-muted">סה״כ משוער <b className="num text-ink">{fmtMoneyExact(split.total)}</b></span>
        </div>
        <div className="divide-y divide-line-soft">
          {cart.map((item) => {
            const resolved = resolvedByProduct.get(item.productId);
            return (
              <div key={item.productId} className="grid items-center gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(9rem,auto)_auto_2.75rem] sm:gap-4 sm:px-4">
                <div className="min-w-0"><div className="break-words text-sm font-medium text-ink-body"><bdi>{productLabel(item.product)}</bdi></div><div className="text-xs text-ink-muted">{formatUnit(item.product.unit)}</div></div>
                <div className="text-sm"><span className="text-ink-muted">כמות </span><b className="num">{formatQuantity(item.qty, item.product.unit)}</b></div>
                <div className="text-xs text-ink-muted">{resolved?.supplierId ? supplierById.get(resolved.supplierId)?.name ?? 'ספק לא זמין' : 'טרם הוקצה ספק'}</div>
                <div className="num text-sm font-semibold">{fmtMoneyExact(resolved?.lineTotal)}</div>
                <button type="button" className="grid size-11 place-items-center rounded-lg text-ink-faint hover:bg-surface-hover hover:text-alert-fg" onClick={() => onRemove(item.productId)} aria-label={`הסרת ${productLabel(item.product)}`}><Trash2 size={15} /></button>
              </div>
            );
          })}
        </div>
      </section>

      <SupplierComparison
        cart={cart}
        offersByProduct={offersByProduct}
        supplierById={supplierById}
        split={split}
        onChoose={(item, offer) => {
          if (offer.min_qty != null && item.qty < offer.min_qty) onQty(item.productId, offer.min_qty);
          onSupplier(item.productId, offer.supplier_id);
        }}
        onUnpin={(productId) => onSupplier(productId, null)}
      />

      <section aria-labelledby="supplier-split-title" className="border-y border-line-strong bg-surface">
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-3 sm:px-4"><Split size={17} aria-hidden="true" /><h2 id="supplier-split-title" className="section-title">פיצול הזמנות לספקים</h2></div>
        <div className="divide-y divide-line-strong">
          {split.groups.map((group) => (
            <SupplierGroupCard
              key={group.supplier.id}
              group={group}
              products={productById}
              onOpenFix={() => openPanel(group.supplier.id)}
              onOpenGroupMove={() => openPanel(group.supplier.id, 'move_group')}
              canMoveGroup={hasGroupMoveTarget(group, input)}
            />
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2"><label className="label" htmlFor="new-order-notes">הערות</label><input id="new-order-notes" className="input" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="למשל: אספקה לכניסה הראשית" /></div>
        <div><label className="label" htmlFor="new-order-expected-date">אספקה מבוקשת</label><input id="new-order-expected-date" type="date" className="input" value={expectedDate} min={todayISO()} onChange={(event) => setExpectedDate(event.target.value)} /></div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-strong bg-surface px-3 py-3 sm:px-4">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>חזרה למוצרים וכמויות</button>
        <button type="button" className="btn-primary" disabled={busy || split.blocked.length > 0} onClick={onContinue}>המשך לסיכום ואישור</button>
      </div>

      <MinimumFixPanel
        open={focusedSupplierId !== null}
        onClose={() => setFocusedSupplierId(null)}
        supplier={focusedSupplier}
        group={focusedGroup}
        options={panelOptions}
        products={productById}
        suppliers={input.suppliers}
        showOptionsWhenPassing={panelMode === 'move_group'}
        onChoose={(option) => {
          if (focusedSupplierId) onResolve(option, focusedSupplierId);
        }}
      />
    </div>
  );
}

function BlockedSurface({ blocked, cartByProduct, offersByProduct, supplierById, onQty, onRemove, onUnpin, onAlternatives }: {
  blocked: OrderSplit['blocked'];
  cartByProduct: ReadonlyMap<string, SupplierCartItem>;
  offersByProduct: ReadonlyMap<string, readonly SupplierProduct[]>;
  supplierById: ReadonlyMap<string, Supplier>;
  onQty: (productId: string, qty: number) => void;
  onRemove: (productId: string) => void;
  onUnpin: (productId: string) => void;
  onAlternatives: (supplierId: string) => void;
}) {
  return (
    <section className="note-alert block" aria-labelledby="blocked-lines-title">
      <div className="flex items-start gap-2">
        <AlertTriangle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div><h2 id="blocked-lines-title" className="font-semibold">יש פריטים שדורשים תיקון לפני אישור</h2><p className="mt-0.5 text-xs">לא ניתן ליצור הזמנה עד שלכל פריט יש ספק וכמות תקפים.</p></div>
      </div>
      <div className="mt-3 divide-y divide-alert-line border-y border-alert-line">
        {blocked.map((line) => {
          const item = cartByProduct.get(line.productId);
          if (!item) return null;
          const offers = offersByProduct.get(line.productId) ?? [];
          const pinnedSupplierId = line.assignment.mode === 'pinned' ? line.assignment.supplierId : null;
          const pinnedOffer = pinnedSupplierId ? offers.find((offer) => offer.supplier_id === pinnedSupplierId) ?? null : null;
          const minimum = offers.reduce((current, offer) => Math.min(current, offer.min_qty ?? 1), Infinity);
          const requiredQty = line.status === 'pin_below_min_qty' ? pinnedOffer?.min_qty ?? null : Number.isFinite(minimum) ? minimum : null;
          const addedCost = requiredQty != null && pinnedOffer
            ? moneyFromCents(centsFromUnits(lineUnits(requiredQty - line.qty, pinnedOffer.current_price)))
            : null;
          return (
            <div key={line.productId} className={`flex flex-wrap items-center gap-2 px-2 py-3 ${line.status === 'pin_below_min_qty' ? 'bg-await-wash text-await-fg' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="font-medium"><bdi>{productLabel(item.product)}</bdi></div>
                <div className="mt-0.5 text-xs">{blockedReason(line.status, pinnedSupplierId ? supplierById.get(pinnedSupplierId)?.name ?? null : null)}</div>
                {line.status === 'pin_below_min_qty' && requiredQty != null && <span className="badge-await mt-1">הצמדה לא תקפה · מינימום <span className="num ms-1">{requiredQty}</span></span>}
              </div>
              {line.status === 'pin_below_min_qty' && requiredQty != null && (
                <button type="button" className="btn-secondary text-xs" onClick={() => onQty(line.productId, requiredQty)}>
                  הגדל ל-<span className="num">{requiredQty}</span>{addedCost != null ? <> · <span className="num">+{fmtMoneyExact(addedCost)}</span></> : null}
                </button>
              )}
              {line.status === 'no_usable_offer' && requiredQty != null && <button type="button" className="btn-secondary text-xs" onClick={() => onQty(line.productId, requiredQty)}>הגדל ל-<span className="num">{requiredQty}</span></button>}
              {line.status === 'pin_supplier_gone' && pinnedSupplierId && <button type="button" className="btn-secondary text-xs" onClick={() => onAlternatives(pinnedSupplierId)}>הצג ספקים חלופיים</button>}
              {(line.status === 'pin_below_min_qty' || line.status === 'pin_supplier_gone') && <button type="button" className="btn-ghost text-xs" onClick={() => onUnpin(line.productId)}>חזרה לבחירה אוטומטית</button>}
              <button type="button" className="btn-ghost text-xs" onClick={() => onRemove(line.productId)}>הסר</button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SupplierComparison({ cart, offersByProduct, supplierById, split, onChoose, onUnpin }: {
  cart: readonly SupplierCartItem[];
  offersByProduct: ReadonlyMap<string, readonly SupplierProduct[]>;
  supplierById: ReadonlyMap<string, Supplier>;
  split: OrderSplit;
  onChoose: (item: SupplierCartItem, offer: SupplierProduct) => void;
  onUnpin: (productId: string) => void;
}) {
  const resolved = new Map([...split.groups.flatMap((group) => group.lines), ...split.blocked].map((line) => [line.productId, line]));
  const rows = cart.map((item) => {
    const chosen = resolved.get(item.productId);
    const offers = offersByProduct.get(item.productId) ?? [];
    const usable = offers.filter((offer) => offer.min_qty == null || item.qty >= offer.min_qty);
    const cheapest = usable[0] ?? null;
    const selectedSupplierId = item.assignment.mode === 'pinned' ? item.assignment.supplierId : chosen?.supplierId;
    const selected = selectedSupplierId ? offers.find((offer) => offer.supplier_id === selectedSupplierId) ?? null : null;
    const comparison = compareLine(
      item.qty,
      offers.map((offer) => ({ supplierId: offer.supplier_id, unitPrice: offer.current_price, minQty: offer.min_qty })),
      selectedSupplierId ?? null,
    );
    return { item, selected, cheapest, comparison };
  });
  // What the choices already bought, and — kept apart from it — what a choice still costs.
  const { saved, extra } = summarizeComparison(rows.map((row) => row.comparison));
  return (
    <section aria-labelledby="supplier-comparison-title" className="border-y border-line-strong bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line-soft px-3 py-3 sm:px-4">
        <div><h2 id="supplier-comparison-title" className="section-title">השוואת מחיר לכל מוצר</h2><p className="mt-0.5 text-xs text-ink-muted">לחצו על ספק כדי להצמיד אותו למוצר. ספק עם מינימום כמות יגדיל את הכמות באותה לחיצה.</p></div>
        <div className="text-start sm:text-end">
          <span className="block text-xs text-ink-muted">נחסך מול האפשרות הזולה הבאה</span>
          {/* `—` and never ₪0.00: with nothing in the basket holding a runner-up there is no
              comparison to report, and a zero would be a claim about the money rather than the
              absence of one. */}
          <strong className={`num text-base ${saved != null && saved > 0 ? 'text-done-fg' : 'text-ink'}`}>{saved == null ? '—' : fmtMoneyExact(saved)}</strong>
          {extra != null && (
            <span className="mt-0.5 block text-xs text-await-fg">תוספת של <span className="num">{fmtMoneyExact(extra)}</span> מול הזול ביותר</span>
          )}
        </div>
      </div>
      <div className="divide-y divide-line-soft">
        {rows.map(({ item, selected, cheapest, comparison }) => {
          const offers = offersByProduct.get(item.productId) ?? [];
          return (
            <div key={item.productId} className="px-3 py-3 text-sm sm:px-4">
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0"><div className="font-medium text-ink-body"><bdi>{productLabel(item.product)}</bdi></div><LineComparisonNote comparison={comparison} /></div>
                <div className="text-xs text-ink-muted">כמות <span className="num">{item.qty}</span></div>
              </div>
              {offers.length ? <div className="divide-y divide-line-soft border-y border-line-soft">
                {offers.map((offer) => {
                  const adjustedQty = offer.min_qty != null && item.qty < offer.min_qty ? offer.min_qty : item.qty;
                  const lineTotal = exactLineTotal(adjustedQty, offer.current_price);
                  const cheapestTotal = cheapest ? exactLineTotal(item.qty, cheapest.current_price) : null;
                  const difference = cheapestTotal == null
                    ? null
                    : moneyFromCents(BigInt(Math.round((lineTotal - cheapestTotal) * 100)));
                  const isSelected = selected?.supplier_id === offer.supplier_id;
                  const isPinned = isSelected && item.assignment.mode === 'pinned' && item.assignment.supplierId === offer.supplier_id;
                  return (
                    <div key={offer.id} className={`flex items-stretch ${isSelected ? 'bg-surface-selected' : ''}`}>
                      <button type="button" onClick={() => onChoose(item, offer)} aria-pressed={isSelected}
                        aria-label={`בחירת ${supplierById.get(offer.supplier_id)?.name ?? 'ספק'} עבור ${productLabel(item.product)}`}
                        className="grid min-h-11 min-w-0 flex-1 gap-1 px-2 py-2 text-start row-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4">
                        <div className="font-medium text-ink-body">{supplierById.get(offer.supplier_id)?.name ?? 'ספק לא זמין'}{isSelected && <span className="ms-2 text-xs text-action">{isPinned ? 'מוצמד' : 'בחירה אוטומטית'}</span>}{offer.min_qty != null && <span className="badge-await ms-2">מינ׳ <span className="num ms-1">{offer.min_qty}</span></span>}</div>
                        <div className="text-xs text-ink-muted"><span className="num">{fmtMoneyExact(offer.current_price)}</span> × <span className="num">{adjustedQty}</span> = <strong className="num text-ink">{fmtMoneyExact(lineTotal)}</strong></div>
                        <div className={`text-xs font-medium sm:min-w-36 sm:text-end ${difference == null ? 'text-ink-muted' : difference <= 0 ? 'text-done-fg' : 'text-await-fg'}`}>
                          {offer.min_qty != null && adjustedQty !== item.qty
                            ? <>הכמות תגדל ל-<span className="num">{adjustedQty}</span></>
                            : difference === 0
                              ? 'המחיר הנמוך ביותר'
                              : difference == null
                                ? 'אין בסיס השוואה'
                                : <SignedAmount value={difference} />}
                        </div>
                      </button>
                      {/* Named for where it lands, not for what it cancels: unpinning re-runs the
                          auto assignment, which may legitimately land on this same supplier. The
                          badge beside it then flips 'מוצמד' → 'בחירה אוטומטית', so the pair still
                          reads as one true sentence instead of a button that did nothing. */}
                      {isPinned && <button type="button" className="btn-ghost m-1 shrink-0 text-xs" onClick={() => onUnpin(item.productId)}>חזרה לבחירה אוטומטית</button>}
                    </div>
                  );
                })}
              </div> : <div className="text-alert-fg">אין הצעת מחיר פעילה למוצר</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function blockedReason(status: OrderSplit['blocked'][number]['status'], supplierName: string | null): string {
  if (status === 'no_offers') return 'אין הצעת מחיר פעילה למוצר.';
  if (status === 'no_usable_offer') return 'אין הצעה שעומדת בכמות שנבחרה.';
  if (status === 'pin_supplier_gone') return `הספק המוצמד${supplierName ? ` ${supplierName}` : ''} אינו זמין עוד.`;
  return 'הכמות נמוכה ממינימום הכמות של הספק המוצמד.';
}

function ConsolidationCost({ savings }: { savings: number | null }) {
  if (savings == null || savings === 0) return <>ללא שינוי בעלות</>;
  return savings > 0
    ? <>האיחוד מוסיף <span className="num font-semibold">{fmtMoneyExact(savings)}</span></>
    : <>האיחוד חוסך <span className="num font-semibold">{fmtMoneyExact(Math.abs(savings))}</span></>;
}

function hasGroupMoveTarget(group: OrderSplit['groups'][number], input: SplitInput): boolean {
  return [...input.suppliers.keys()].some((supplierId) => supplierId !== group.supplier.id
    && group.lines.every((line) => (input.offersByProduct.get(line.productId) ?? [])
      .some((offer) => offer.supplierId === supplierId)));
}

function exactLineTotal(qty: number, unitPrice: number): number {
  return moneyFromCents(centsFromUnits(lineUnits(qty, unitPrice)));
}

/**
 * One sentence per product, in the tone of what it is: a saving already banked reads `done`, an
 * avoidable extra reads `await`, and a line with nothing to compare against says so rather than
 * showing a figure it cannot support.
 */
function LineComparisonNote({ comparison }: { comparison: LineComparison }) {
  if (comparison.status === 'saved') {
    return <p className="mt-0.5 text-xs text-done-fg">נחסכו <span className="num">{fmtMoneyExact(comparison.savedVsNext)}</span> מול האפשרות הזולה הבאה</p>;
  }
  if (comparison.status === 'overpaying') {
    return <p className="mt-0.5 text-xs text-await-fg">תוספת של <span className="num">{fmtMoneyExact(comparison.extraVsCheapest)}</span> מול הזול ביותר</p>;
  }
  if (comparison.status === 'same_price') return <p className="mt-0.5 text-xs text-ink-muted">אותו מחיר גם באפשרות הבאה</p>;
  if (comparison.status === 'single_offer') return <p className="mt-0.5 text-xs text-ink-muted">הצעה יחידה — אין בסיס להשוואה</p>;
  return <p className="mt-0.5 text-xs text-ink-muted num">—</p>;
}

function SignedAmount({ value }: { value: number }) {
  return <span className="num">{value > 0 ? '+' : '−'}{fmtMoneyExact(Math.abs(value))}</span>;
}

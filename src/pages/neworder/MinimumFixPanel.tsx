import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Modal } from '../../components/ui';
import { fmtMoneyExact } from '../../lib/format';
import type { ResolutionOption, SplitSupplier, SupplierGroup } from '../../lib/orderSplit';
import type { Product } from '../../lib/types';

interface MinimumFixPanelProps {
  open: boolean;
  onClose: () => void;
  supplier: SplitSupplier | null;
  group: SupplierGroup | null;
  options: readonly ResolutionOption[];
  products: ReadonlyMap<string, Product>;
  suppliers: ReadonlyMap<string, SplitSupplier>;
  onChoose: (option: ResolutionOption) => void;
  showOptionsWhenPassing?: boolean;
}

export default function MinimumFixPanel({
  open,
  onClose,
  supplier,
  group,
  options,
  products,
  suppliers,
  onChoose,
  showOptionsWhenPassing = false,
}: MinimumFixPanelProps) {
  const shortfall = group?.shortfall ?? null;
  const passed = !!group && !group.belowMinimum;
  const description = group
    ? 'בחרו פעולה שמתאימה לחלוקת ההזמנה.'
    : 'הספק המוצמד אינו זמין עוד. בחרו ספק חלופי או בטלו את ההצמדה.';

  return (
    <Modal open={open} onClose={onClose} title={`פתרונות עבור ${supplier?.name ?? 'ספק לא זמין'}`} description={description}>
      {group?.belowMinimum && shortfall != null && <p className="mb-3 text-sm text-ink-soft">חסרים בדיוק <strong className="num text-ink">{fmtMoneyExact(shortfall)}</strong> כדי לעמוד במינימום ההזמנה.</p>}
      {group ? (
        <div className={passed ? 'note-done mb-4' : 'note-await mb-4'}>
          {passed
            ? <CheckCircle2 size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            : <AlertTriangle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />}
          <div className="grid flex-1 gap-1 text-sm sm:grid-cols-3">
            <Metric label="סכום נוכחי" value={fmtMoneyExact(group.subtotal)} />
            <Metric label="מינימום" value={fmtMoneyExact(group.supplier.minOrderAmount)} />
            <Metric label="חסר" value={group.supplier.minOrderAmount == null ? '—' : fmtMoneyExact(group.belowMinimum ? group.shortfall : 0)} />
          </div>
        </div>
      ) : (
        <div className="note-alert mb-4">ההצמדה אינה תקפה, ולכן הפריט אינו יכול לעבור לשלב האישור.</div>
      )}

      {passed && !showOptionsWhenPassing ? (
        <div className="note-done">הקבוצה עוברת כעת את מינימום ההזמנה.</div>
      ) : options.length ? (
        <div className="space-y-2">
          {options.map((option, index) => {
            const outcome = optionOutcome(option);
            const remainingShortfall = optionShortfall(option, supplier, suppliers);
            return (
              <button
                type="button"
                key={optionKey(option, index)}
                className="flex min-h-11 w-full items-center justify-between gap-3 border border-line px-3 py-2 text-start hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                onClick={() => onChoose(option)}
              >
                <span className="min-w-0 text-sm font-medium text-ink-body">
                  <OptionLabel option={option} products={products} suppliers={suppliers} />
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1 text-xs">
                  <span className="text-ink-muted"><OptionCost option={option} /></span>
                  {outcome === 'done' && <span className="badge-done">עובר את המינימום</span>}
                  {outcome === 'await' && <span className="badge-await">עדיין חסר <span className="num ms-1">{fmtMoneyExact(remainingShortfall)}</span></span>}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="note-idle">לא נמצאה כרגע חלופה אוטומטית. ניתן לחזור ולשנות ספק או כמות ידנית.</div>
      )}
    </Modal>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span className="block text-xs opacity-80">{label}</span><strong className="num">{value}</strong></div>;
}

function OptionLabel({ option, products, suppliers }: {
  option: ResolutionOption;
  products: ReadonlyMap<string, Product>;
  suppliers: ReadonlyMap<string, SplitSupplier>;
}) {
  const product = 'productId' in option ? products.get(option.productId)?.name ?? 'מוצר' : 'מוצר';
  if (option.kind === 'increase_qty') {
    return <>הגדל &quot;{product}&quot; מ-<span className="num">{option.fromQty}</span> ל-<span className="num">{option.toQty}</span></>;
  }
  if (option.kind === 'move_line') {
    const target = suppliers.get(option.toSupplierId)?.name ?? 'ספק חלופי';
    return option.requiresQty == null
      ? <>העבר &quot;{product}&quot; ל&quot;{target}&quot;</>
      : <>העבר ל&quot;{target}&quot; והגדל ל-<span className="num">{option.requiresQty}</span></>;
  }
  if (option.kind === 'move_group') {
    const target = suppliers.get(option.toSupplierId)?.name ?? 'ספק חלופי';
    return <>העבר את כל <span className="num">{option.lineCount}</span> הפריטים ל&quot;{target}&quot;</>;
  }
  if (option.kind === 'remove_line') return <>הסר &quot;{product}&quot; מההזמנה</>;
  return <>הסר ושמור את &quot;{product}&quot; להזמנה הבאה</>;
}

function optionOutcome(option: ResolutionOption): 'done' | 'await' | null {
  if (option.kind === 'increase_qty') return option.clearsMinimum ? 'done' : 'await';
  if (option.kind === 'move_line') return !option.sourceStillBelow && option.targetClearsMin ? 'done' : 'await';
  if (option.kind === 'move_group') return option.targetClearsMin ? 'done' : 'await';
  return null;
}

function optionShortfall(
  option: ResolutionOption,
  sourceSupplier: SplitSupplier | null,
  suppliers: ReadonlyMap<string, SplitSupplier>,
): number | null {
  if (option.kind === 'increase_qty') return positiveDifference(sourceSupplier?.minOrderAmount, option.subtotalAfter);
  if (option.kind === 'move_line') {
    if (option.sourceStillBelow) return positiveDifference(sourceSupplier?.minOrderAmount, option.sourceSubtotalAfter);
    return positiveDifference(suppliers.get(option.toSupplierId)?.minOrderAmount, option.targetSubtotalAfter);
  }
  if (option.kind === 'move_group') return positiveDifference(suppliers.get(option.toSupplierId)?.minOrderAmount, option.targetSubtotalAfter);
  return null;
}

function positiveDifference(minimum: number | null | undefined, subtotal: number): number | null {
  return minimum == null ? null : Math.max(0, Math.round((minimum - subtotal) * 100) / 100);
}

function OptionCost({ option }: { option: ResolutionOption }) {
  if (option.kind === 'increase_qty') return <><span className="num">+{fmtMoneyExact(option.costDelta)}</span> · סה״כ <span className="num">{fmtMoneyExact(option.subtotalAfter)}</span></>;
  if ((option.kind === 'move_line' || option.kind === 'move_group') && option.costDelta === 0) return <>ללא שינוי בעלות</>;
  const value = option.kind === 'move_line' || option.kind === 'move_group' ? option.costDelta : -option.refund;
  return <span className="num">{value > 0 ? '+' : '−'}{fmtMoneyExact(Math.abs(value))}</span>;
}

function optionKey(option: ResolutionOption, index: number): string {
  const product = 'productId' in option ? option.productId : option.productIds.join(',');
  const supplier = 'toSupplierId' in option ? option.toSupplierId : '';
  return `${option.kind}:${product}:${supplier}:${index}`;
}

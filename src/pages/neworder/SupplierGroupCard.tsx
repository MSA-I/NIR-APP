import { fmtMoneyExact } from '../../lib/format';
import { ActionMenu } from '../../components/ActionMenu';
import type { SupplierGroup } from '../../lib/orderSplit';
import type { Product } from '../../lib/types';

interface SupplierGroupCardProps {
  group: SupplierGroup;
  products: ReadonlyMap<string, Product>;
  onOpenFix: () => void;
  onOpenGroupMove: () => void;
  canMoveGroup: boolean;
}

export default function SupplierGroupCard({ group, products, onOpenFix, onOpenGroupMove, canMoveGroup }: SupplierGroupCardProps) {
  const { supplier, subtotal, belowMinimum, shortfall, savingsContribution } = group;
  return (
    <div className={belowMinimum ? 'bg-await-wash' : ''}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <div className="font-semibold text-ink-body">{supplier.name}</div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted"><span><span className="num">{group.lines.length}</span> פריטים</span>{belowMinimum && <span className="badge-await">מתחת למינימום</span>}</div>
        </div>
        <div className="ms-auto text-end">
          <div className="num font-semibold text-ink">{fmtMoneyExact(subtotal)}</div>
          <div className="text-xs text-ink-muted">סכום הזמנה</div>
        </div>
        <ActionMenu label={`פעולות עבור ${supplier.name}`} items={[{
          key: 'move-group',
          label: 'העבר את כל הקבוצה ל…',
          disabled: !canMoveGroup,
          onSelect: onOpenGroupMove,
        }]} />
      </div>

      <dl className="grid grid-cols-2 gap-px border-y border-line-soft bg-line-soft text-xs sm:grid-cols-4">
        <LedgerMetric label="מינימום ספק" value={fmtMoneyExact(supplier.minOrderAmount)} />
        <LedgerMetric label="חסר למינימום" value={supplier.minOrderAmount == null ? '—' : belowMinimum ? fmtMoneyExact(shortfall) : fmtMoneyExact(0)} tone={supplier.minOrderAmount == null ? undefined : belowMinimum ? 'await' : 'done'} />
        <LedgerMetric label="תרומת חיסכון" value={savingsContribution == null ? '—' : signedMoney(savingsContribution)} />
        <LedgerMetric label="סטטוס" value={belowMinimum ? 'דורש השלמה' : 'מוכן'} tone={belowMinimum ? 'await' : 'done'} />
      </dl>

      <div className="divide-y divide-line-soft">
        {group.lines.map((line) => (
          <div key={line.productId} className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center sm:gap-5 sm:px-4">
            <span className="min-w-0 break-words font-medium text-ink-body">{products.get(line.productId)?.name ?? 'מוצר'}</span>
            <span className="text-xs text-ink-muted">כמות <span className="num text-ink">{line.qty}</span></span>
            <span className="text-xs text-ink-muted"><span className="num text-ink">{fmtMoneyExact(line.unitPrice)}</span> ליחידה</span>
            <strong className="num text-ink sm:text-end">{fmtMoneyExact(line.lineTotal)}</strong>
          </div>
        ))}
      </div>

      {belowMinimum && (
        <div className="note-await mx-3 mb-3 mt-3 flex-wrap items-center justify-between sm:mx-4">
          <span>חסרים <strong className="num">{fmtMoneyExact(shortfall)}</strong> למינימום ההזמנה.</span>
          <button type="button" className="btn-secondary w-full border-await-line text-await-fg sm:w-auto" onClick={onOpenFix}>
            הצג פתרונות
          </button>
        </div>
      )}
    </div>
  );
}

function LedgerMetric({ label, value, tone }: { label: string; value: string; tone?: 'done' | 'await' }) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={`num mt-0.5 font-semibold ${tone === 'done' ? 'text-done-fg' : tone === 'await' ? 'text-await-fg' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}

function signedMoney(value: number): string {
  if (value === 0) return fmtMoneyExact(0);
  return `${value > 0 ? '+' : '−'}${fmtMoneyExact(Math.abs(value))}`;
}

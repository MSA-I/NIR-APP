import { fmtMoneyExact } from '../../lib/format';
import type { Supplier } from '../../lib/types';

interface SupplierGroupCardProps {
  supplier: Supplier;
  itemCount: number;
  subtotal: number;
}

export default function SupplierGroupCard({ supplier, itemCount, subtotal }: SupplierGroupCardProps) {
  const underMin = supplier.min_order_amount != null && subtotal < supplier.min_order_amount;
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 sm:px-4 ${underMin ? 'bg-await-wash' : ''}`}>
      <span className="font-medium text-ink-body">{supplier.name}</span><span className="text-xs text-ink-muted">{itemCount} פריטים</span>
      <span className="ms-auto font-semibold num">{fmtMoneyExact(subtotal)}</span>
      {underMin && <span className="w-full text-xs text-await-fg">מתחת למינימום הזמנה של {fmtMoneyExact(supplier.min_order_amount!)}</span>}
    </div>
  );
}

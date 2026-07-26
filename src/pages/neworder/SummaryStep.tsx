import { CheckCircle2, Loader2 } from 'lucide-react';
import { fmtMoneyExact } from '../../lib/format';
import type { OrderSavings } from '../../lib/orderSavings';

interface SummaryStepProps {
  savings: OrderSavings;
  singleSupplierName: string | null;
  productCount: number;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}

export default function SummaryStep({ savings, singleSupplierName, productCount, busy, onBack, onConfirm }: SummaryStepProps) {
  return (
    <>
      <div className="divide-y divide-line-soft border-y border-line-strong text-sm">
        <SummaryRow label="מספר ספקים" value={String(savings.supplierCount)} />
        <SummaryRow label="מספר מוצרים" value={String(productCount)} />
        <SummaryRow label="עלות לאחר חלוקה" value={fmtMoneyExact(savings.splitTotal)} />
        <SummaryRow label="מחיר אצל ספק יחיד" value={savings.singleSupplierTotal === null ? '—' : `${fmtMoneyExact(savings.singleSupplierTotal)}${singleSupplierName ? ` · ${singleSupplierName}` : ''}`} />
        <SummaryRow label={savings.savings !== null && savings.savings < 0 ? 'תוספת עלות לעומת ספק יחיד' : 'חיסכון לעומת ספק יחיד'}
          value={savings.savings === null ? '—' : `${fmtMoneyExact(Math.abs(savings.savings))} (${Math.abs(savings.savingsPercent ?? 0).toFixed(1)}%)`} />
        <SummaryRow label="כל המוצרים הוקצו לספק הזול ביותר" value={savings.allCheapest ? '✓ כן' : 'לא'} tone={savings.allCheapest ? 'done' : 'await'} />
      </div>
      {savings.singleSupplierTotal === null && <p className="mt-3 text-sm text-ink-muted">אין ספק יחיד שמציע את כל מוצרי הסל, ולכן לא מוצגת טענת חיסכון.</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>חזרה לעריכה</button>
        <button type="button" className="btn-primary" disabled={busy || savings.splitTotal === null} onClick={onConfirm}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} אשר ושלח הזמנה
        </button>
      </div>
    </>
  );
}

function SummaryRow({ label, value, tone }: { label: string; value: string; tone?: 'done' | 'await' }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 py-3"><span className="text-ink-muted">{label}</span><strong className={`num text-end ${tone === 'done' ? 'text-done-fg' : tone === 'await' ? 'text-await-fg' : 'text-ink'}`}>{value}</strong></div>;
}

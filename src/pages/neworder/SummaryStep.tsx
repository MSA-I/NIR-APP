import { CheckCircle2, Loader2 } from 'lucide-react';
import { fmtDate, fmtMoneyExact } from '../../lib/format';
import type { OrderSplit } from '../../lib/orderSplit';
import type { Product } from '../../lib/types';
import { ICON } from '../../components/ui';

interface SummaryStepProps {
  split: OrderSplit;
  products: ReadonlyMap<string, Product>;
  singleSupplierName: string | null;
  productCount: number;
  notes: string;
  expectedDate: string;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}

export default function SummaryStep({ split, products, singleSupplierName, productCount, notes, expectedDate, busy, onBack, onConfirm }: SummaryStepProps) {
  const { savings } = split;
  const breaches = split.groups.filter((group) => group.belowMinimum);
  return (
    <div className="space-y-4">
      {breaches.length > 0 && (
        <section className="note-await block" aria-labelledby="minimum-summary-title">
          <h2 id="minimum-summary-title" className="font-semibold">
            <span className="num">{breaches.length}</span> ספקים מתחת למינימום ההזמנה שלהם. ההזמנה תישלח כרגיל — ייתכן שהספק יבקש להשלים.
          </h2>
          <ul className="mt-2 space-y-1 text-xs">
            {breaches.map((group) => <li key={group.supplier.id}>{group.supplier.name} · חסרים <span className="num font-semibold">{fmtMoneyExact(group.shortfall)}</span></li>)}
          </ul>
        </section>
      )}

      <section aria-labelledby="summary-title" className="border-y border-line-strong bg-surface">
        <div className="border-b border-line-soft px-3 py-3 sm:px-4"><h2 id="summary-title" className="section-title">סיכום ההזמנה</h2></div>
        <div className="grid grid-cols-2 gap-px bg-line-soft sm:grid-cols-4">
          <SummaryMetric label="מספר ספקים" value={String(savings.supplierCount)} />
          <SummaryMetric label="מספר מוצרים" value={String(productCount)} />
          <SummaryMetric label="עלות לאחר חלוקה" value={fmtMoneyExact(savings.splitTotal)} />
          <SummaryMetric label={savings.savings != null && savings.savings < 0 ? 'תוספת עלות לעומת ספק יחיד' : 'חיסכון לעומת ספק יחיד'} value={savings.savings == null ? '—' : `${fmtMoneyExact(Math.abs(savings.savings))} (${Math.abs(savings.savingsPercent ?? 0).toFixed(1)}%)`} tone={savings.savings != null && savings.savings >= 0 ? 'done' : 'await'} />
        </div>
        {savings.singleSupplierTotal == null ? <p className="border-t border-line-soft px-3 py-3 text-sm text-ink-muted sm:px-4">אין ספק יחיד שמציע את כל מוצרי הסל, ולכן לא מוצגת טענת חיסכון.</p>
          : <p className="border-t border-line-soft px-3 py-3 text-sm text-ink-muted sm:px-4">חלופת ספק יחיד: {singleSupplierName ?? 'ספק'} · <span className="num font-semibold text-ink">{fmtMoneyExact(savings.singleSupplierTotal)}</span></p>}
      </section>

      <section aria-labelledby="summary-suppliers-title" className="border-y border-line-strong bg-surface">
        <div className="border-b border-line-soft px-3 py-3 sm:px-4"><h2 id="summary-suppliers-title" className="section-title">הזמנות שייווצרו</h2></div>
        <div className="divide-y divide-line-strong">
          {split.groups.map((group) => (
            <div key={group.supplier.id}>
              <div className="flex flex-wrap items-center justify-between gap-2 bg-surface-sunken px-3 py-2.5 sm:px-4"><strong>{group.supplier.name}</strong><span className="num font-semibold">{fmtMoneyExact(group.subtotal)}</span></div>
              <div className="divide-y divide-line-soft">
                {group.lines.map((line) => <div key={line.productId} className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-5 sm:px-4"><span className="font-medium text-ink-body">{products.get(line.productId)?.name ?? 'מוצר'}</span><span className="text-ink-muted">כמות <span className="num text-ink">{line.qty}</span></span><strong className="num sm:text-end">{fmtMoneyExact(line.lineTotal)}</strong></div>)}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line-strong bg-surface px-3 py-3 text-sm sm:px-4" aria-label="פרטי הזמנה">
        <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-xs text-ink-muted">אספקה מבוקשת</dt><dd className="mt-0.5 font-medium">{expectedDate ? <span className="num">{fmtDate(expectedDate)}</span> : 'לא נקבעה'}</dd></div><div><dt className="text-xs text-ink-muted">הערות</dt><dd className="mt-0.5 whitespace-pre-wrap text-ink-body">{notes.trim() || 'אין הערות'}</dd></div></dl>
      </section>

      <div className="flex flex-wrap justify-end gap-2 border-t border-line-strong bg-surface px-3 py-3 sm:px-4">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>חזרה לעריכת ספקים</button>
        <button type="button" className="btn-primary" disabled={busy || savings.splitTotal === null} onClick={onConfirm}>
          {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={ICON.sm} aria-hidden="true" />} אשר ושלח הזמנות
        </button>
      </div>
    </div>
  );
}

function SummaryMetric({ label, value, tone }: { label: string; value: string; tone?: 'done' | 'await' }) {
  return <div className="bg-surface px-3 py-3"><div className="text-xs text-ink-muted">{label}</div><strong className={`num mt-1 block text-base ${tone === 'done' ? 'text-done-fg' : tone === 'await' ? 'text-await-fg' : 'text-ink'}`}>{value}</strong></div>;
}

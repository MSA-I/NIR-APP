import { CheckCircle2, Loader2 } from 'lucide-react';
import { fmtDate, fmtMoneyExact } from '../../lib/format';
import type { OrderSplit } from '../../lib/orderSplit';
import type { Product } from '../../lib/types';
import { ICON } from '../../components/ui';
import { useT } from '../../lib/i18n/LocaleProvider';

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
  const { t } = useT();
  const { savings } = split;
  const breaches = split.groups.filter((group) => group.belowMinimum);
  return (
    <div className="space-y-4">
      {breaches.length > 0 && (
        <section className="note-await block" aria-labelledby="minimum-summary-title">
          <h2 id="minimum-summary-title" className="font-semibold">
            {breaches.length === 1
              ? t('summaryStep.minimumOne')
              : t('summaryStep.minimumMany', { count: breaches.length })}
          </h2>
          <ul className="mt-2 space-y-1 text-xs">
            {breaches.map((group) => <li key={group.supplier.id}><bdi>{group.supplier.name}</bdi>{' '}
              {t('summaryStep.shortfallPrefix')} <span className="num font-semibold">{fmtMoneyExact(group.shortfall, group.currency)}</span></li>)}
          </ul>
        </section>
      )}

      <section aria-labelledby="summary-title" className="border-y border-line-strong bg-surface">
        <div className="border-b border-line-soft px-3 py-3 sm:px-4"><h2 id="summary-title" className="section-title">{t('summaryStep.text')}</h2></div>
        <div className="grid grid-cols-2 gap-px bg-line-soft sm:grid-cols-4">
          <SummaryMetric label={t('summaryStep.label')} value={String(savings.supplierCount)} />
          <SummaryMetric label={t('summaryStep.label_2')} value={String(productCount)} />
          <SummaryMetric label={t('summaryStep.label_3')} value={fmtMoneyExact(savings.splitTotal, savings.currency)} />
          <SummaryMetric label={savings.savings != null && savings.savings < 0
            ? t('summaryStep.extraCostMetric')
            : t('summaryStep.savingsMetric')} value={savings.savings == null ? '—' : `${fmtMoneyExact(Math.abs(savings.savings), savings.currency)} (${Math.abs(savings.savingsPercent ?? 0).toFixed(1)}%)`} tone={savings.savings != null && savings.savings >= 0 ? 'done' : 'await'} />
        </div>
        {savings.singleSupplierTotal == null ? <p className="border-t border-line-soft px-3 py-3 text-sm text-ink-muted sm:px-4">{t('summaryStep.text_2')}</p>
          : <p className="border-t border-line-soft px-3 py-3 text-sm text-ink-muted sm:px-4">{t('summaryStep.singleSupplierAlternative')}{' '}
            <bdi>{singleSupplierName ?? t('summaryStep.genericSupplier')}</bdi> · <span className="num font-semibold text-ink">{fmtMoneyExact(savings.singleSupplierTotal, savings.currency)}</span></p>}
      </section>

      <section aria-labelledby="summary-suppliers-title" className="border-y border-line-strong bg-surface">
        <div className="border-b border-line-soft px-3 py-3 sm:px-4"><h2 id="summary-suppliers-title" className="section-title">{t('summaryStep.text_3')}</h2></div>
        <div className="divide-y divide-line-strong">
          {split.groups.map((group) => (
            <div key={group.supplier.id}>
              <div className="flex flex-wrap items-center justify-between gap-2 bg-surface-sunken px-3 py-2.5 sm:px-4"><strong><bdi>{group.supplier.name}</bdi></strong><span className="num font-semibold">{fmtMoneyExact(group.subtotal, group.currency)}</span></div>
              <div className="divide-y divide-line-soft">
                {group.lines.map((line) => <div key={line.productId} className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-5 sm:px-4"><span className="font-medium text-ink-body"><bdi>{products.get(line.productId)?.name ?? t('summaryStep.map')}</bdi></span><span className="text-ink-muted">{t('summaryStep.map_2')} <span className="num text-ink">{line.qty}</span></span><strong className="num sm:text-end">{fmtMoneyExact(line.lineTotal, line.currency)}</strong></div>)}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line-strong bg-surface px-3 py-3 text-sm sm:px-4" aria-label={t('summaryStep.aria_label')}>
        <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-xs text-ink-muted">{t('summaryStep.fmtDate_3')}</dt><dd className="mt-0.5 font-medium">{expectedDate ? <span className="num">{fmtDate(expectedDate)}</span> : t('summaryStep.fmtDate')}</dd></div><div><dt className="text-xs text-ink-muted">{t('summaryStep.fmtDate_4')}</dt><dd className="mt-0.5 whitespace-pre-wrap text-ink-body">{notes.trim() || t('summaryStep.fmtDate_2')}</dd></div></dl>
      </section>

      <div className="flex flex-wrap justify-end gap-2 border-t border-line-strong bg-surface px-3 py-3 sm:px-4">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>{t('summaryStep.text_4')}</button>
        <button type="button" className="btn-primary" disabled={busy || savings.splitTotal === null} onClick={onConfirm}>
          {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={ICON.sm} aria-hidden="true" />} {t('summaryStep.confirmOrders')}
        </button>
      </div>
    </div>
  );
}

function SummaryMetric({ label, value, tone }: { label: string; value: string; tone?: 'done' | 'await' }) {
  return <div className="bg-surface px-3 py-3"><div className="text-xs text-ink-muted">{label}</div><strong className={`num mt-1 block text-base ${tone === 'done' ? 'text-done-fg' : tone === 'await' ? 'text-await-fg' : 'text-ink'}`}>{value}</strong></div>;
}

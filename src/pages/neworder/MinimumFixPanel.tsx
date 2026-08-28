import { useT } from '../../lib/i18n/LocaleProvider';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ICON, Modal } from '../../components/ui';
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
  const { t } = useT();
  const shortfall = group?.shortfall ?? null;
  const passed = !!group && !group.belowMinimum;
  const description = group
    ? t('minimumFix.text')
    : t('minimumFix.text_2');

  return (
    <Modal open={open} onClose={onClose} title={t('minimumFix.modalTitle', { supplier: supplier?.name ?? t('minimumFix.supplierUnavailable') })} description={description}>
      {group?.belowMinimum && shortfall != null && <p className="mb-3 text-sm text-ink-soft">{t('minimumFix.fmtMoneyExact')} <strong className="num text-ink">{fmtMoneyExact(shortfall)}</strong> {t('minimumFix.fmtMoneyExact_2')}</p>}
      {group ? (
        <div className={passed ? 'note-done mb-4' : 'note-await mb-4'}>
          {passed
            ? <CheckCircle2 size={ICON.md} className="mt-0.5 shrink-0" aria-hidden="true" />
            : <AlertTriangle size={ICON.md} className="mt-0.5 shrink-0" aria-hidden="true" />}
          <div className="grid flex-1 gap-1 text-sm sm:grid-cols-3">
            <Metric label={t('minimumFix.label')} value={fmtMoneyExact(group.subtotal)} />
            <Metric label={t('minimumFix.label_2')} value={fmtMoneyExact(group.supplier.minOrderAmount)} />
            <Metric label={t('minimumFix.label_3')} value={group.supplier.minOrderAmount == null ? '—' : fmtMoneyExact(group.belowMinimum ? group.shortfall : 0)} />
          </div>
        </div>
      ) : (
        <div className="note-alert mb-4">{t('minimumFix.text_3')}</div>
      )}

      {passed && !showOptionsWhenPassing ? (
        <div className="note-done">{t('minimumFix.text_4')}</div>
      ) : options.length ? (
        <div className="space-y-2">
          {options.map((option, index) => {
            const outcome = optionOutcome(option);
            const remainingShortfall = optionShortfall(option, supplier, suppliers);
            return (
              <button
                type="button"
                key={optionKey(option, index)}
                className="flex min-h-11 w-full items-center justify-between gap-3 border border-line px-3 py-2 text-start hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                onClick={() => onChoose(option)}
              >
                <span className="min-w-0 text-sm font-medium text-ink-body">
                  <OptionLabel option={option} products={products} suppliers={suppliers} />
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1 text-xs">
                  <span className="text-ink-muted"><OptionCost option={option} /></span>
                  {outcome === 'done' && <span className="badge-done">{t('minimumFix.text_5')}</span>}
                  {outcome === 'await' && <span className="badge-await">{t('minimumFix.fmtMoneyExact_3')} <span className="num ms-1">{fmtMoneyExact(remainingShortfall)}</span></span>}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="note-idle">{t('minimumFix.text_6')}</div>
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
  const { t } = useT();
  const product = 'productId' in option ? products.get(option.productId)?.name ?? t('minimumFix.get') : t('minimumFix.get_2');
  if (option.kind === 'increase_qty') {
    return <>{t('minimumFix.increaseQty', { product })} <span className="num">{option.fromQty}</span> {t('minimumFix.text_7')}<span className="num">{option.toQty}</span></>;
  }
  if (option.kind === 'move_line') {
    const target = suppliers.get(option.toSupplierId)?.name ?? t('minimumFix.get_3');
    return option.requiresQty == null
      ? <>{t('minimumFix.moveLine', { product, target })}</>
      : <>{t('minimumFix.moveLineAndRaise', { target })} <span className="num">{option.requiresQty}</span></>;
  }
  if (option.kind === 'move_group') {
    const target = suppliers.get(option.toSupplierId)?.name ?? t('minimumFix.get_4');
    return <>{t('minimumFix.text_8')} <span className="num">{option.lineCount}</span> {t('minimumFix.moveGroupTail', { target })}</>;
  }
  if (option.kind === 'remove_line') return <>{t('minimumFix.removeLine', { product })}</>;
  return <>{t('minimumFix.removeAndKeep', { product })}</>;
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
  const { t } = useT();
  if (option.kind === 'increase_qty') return <><span className="num">+{fmtMoneyExact(option.costDelta)}</span> {t('minimumFix.fmtMoneyExact_4')} <span className="num">{fmtMoneyExact(option.subtotalAfter)}</span></>;
  if ((option.kind === 'move_line' || option.kind === 'move_group') && option.costDelta === 0) return <>{t('minimumFix.text_9')}</>;
  const value = option.kind === 'move_line' || option.kind === 'move_group' ? option.costDelta : -option.refund;
  return <span className="num">{value > 0 ? '+' : '−'}{fmtMoneyExact(Math.abs(value))}</span>;
}

function optionKey(option: ResolutionOption, index: number): string {
  const product = 'productId' in option ? option.productId : option.productIds.join(',');
  const supplier = 'toSupplierId' in option ? option.toSupplierId : '';
  return `${option.kind}:${product}:${supplier}:${index}`;
}

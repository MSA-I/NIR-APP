import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t.ts';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Banknote, Calculator, ChevronLeft, FileSpreadsheet, Loader2, Printer, ReceiptText, type LucideIcon } from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useParamState } from '../lib/useParamState';
import { DataTable, EmptyState, ErrorNote, ICON, Modal, Note, PageHeader, SkeletonCards, StatusBadge, ToggleGroup, useToast, type Column } from '../components/ui';
import { INVOICE_PAYMENT_STATUS } from '../lib/status';
import {
  addCalendarDays, daysInCalendarMonth, fmtDate, fmtMoneyRounded, fmtMoneyExact, fmtNum,
  shiftCalendarMonth, todayISO,
} from '../lib/format';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { useAuth } from '../auth/AuthContext';
import { financialSupplierMap } from '../lib/financialSuppliers';
import { neutralizeSpreadsheetRow } from '../lib/documentExport';
import {
  downloadRenderedWorkbook,
  expenseSummaryTemplateValues,
  reportTemplateErrorText,
  renderConfiguredReportTemplate,
  type PurchaseMetrics,
} from '../lib/reportTemplateExport';

type InvoiceRow = {
  id: string; invoice_number: string; invoice_date: string; total_amount: number;
  payment_status: string; supplier_id: string; supplier: { name: string } | null;
};
type RawInvoiceRow = Omit<InvoiceRow, 'supplier'>;
type RawOrderItem = {
  qty: number;
  unit_price: number;
  product: { category_id: string | null } | { category_id: string | null }[] | null;
};
type SupplierRow = { id: string; name: string; count: number; total: number };

/** The one id the two date inputs point at when the range is refused. */
const RANGE_ERROR_ID = 'expenses-range-error';

type PresetKey = 'month' | 'prevMonth' | 'quarter' | 'year';
const PRESETS: { key: PresetKey; labelKey: TKey }[] = [
  { key: 'month', labelKey: 'expenses.presetMonth' },
  { key: 'prevMonth', labelKey: 'expenses.presetPrevMonth' },
  { key: 'quarter', labelKey: 'expenses.presetQuarter' },
  { key: 'year', labelKey: 'expenses.presetYear' },
];

// Israel business-calendar ranges. "3 חודשים" starts two calendar months back; "שנה" is
// the trailing twelve months with the day clamped for leap-day/month-length boundaries.
function presetRange(key: PresetKey): { from: string; to: string } {
  const today = todayISO();
  const month = today.slice(0, 7);
  const monthStart = `${month}-01`;
  switch (key) {
    case 'month': return { from: monthStart, to: today };
    case 'prevMonth': return {
      from: `${shiftCalendarMonth(month, -1)}-01`,
      to: addCalendarDays(monthStart, -1),
    };
    case 'quarter': return { from: `${shiftCalendarMonth(month, -2)}-01`, to: today };
    case 'year': {
      const priorMonth = shiftCalendarMonth(month, -12);
      const day = String(Math.min(Number(today.slice(8, 10)), daysInCalendarMonth(priorMonth))).padStart(2, '0');
      return { from: `${priorMonth}-${day}`, to: today };
    }
  }
}

// One segment in a compact control-room strip. The square marker and shared ruled surface keep
// the summary dense and operational instead of turning each number into a floating card.
function StripStat({ title, value, context, icon: Icon }: {
  title: string; value: string; context?: string; icon: LucideIcon;
}) {
  return (
    <div className="min-h-20 border-t border-line-soft px-4 py-3 first:border-t-0 sm:border-s sm:border-t-0 sm:px-5 sm:first:border-s-0">
      <div className="flex items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center border border-line-soft bg-surface-sunken text-idle-fg" aria-hidden="true">
          <Icon size={ICON.sm} />
        </span>
        <span className="text-xs font-medium text-ink-muted">{title}</span>
      </div>
      <div className="mt-1.5 kpi-value num text-ink sm:text-2xl" dir="ltr">{value}</div>
      {context && <div className="mt-1 text-xs text-ink-muted">{context}</div>}
    </div>
  );
}

export default function Expenses() {
  const { profile, org } = useAuth();
  const { errorText, statusLabel, t } = useT();
  const toast = useToast();
  const defaults = presetRange('month');
  // useParamState seeds from the URL and re-syncs when it changes; the URL is also WRITTEN
  // (replace, no history spam) so the chosen range is genuinely shareable/bookmarkable.
  const [from] = useParamState('from', defaults.from);
  const [to] = useParamState('to', defaults.to);
  const [params, setParams] = useSearchParams();
  const [drill, setDrill] = useState<SupplierRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const invalidRange = !!from && !!to && from > to;
  const categoryBreakdownAvailable = profile?.role === 'owner';

  function setRange(nextFrom: string, nextTo: string) {
    if (!nextFrom || !nextTo) return; // a cleared date input is not a range claim
    const next = new URLSearchParams(params);
    next.set('from', nextFrom);
    next.set('to', nextTo);
    setParams(next, { replace: true });
  }

  const { data, loading, fetching, error } = useQuery(async () => {
    if (invalidRange) return {
      invoices: [], bySupplier: [], catTotals: [], totalAll: 0, coveredTotal: 0,
      invalidRange: true, categoryBreakdownAvailable,
      metrics: { committed: null, gross_expense: null, credits_recognised: null, net_expense: null } as PurchaseMetrics,
    };
    const end = addCalendarDays(to, 1);
    const [rawInvoices, categories, metrics] = await Promise.all([
      fetchAll<RawInvoiceRow>((fromRow, toRow) => supabase.from('invoices')
        .select('id, invoice_number, invoice_date, total_amount, payment_status, supplier_id')
        .eq('financial_role', 'payable')
        .gte('invoice_date', from).lt('invoice_date', end)
        .is('deleted_at', null)
        .order('invoice_date', { ascending: false }).order('id').range(fromRow, toRow)),
      categoryBreakdownAvailable
        ? fetchAll<{ id: string; name: string }>((fromRow, toRow) => supabase.from('categories')
          .select('id, name').order('name').order('id').range(fromRow, toRow))
        : Promise.resolve([] as { id: string; name: string }[]),
      supabase.rpc('get_purchase_metrics', { p_from: from, p_to: to })
        .then((result) => unwrap(result) as PurchaseMetrics),
    ]);
    const suppliers = await financialSupplierMap(rawInvoices.map((invoice) => invoice.supplier_id));
    const invoices: InvoiceRow[] = rawInvoices.map((invoice) => ({
      ...invoice,
      supplier: { name: suppliers.get(invoice.supplier_id)?.name ?? '—' },
    }));
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

    // Category split can only be derived from purchase orders (invoices carry no line items):
    // in-range invoices → invoice_order_links → purchase_order_items at snapshot prices.
    let links: { invoice_id: string; order_id: string }[] = [];
    let items: { qty: number; unit_price: number; product: { category_id: string | null } | null }[] = [];
    if (categoryBreakdownAvailable && invoices.length) {
      links = await fetchInChunks(invoices.map((i) => i.id), (chunk) =>
        fetchAll<{ invoice_id: string; order_id: string }>((fromRow, toRow) => supabase.from('invoice_order_links')
          .select('invoice_id, order_id').in('invoice_id', chunk)
          .order('invoice_id').order('order_id').range(fromRow, toRow)));
      const orderIds = [...new Set(links.map((l) => l.order_id))];
      if (orderIds.length) {
        const rawItems = await fetchInChunks(orderIds, (chunk) =>
          fetchAll<RawOrderItem>((fromRow, toRow) => supabase.from('purchase_order_items')
            .select('qty, unit_price, product:products(category_id)')
            .in('order_id', chunk).order('order_id').order('id').range(fromRow, toRow)));
        items = rawItems.map((item) => ({
          ...item,
          product: Array.isArray(item.product) ? item.product[0] ?? null : item.product,
        }));
      }
    }

    // Coverage is expressed separately from the category rows. Category values come from order
    // snapshots, not invoice lines, so the UI never presents them as an exact invoice breakdown.
    const linkedIds = new Set(links.map((l) => l.invoice_id));
    const totalAll = invoices.reduce((s, i) => s + i.total_amount, 0);
    const coveredTotal = invoices.filter((i) => linkedIds.has(i.id)).reduce((s, i) => s + i.total_amount, 0);

    const byCat = new Map<string, number>();
    for (const it of items) {
      const name = (it.product?.category_id && categoryNames.get(it.product.category_id)) || t('expenses.get');
      byCat.set(name, (byCat.get(name) ?? 0) + it.qty * it.unit_price);
    }
    const catTotals = [...byCat.entries()].map(([name, total]) => ({ name, total })).filter((c) => c.total > 0);

    const bySupMap = new Map<string, SupplierRow>();
    for (const inv of invoices) {
      const row = bySupMap.get(inv.supplier_id) ?? { id: inv.supplier_id, name: inv.supplier?.name ?? '—', count: 0, total: 0 };
      row.count += 1;
      row.total += inv.total_amount;
      bySupMap.set(inv.supplier_id, row);
    }
    const bySupplier = [...bySupMap.values()].sort((a, b) => b.total - a.total);

    return {
      invoices, bySupplier, catTotals, totalAll, coveredTotal,
      invalidRange: false, categoryBreakdownAvailable, metrics,
    };
  }, [from, to, invalidRange, categoryBreakdownAvailable]);

  async function exportExcel() {
    if (!data || data.invalidRange || fetching || error || !org) return;
    setExporting(true);
    try {
      const values = expenseSummaryTemplateValues({
        orgName: org.name,
        periodLabel: `${fmtDate(from)} – ${fmtDate(to)}`,
        periodFrom: fmtDate(from),
        periodTo: fmtDate(to),
        generatedAt: fmtDate(todayISO()),
        metrics: data.metrics,
        bySupplier: data.bySupplier,
      });
      const templated = await renderConfiguredReportTemplate({
        exportKey: 'owner_expense_summary', orgId: org.id, values,
      });
      const fileName = `expenses-${todayISO()}.xlsx`;
      if (templated) {
        downloadRenderedWorkbook(templated, fileName);
        toast(t('expenses.toast'));
        return;
      }
      // Supplier, product-category and invoice-number text is tenant data on its way into a file
      // somebody opens in Excel. `=`/`@` at the start of a cell is a formula there, whatever we
      // meant by it — same neutralizer as documentExport.ts, which is now the one place it lives.
      const wb = XLSX.utils.book_new();
      // The column headers are the workbook's own words, so they are resolved once, here, and
      // used as COMPUTED KEYS. `t('x'): v` is a syntax error rather than a property, and a typed
      // literal cannot carry one at all — the row shape is therefore a plain record, which is
      // also what `json_to_sheet` reads.
      const column = {
        supplier: t('expenses.text'),
        invoiceCount: t('expenses.text_2'),
        total: t('expenses.totalColumn'),
        shareOfTotal: t('expenses.Number'),
        category: t('expenses.text_4'),
        linkedOrderValue: t('expenses.text_5'),
        invoiceNumber: t('expenses.text_7'),
        invoiceDate: t('expenses.text_8'),
        paymentStatus: t('expenses.statusLabel'),
      };
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.bySupplier.map((r) => neutralizeSpreadsheetRow({
        [column.supplier]: r.name,
        [column.invoiceCount]: r.count,
        [column.total]: r.total,
        [column.shareOfTotal]: data.totalAll > 0 ? Number(((r.total / data.totalAll) * 100).toFixed(1)) : null,
      }))), t('expenses.text_3'));
      if (data.categoryBreakdownAvailable) {
        const catRows: Record<string, string | number>[] = [...data.catTotals]
          .sort((a, b) => b.total - a.total)
          .map((c) => neutralizeSpreadsheetRow({
            [column.category]: c.name,
            [column.linkedOrderValue]: c.total,
          }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), t('expenses.book_append_sheet'));
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.invoices.map((i) => neutralizeSpreadsheetRow({
        [column.supplier]: i.supplier?.name ?? '',
        [column.invoiceNumber]: i.invoice_number,
        [column.invoiceDate]: i.invoice_date,
        [column.total]: i.total_amount,
        [column.paymentStatus]: statusLabel(INVOICE_PAYMENT_STATUS[i.payment_status]),
      }))), t('expenses.text_9'));
      XLSX.writeFile(wb, fileName);
      toast(t('expenses.toast_2'));
    } catch (e) {
      toast(reportTemplateErrorText(e, t, errorText), 'error');
    } finally {
      setExporting(false);
    }
  }

  if (loading) return <SkeletonCards count={3} cols={3} title />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <ErrorNote message={t('expenses.message')} />;

  const hasInvoices = data.invoices.length > 0;
  // A computed sum over a selected range IS data — ₪0 total with 0 invoices is an honest
  // statement. Only the average is genuinely unmeasurable at 0/0 → "—" (CLAUDE.md).
  const avg = hasInvoices ? data.totalAll / data.invoices.length : null;

  // A disabled button looks clickable but does nothing; the title says why it is blocked.
  const rangeBlockedReason = fetching ? t('expenses.text_10')
    : error ? t('expenses.text_11')
    : data.invalidRange ? t('expenses.text_12')
    : null;
  const excelBlockedReason = rangeBlockedReason ?? (!hasInvoices ? t('expenses.text_13') : null);

  const categoryRows = [...data.catTotals].sort((a, b) => b.total - a.total);
  const categoryTotal = categoryRows.reduce((sum, row) => sum + row.total, 0);

  const columns: Column<SupplierRow>[] = [
    { key: 'name', header: t('expenses.text_14'), sortValue: (r) => r.name, render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'count', header: t('expenses.fmtNum'), className: 'num', sortValue: (r) => r.count, render: (r) => fmtNum(r.count) },
    { key: 'total', header: t('expenses.fmtMoneyExact'), className: 'num', mobileLabel: null, sortValue: (r) => r.total, render: (r) => <span className="font-semibold">{fmtMoneyExact(r.total)}</span> },
    {
      key: 'pct', header: t('expenses.text_15'), className: 'num', mobileLabel: t('expenses.text_16'), sortValue: (r) => r.total,
      render: (r) => (data.totalAll > 0 ? `${((r.total / data.totalAll) * 100).toFixed(1)}%` : '—'),
    },
  ];

  const drillInvoices = drill ? data.invoices.filter((i) => i.supplier_id === drill.id) : [];
  // Which quick range the current from/to happens to equal — '' once the dates were typed by hand,
  // which is how ToggleGroup renders "no chip pressed" without inventing a sixth option.
  const activePreset: PresetKey | '' = PRESETS.find((preset) => {
    const range = presetRange(preset.key);
    return from === range.from && to === range.to;
  })?.key ?? '';

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <div className="text-xs text-ink-muted" role="status">{t('expenses.text_17')}</div>}
      <PageHeader className="no-print" title={t('expenses.title')} actions={
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={() => void exportExcel()} disabled={exporting || !hasInvoices || fetching || !!error || data.invalidRange} title={excelBlockedReason ?? t('expenses.exportExcel')}>{exporting ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <FileSpreadsheet size={ICON.sm} aria-hidden="true" />} {t('expenses.exportExcelLabel')}</button>
          <button className="btn-secondary" disabled={fetching || !!error || data.invalidRange} onClick={() => window.print()} title={rangeBlockedReason ?? t('expenses.print')}><Printer size={ICON.sm} aria-hidden="true" /> {t('expenses.print_2')}</button>
        </div>
      } />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-line-soft bg-surface px-3 py-3 no-print sm:px-4">
        {/* Was `chip-filter sm:min-h-9` — a deliberate drop to 36px above the sm breakpoint, which
            contradicts "44px on every viewport". ToggleGroup owns the geometry now. */}
        <ToggleGroup<PresetKey | ''>
          label={t('expenses.label')}
          className="gap-1"
          value={activePreset}
          onChange={(key) => { if (!key) return; const range = presetRange(key); setRange(range.from, range.to); }}
          items={PRESETS.map((preset) => ({ key: preset.key, label: t(preset.labelKey) }))} />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-soft">
            {t('expenses.text_18')}
            {/* The range error is a claim about THESE two fields, so it is bound to them rather
                than left to a note floating below the toolbar. */}
            <input type="date" className="input w-auto!" value={from} onChange={(e) => setRange(e.target.value, to)}
              aria-invalid={invalidRange || undefined} aria-describedby={invalidRange ? RANGE_ERROR_ID : undefined} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-soft">
            {t('expenses.text_19')}
            <input type="date" className="input w-auto!" value={to} onChange={(e) => setRange(from, e.target.value)}
              aria-invalid={invalidRange || undefined} aria-describedby={invalidRange ? RANGE_ERROR_ID : undefined} />
          </label>
        </div>
      </div>

      {data.invalidRange && <div id={RANGE_ERROR_ID}><Note tone="alert" role="alert">{t('expenses.text_20')}</Note></div>}

      {!data.invalidRange && <div className="print-area space-y-4">
        <div className="hidden print:block">
          <h2 className="text-xl font-semibold">{t('expenses.heading', { from: fmtDate(from), to: fmtDate(to) })}</h2>
        </div>

        <div className="grid grid-cols-1 border-y border-line-strong bg-surface sm:grid-cols-3">
          <StripStat title={t('expenses.title_2')} icon={Banknote}
            value={fmtMoneyRounded(data.totalAll)} context={`${fmtDate(from)} – ${fmtDate(to)}`} />
          <StripStat title={t('expenses.title_3')} icon={ReceiptText}
            value={fmtNum(data.invoices.length)} context={t('expenses.context')} />
          <StripStat title={t('expenses.title_4')} icon={Calculator}
            value={avg == null ? '—' : fmtMoneyRounded(avg)}
            context={avg == null ? t('expenses.text_21') : t('expenses.text_22')} />
        </div>

        {!hasInvoices ? (
          <div className="border-y border-line-soft bg-surface">
            <EmptyState title={t('expenses.title_5')}
              subtitle={t('expenses.subtitle')} />
          </div>
        ) : (
          <>
            <section className="space-y-2">
              <h2 className="section-title">{t('expenses.text_23')}</h2>
              <div className="divide-y divide-line-soft border-y border-line-strong bg-surface lg:hidden">
                {data.bySupplier.map((supplier) => (
                  <button key={supplier.id} type="button" onClick={() => setDrill(supplier)}
                    className="flex min-h-16 w-full items-center gap-3 px-3 py-2.5 text-start hover:bg-surface-hover active:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-ink-body">{supplier.name}</span>
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        <span className="num">{fmtNum(supplier.count)}</span> {t('expenses.invoicesWord')}
                        {data.totalAll > 0 && <> · <span className="num">{((supplier.total / data.totalAll) * 100).toFixed(1)}%</span> {t('expenses.toFixed')}</>}
                      </span>
                    </span>
                    <strong className="num shrink-0 text-sm text-ink-body">{fmtMoneyExact(supplier.total)}</strong>
                    <ChevronLeft size={ICON.sm} className="shrink-0 text-ink-ghost" aria-hidden="true" />
                  </button>
                ))}
              </div>
              <div className="hidden lg:block">
                <DataTable rows={data.bySupplier} columns={columns} mobile="scroll"
                  rowLabel={(r) => t('expenses.rowLabel', { supplier: r.name })}
                  onRowClick={(r) => setDrill(r)} emptyTitle={t('expenses.emptyTitle')} />
              </div>
            </section>

            {data.categoryBreakdownAvailable ? (
              <details className="border-y border-line-strong bg-surface">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 sm:px-4">
                  <span>
                    <span className="block font-semibold text-ink-body">{t('expenses.text_24')}</span>
                    <span className="mt-0.5 block text-xs text-ink-muted">{t('expenses.text_25')}</span>
                  </span>
                  <span className="shrink-0 text-xs text-ink-muted">{t('expenses.text_26')}</span>
                </summary>
                <div className="border-t border-line-soft">
                  <div className="px-3 py-2 text-xs text-ink-muted sm:px-4">
                    {t('expenses.linkedInvoicesLead')}{' '}
                    <span className="num">{fmtMoneyRounded(data.coveredTotal)}</span>{' '}
                    {t('expenses.linkedInvoicesOf')}{' '}
                    <span className="num">{fmtMoneyRounded(data.totalAll)}</span>
                    {t('expenses.linkedInvoicesTail')}
                  </div>
                  {categoryRows.length > 0 ? (
                    <ul className="divide-y divide-line-soft border-t border-line-soft text-sm">
                      {categoryRows.map((row) => (
                        <li key={row.name} className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2 sm:px-4">
                          <span className="min-w-0 break-words text-ink-body">{row.name}</span>
                          <span className="num text-ink-muted">{categoryTotal > 0 ? `${((row.total / categoryTotal) * 100).toFixed(1)}%` : '—'}</span>
                          <span className="num min-w-24 font-medium text-ink-body">{fmtMoneyExact(row.total)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="border-t border-line-soft px-3 py-6 text-center text-sm text-ink-muted sm:px-4">
                      {t('expenses.text_27')}
                    </div>
                  )}
                </div>
              </details>
            ) : (
              <Note tone="idle">
                {t('expenses.text_28')}
              </Note>
            )}
          </>
        )}
      </div>}

      <Modal open={!!drill} onClose={() => setDrill(null)} title={drill ? t('expenses.drillTitle', { supplier: drill.name }) : ''}>
        {drill && (
          <ul className="divide-y divide-line-soft">
            {drillInvoices.map((inv) => (
              <li key={inv.id}>
                <Link to={`/invoices/${inv.id}`}
                  className="flex min-h-11 items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover active:bg-surface-selected transition-colors">
                  <span className="num text-sm font-medium" dir="ltr">{inv.invoice_number}</span>
                  <span className="text-xs text-ink-muted">{fmtDate(inv.invoice_date)}</span>
                  <span className="ms-auto flex shrink-0 items-center gap-3">
                    <StatusBadge meta={INVOICE_PAYMENT_STATUS[inv.payment_status]} />
                    <span className="num text-sm font-semibold">{fmtMoneyExact(inv.total_amount)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}

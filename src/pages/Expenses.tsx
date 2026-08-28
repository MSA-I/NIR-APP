import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Banknote, Calculator, ChevronLeft, FileSpreadsheet, Loader2, Printer, ReceiptText, type LucideIcon } from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useParamState } from '../lib/useParamState';
import { DataTable, EmptyState, ErrorNote, ICON, Modal, Note, PageHeader, SkeletonCards, StatusBadge, ToggleGroup, useToast, type Column } from '../components/ui';
import { INVOICE_PAYMENT_STATUS } from '../lib/status';
import { toHebrewError } from '../lib/errors';
import {
  addCalendarDays, daysInCalendarMonth, fmtDate, fmtMoneyExact, fmtNum,
  shiftCalendarMonth, todayISO,
} from '../lib/format';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { MoneyByCurrency, sortByBaseCurrency, totalsByCurrency } from '../components/Money';
import type { MoneyAmount } from '../lib/types';
import { useAuth } from '../auth/AuthContext';
import { financialSupplierMap } from '../lib/financialSuppliers';
import { neutralizeSpreadsheetRow } from '../lib/documentExport';
import {
  downloadRenderedWorkbook,
  expenseSummaryTemplateValues,
  renderConfiguredReportTemplate,
  singleCurrencyTotal,
  type PurchaseMetrics,
} from '../lib/reportTemplateExport';

type InvoiceRow = {
  id: string; invoice_number: string; invoice_date: string; total_amount: number;
  /** The currency the invoice was issued in (0217). Never converted, on this screen or any other. */
  currency: string;
  payment_status: string; supplier_id: string; supplier: { name: string } | null;
};
type RawInvoiceRow = Omit<InvoiceRow, 'supplier'>;
type RawOrderItem = {
  qty: number;
  unit_price: number;
  product: { category_id: string | null } | { category_id: string | null }[] | null;
  // The line's money is the ORDER's money: `unit_price` is the snapshot taken in the order's
  // currency, so a category value can only be added up inside that currency.
  order: { currency: string } | { currency: string }[] | null;
};
/**
 * One row per supplier AND currency — a supplier billing in two currencies has two rows (#277).
 * `id` is the row's identity, not the supplier's, because `DataTable` keys on it and one key per
 * supplier is exactly where the second currency would collide with the first.
 */
type SupplierRow = { id: string; supplierId: string; name: string; currency: string; count: number; total: number };
type CategoryRow = { name: string; currency: string; total: number };

/** The one id the two date inputs point at when the range is refused. */
const RANGE_ERROR_ID = 'expenses-range-error';

type PresetKey = 'month' | 'prevMonth' | 'quarter' | 'year';
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'month', label: 'החודש' },
  { key: 'prevMonth', label: 'חודש קודם' },
  { key: 'quarter', label: '3 חודשים' },
  { key: 'year', label: 'שנה' },
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
  // `ReactNode`, because a money figure on this strip may be two lines — one per currency — and
  // a string could only have joined them into something that reads like one number.
  title: string; value: ReactNode; context?: string; icon: LucideIcon;
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
  const baseCurrency = org?.base_currency ?? null;
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
      invoices: [], bySupplier: [], catTotals: [] as CategoryRow[],
      totals: [] as MoneyAmount[], coveredTotals: [] as MoneyAmount[], averages: [] as MoneyAmount[],
      invalidRange: true, categoryBreakdownAvailable,
      metrics: {
        committed_by_currency: null, gross_expense_by_currency: null,
        credits_recognised_by_currency: null, net_expense_by_currency: null,
      } as PurchaseMetrics,
    };
    const end = addCalendarDays(to, 1);
    const [rawInvoices, categories, metrics] = await Promise.all([
      fetchAll<RawInvoiceRow>((fromRow, toRow) => supabase.from('invoices')
        .select('id, invoice_number, invoice_date, total_amount, currency, payment_status, supplier_id')
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
    let items: { qty: number; unit_price: number; product: { category_id: string | null } | null; currency: string }[] = [];
    if (categoryBreakdownAvailable && invoices.length) {
      links = await fetchInChunks(invoices.map((i) => i.id), (chunk) =>
        fetchAll<{ invoice_id: string; order_id: string }>((fromRow, toRow) => supabase.from('invoice_order_links')
          .select('invoice_id, order_id').in('invoice_id', chunk)
          .order('invoice_id').order('order_id').range(fromRow, toRow)));
      const orderIds = [...new Set(links.map((l) => l.order_id))];
      if (orderIds.length) {
        const rawItems = await fetchInChunks(orderIds, (chunk) =>
          fetchAll<RawOrderItem>((fromRow, toRow) => supabase.from('purchase_order_items')
            .select('qty, unit_price, product:products(category_id), order:purchase_orders!inner(currency)')
            .in('order_id', chunk).order('order_id').order('id').range(fromRow, toRow)));
        items = rawItems.map((item) => ({
          ...item,
          product: Array.isArray(item.product) ? item.product[0] ?? null : item.product,
          currency: (Array.isArray(item.order) ? item.order[0] : item.order)?.currency ?? '',
        }));
      }
    }

    // Coverage is expressed separately from the category rows. Category values come from order
    // snapshots, not invoice lines, so the UI never presents them as an exact invoice breakdown.
    /* EVERY TOTAL ON THIS SCREEN IS A TOTAL WITHIN ONE CURRENCY (0217, #277). A period holding
       ₪12,400 of shekel invoices and $3,100 of dollar ones has two totals, not one — and the
       average, the coverage figure and each supplier's share are all derived from a total, so
       every one of them is computed inside its own currency and labelled with it. Nothing here
       is converted, and nothing spanning two currencies is added.

       Coverage is still expressed separately from the category rows: category values come from
       order snapshots, not invoice lines, so the screen never presents them as an exact invoice
       breakdown. */
    const linkedIds = new Set(links.map((l) => l.invoice_id));
    const totals = totalsByCurrency(invoices.map((i) => ({ currency: i.currency, amount: i.total_amount })));
    const coveredTotals = totalsByCurrency(invoices
      .filter((i) => linkedIds.has(i.id))
      .map((i) => ({ currency: i.currency, amount: i.total_amount })));
    const countByCurrency = new Map<string, number>();
    for (const invoice of invoices) countByCurrency.set(invoice.currency, (countByCurrency.get(invoice.currency) ?? 0) + 1);
    const averages = totals.map((total) => ({
      currency: total.currency,
      amount: total.amount / (countByCurrency.get(total.currency) ?? 1),
    }));

    // Keyed by category AND currency: one key per name is where a dollar order's value used to be
    // added onto a shekel one and shown as a single figure under the category's name.
    const byCat = new Map<string, CategoryRow>();
    for (const it of items) {
      const name = (it.product?.category_id && categoryNames.get(it.product.category_id)) || 'ללא קטגוריה';
      const row = byCat.get(`${name}|${it.currency}`) ?? { name, currency: it.currency, total: 0 };
      row.total += it.qty * it.unit_price;
      byCat.set(`${name}|${it.currency}`, row);
    }
    const catTotals = [...byCat.values()].filter((c) => c.total > 0);

    const bySupMap = new Map<string, SupplierRow>();
    for (const inv of invoices) {
      const key = `${inv.supplier_id}|${inv.currency}`;
      const row = bySupMap.get(key)
        ?? { id: key, supplierId: inv.supplier_id, name: inv.supplier?.name ?? '—', currency: inv.currency, count: 0, total: 0 };
      row.count += 1;
      row.total += inv.total_amount;
      bySupMap.set(key, row);
    }
    // Ordered by amount INSIDE each currency, the organisation's own currency first: 3,100 of one
    // currency is not "less than" 12,400 of another, so a single descending sort over the column
    // would be ranking numbers that have no order between them.
    const bySupplier = sortByBaseCurrency([...bySupMap.values()], baseCurrency)
      .sort((a, b) => (a.currency === b.currency ? b.total - a.total : 0));

    return {
      invoices, bySupplier, catTotals, totals, coveredTotals, averages,
      invalidRange: false, categoryBreakdownAvailable, metrics,
    };
  }, [from, to, invalidRange, categoryBreakdownAvailable, baseCurrency]);

  async function exportExcel() {
    if (!data || data.invalidRange || fetching || error || !org) return;
    setExporting(true);
    try {
      const exportCurrency = singleCurrencyTotal(data.metrics.gross_expense_by_currency).currency;
      const values = expenseSummaryTemplateValues({
        orgName: org.name,
        periodLabel: `${fmtDate(from)} – ${fmtDate(to)}`,
        periodFrom: fmtDate(from),
        periodTo: fmtDate(to),
        generatedAt: fmtDate(todayISO()),
        metrics: data.metrics,
        // The template fills its numeric cells only in a single-currency period, and this list has
        // to be the same currency those cells are in — otherwise "top supplier" would name a
        // supplier whose figure is in a different unit from the total above it.
        bySupplier: exportCurrency ? data.bySupplier.filter((row) => row.currency === exportCurrency) : [],
      });
      const templated = await renderConfiguredReportTemplate({
        exportKey: 'owner_expense_summary', orgId: org.id, values,
      });
      const fileName = `expenses-${todayISO()}.xlsx`;
      if (templated) {
        downloadRenderedWorkbook(templated, fileName);
        toast('קובץ ה-Excel הורד');
        return;
      }
      // Supplier, product-category and invoice-number text is tenant data on its way into a file
      // somebody opens in Excel. `=`/`@` at the start of a cell is a formula there, whatever we
      // meant by it — same neutralizer as documentExport.ts, which is now the one place it lives.
      const wb = XLSX.utils.book_new();
      // A currency column on every money sheet, so a row is never read in the wrong unit — the
      // same rule the accountant's workbook follows (#287).
      const sheetTotalFor = (currency: string) => data.totals.find((t) => t.currency === currency)?.amount ?? 0;
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.bySupplier.map((r) => neutralizeSpreadsheetRow({
        'ספק': r.name, 'מטבע': r.currency, 'חשבוניות': r.count, 'סה"כ': r.total,
        '% מהסך': sheetTotalFor(r.currency) > 0 ? Number(((r.total / sheetTotalFor(r.currency)) * 100).toFixed(1)) : null,
      }))), 'לפי ספק');
      if (data.categoryBreakdownAvailable) {
        const catRows: { 'קטגוריה': string; 'מטבע': string; 'ערך בהזמנות מקושרות': number }[] = sortByBaseCurrency(data.catTotals, baseCurrency)
          .sort((a, b) => (a.currency === b.currency ? b.total - a.total : 0))
          .map((c) => neutralizeSpreadsheetRow({ 'קטגוריה': c.name, 'מטבע': c.currency, 'ערך בהזמנות מקושרות': c.total }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), 'קטגוריות בהזמנות');
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.invoices.map((i) => neutralizeSpreadsheetRow({
        'ספק': i.supplier?.name ?? '', 'מספר חשבונית': i.invoice_number, 'תאריך': i.invoice_date,
        'מטבע': i.currency, 'סה"כ': i.total_amount, 'סטטוס תשלום': INVOICE_PAYMENT_STATUS[i.payment_status]?.label,
      }))), 'חשבוניות');
      XLSX.writeFile(wb, fileName);
      toast('קובץ ה-Excel הורד');
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setExporting(false);
    }
  }

  if (loading) return <SkeletonCards count={3} cols={3} title />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <ErrorNote message="שגיאה" />;

  const hasInvoices = data.invoices.length > 0;
  /** The period's total in one named currency — the denominator of every share on this screen. */
  const totalFor = (currency: string) => data.totals.find((total) => total.currency === currency)?.amount ?? 0;

  // A disabled button looks clickable but does nothing; the title says why it is blocked.
  const rangeBlockedReason = fetching ? 'הנתונים נטענים…'
    : error ? 'שגיאה בטעינת הנתונים'
    : data.invalidRange ? 'טווח התאריכים שגוי — מ־ אחרי עד'
    : null;
  const excelBlockedReason = rangeBlockedReason ?? (!hasInvoices ? 'אין חשבוניות בטווח שנבחר' : null);

  const categoryRows = sortByBaseCurrency(data.catTotals, baseCurrency)
    .sort((a, b) => (a.currency === b.currency ? b.total - a.total : 0));
  const categoryTotalFor = (currency: string) => categoryRows
    .filter((row) => row.currency === currency)
    .reduce((sum, row) => sum + row.total, 0);

  const columns: Column<SupplierRow>[] = [
    { key: 'name', header: 'ספק', sortValue: (r) => r.name, render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'count', header: 'חשבוניות', className: 'num', sortValue: (r) => r.count, render: (r) => fmtNum(r.count) },
    { key: 'total', header: 'סה״כ', className: 'num', mobileLabel: null, sortValue: (r) => r.total, render: (r) => <span className="font-semibold">{fmtMoneyExact(r.total, r.currency)}</span> },
    {
      key: 'pct', header: '% מהסך', className: 'num', mobileLabel: '% מהסך', sortValue: (r) => r.total,
      // A share of the total IN THIS ROW'S CURRENCY. Dividing a dollar figure by a shekel total
      // returns a percentage of nothing.
      render: (r) => (totalFor(r.currency) > 0 ? `${((r.total / totalFor(r.currency)) * 100).toFixed(1)}%` : '—'),
    },
  ];

  // The drill-down belongs to ONE of the supplier's currencies — the row that was clicked.
  const drillInvoices = drill
    ? data.invoices.filter((i) => i.supplier_id === drill.supplierId && i.currency === drill.currency)
    : [];
  // Which quick range the current from/to happens to equal — '' once the dates were typed by hand,
  // which is how ToggleGroup renders "no chip pressed" without inventing a sixth option.
  const activePreset: PresetKey | '' = PRESETS.find((preset) => {
    const range = presetRange(preset.key);
    return from === range.from && to === range.to;
  })?.key ?? '';

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <div className="text-xs text-ink-muted" role="status">מתעדכן…</div>}
      <PageHeader className="no-print" title="ריכוז הוצאות" actions={
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={() => void exportExcel()} disabled={exporting || !hasInvoices || fetching || !!error || data.invalidRange} title={excelBlockedReason ?? 'הורדת הריכוז כקובץ Excel'}>{exporting ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <FileSpreadsheet size={ICON.sm} aria-hidden="true" />} ייצוא Excel</button>
          <button className="btn-secondary" disabled={fetching || !!error || data.invalidRange} onClick={() => window.print()} title={rangeBlockedReason ?? 'הדפסת הריכוז או שמירה כ-PDF'}><Printer size={ICON.sm} aria-hidden="true" /> הדפסה / PDF</button>
        </div>
      } />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-line-soft bg-surface px-3 py-3 no-print sm:px-4">
        {/* Was `chip-filter sm:min-h-9` — a deliberate drop to 36px above the sm breakpoint, which
            contradicts "44px on every viewport". ToggleGroup owns the geometry now. */}
        <ToggleGroup<PresetKey | ''>
          label="טווחי תאריכים מהירים"
          className="gap-1"
          value={activePreset}
          onChange={(key) => { if (!key) return; const range = presetRange(key); setRange(range.from, range.to); }}
          items={PRESETS.map((preset) => ({ key: preset.key, label: preset.label }))} />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-soft">
            מ־
            {/* The range error is a claim about THESE two fields, so it is bound to them rather
                than left to a note floating below the toolbar. */}
            <input type="date" className="input w-auto!" value={from} onChange={(e) => setRange(e.target.value, to)}
              aria-invalid={invalidRange || undefined} aria-describedby={invalidRange ? RANGE_ERROR_ID : undefined} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-soft">
            עד
            <input type="date" className="input w-auto!" value={to} onChange={(e) => setRange(from, e.target.value)}
              aria-invalid={invalidRange || undefined} aria-describedby={invalidRange ? RANGE_ERROR_ID : undefined} />
          </label>
        </div>
      </div>

      {data.invalidRange && <div id={RANGE_ERROR_ID}><Note tone="alert" role="alert">תאריך ההתחלה חייב להיות מוקדם מתאריך הסיום או זהה לו.</Note></div>}

      {!data.invalidRange && <div className="print-area space-y-4">
        <div className="hidden print:block">
          <h2 className="text-xl font-semibold">ריכוז הוצאות {fmtDate(from)} – {fmtDate(to)}</h2>
        </div>

        <div className="grid grid-cols-1 border-y border-line-strong bg-surface sm:grid-cols-3">
          <StripStat title="סה״כ הוצאות בטווח" icon={Banknote}
            value={<MoneyByCurrency amounts={data.totals} baseCurrency={baseCurrency} shape="rounded" />}
            context={`${fmtDate(from)} – ${fmtDate(to)}`} />
          <StripStat title="מספר חשבוניות" icon={ReceiptText}
            value={fmtNum(data.invoices.length)} context="חשבוניות שאינן מחוקות בטווח" />
          {/* An average per currency: the sum of that currency's invoices over the number of
              them. 0/0 stays "—" — an average of nothing is unmeasurable, not zero (CLAUDE.md). */}
          <StripStat title="ממוצע לחשבונית" icon={Calculator}
            value={<MoneyByCurrency amounts={data.averages} baseCurrency={baseCurrency} shape="rounded" />}
            context={hasInvoices ? 'סה״כ חלקי מספר החשבוניות, בכל מטבע בנפרד' : 'אין חשבוניות בטווח'} />
        </div>

        {!hasInvoices ? (
          <div className="border-y border-line-soft bg-surface">
            <EmptyState title="אין חשבוניות בטווח שנבחר"
              subtitle="שנו את טווח התאריכים או בחרו אחד מהטווחים המהירים" />
          </div>
        ) : (
          <>
            <section className="space-y-2">
              <h2 className="section-title">הוצאות לפי ספק</h2>
              <div className="divide-y divide-line-soft border-y border-line-strong bg-surface lg:hidden">
                {data.bySupplier.map((supplier) => (
                  <button key={supplier.id} type="button" onClick={() => setDrill(supplier)}
                    className="flex min-h-16 w-full items-center gap-3 px-3 py-2.5 text-start hover:bg-surface-hover active:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-ink-body">{supplier.name}</span>
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        <span className="num">{fmtNum(supplier.count)}</span> חשבוניות
                        {totalFor(supplier.currency) > 0 && <> · <span className="num">{((supplier.total / totalFor(supplier.currency)) * 100).toFixed(1)}%</span> מהסך ב-{supplier.currency}</>}
                      </span>
                    </span>
                    <strong className="num shrink-0 text-sm text-ink-body">{fmtMoneyExact(supplier.total, supplier.currency)}</strong>
                    <ChevronLeft size={ICON.sm} className="shrink-0 text-ink-ghost" aria-hidden="true" />
                  </button>
                ))}
              </div>
              <div className="hidden lg:block">
                <DataTable rows={data.bySupplier} columns={columns} mobile="scroll"
                  rowLabel={(r) => `הוצאות עבור ${r.name} ב-${r.currency}`}
                  onRowClick={(r) => setDrill(r)} emptyTitle="אין חשבוניות בטווח" />
              </div>
            </section>

            {data.categoryBreakdownAvailable ? (
              <details className="border-y border-line-strong bg-surface">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 sm:px-4">
                  <span>
                    <span className="block font-semibold text-ink-body">פירוט מוצרים לפי קטגוריה</span>
                    <span className="mt-0.5 block text-xs text-ink-muted">מידע משלים מהזמנות מקושרות; אינו מחליף את סכומי החשבוניות בטבלת הספקים.</span>
                  </span>
                  <span className="shrink-0 text-xs text-ink-muted">הצג פירוט</span>
                </summary>
                <div className="border-t border-line-soft">
                  <div className="px-3 py-2 text-xs text-ink-muted sm:px-4">
                    חשבוניות מקושרות בסך{' '}
                    <MoneyByCurrency amounts={data.coveredTotals} baseCurrency={baseCurrency} shape="rounded" /> מתוך{' '}
                    <MoneyByCurrency amounts={data.totals} baseCurrency={baseCurrency} shape="rounded" />. הסכומים למטה הם ערכי פריטי ההזמנה במחירי snapshot.
                  </div>
                  {categoryRows.length > 0 ? (
                    <ul className="divide-y divide-line-soft border-t border-line-soft text-sm">
                      {categoryRows.map((row) => (
                        <li key={`${row.name}|${row.currency}`} className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2 sm:px-4">
                          <span className="min-w-0 break-words text-ink-body">{row.name}</span>
                          <span className="num text-ink-muted">{categoryTotalFor(row.currency) > 0 ? `${((row.total / categoryTotalFor(row.currency)) * 100).toFixed(1)}%` : '—'}</span>
                          <span className="num min-w-24 font-medium text-ink-body">{fmtMoneyExact(row.total, row.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="border-t border-line-soft px-3 py-6 text-center text-sm text-ink-muted sm:px-4">
                      אין בטווח חשבוניות עם הזמנה מקושרת ופריטי קטגוריה.
                    </div>
                  )}
                </div>
              </details>
            ) : (
              <Note tone="idle">
                פילוח מוצרים וקטגוריות אינו חלק מההקשר החשבונאי המצומצם. סכומי הספקים והחשבוניות למעלה נשארים המקור המדויק, והייצוא אינו מוסיף פילוח שאינו זמין.
              </Note>
            )}
          </>
        )}
      </div>}

      <Modal open={!!drill} onClose={() => setDrill(null)} title={drill ? `חשבוניות בטווח — ${drill.name} (${drill.currency})` : ''}>
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
                    <span className="num text-sm font-semibold">{fmtMoneyExact(inv.total_amount, inv.currency)}</span>
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

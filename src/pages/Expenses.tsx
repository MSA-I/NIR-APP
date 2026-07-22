import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Banknote, Calculator, ChevronLeft, FileSpreadsheet, Printer, ReceiptText, type LucideIcon } from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useParamState } from '../lib/useParamState';
import { DataTable, EmptyState, ErrorNote, Modal, Note, SkeletonCards, StatusBadge, type Column } from '../components/ui';
import { INVOICE_PAYMENT_STATUS } from '../lib/status';
import {
  addCalendarDays, daysInCalendarMonth, fmtDate, fmtMoney, fmtMoneyExact, fmtNum,
  shiftCalendarMonth, todayISO,
} from '../lib/format';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';

type InvoiceRow = {
  id: string; invoice_number: string; invoice_date: string; total_amount: number;
  payment_status: string; supplier_id: string; supplier: { name: string } | null;
};
type RawInvoiceRow = Omit<InvoiceRow, 'supplier'> & {
  supplier: { name: string } | { name: string }[] | null;
};
type RawOrderItem = {
  qty: number;
  unit_price: number;
  product: { category_id: string | null } | { category_id: string | null }[] | null;
};
type SupplierRow = { id: string; name: string; count: number; total: number };

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
  title: string; value: string; context?: string; icon: LucideIcon;
}) {
  return (
    <div className="min-h-20 border-t border-line-soft px-4 py-3 first:border-t-0 sm:border-s sm:border-t-0 sm:px-5 sm:first:border-s-0">
      <div className="flex items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center border border-line-soft bg-surface-sunken text-idle-fg" aria-hidden="true">
          <Icon size={16} />
        </span>
        <span className="text-xs font-medium text-ink-muted">{title}</span>
      </div>
      <div className="mt-1.5 text-xl font-semibold num text-ink sm:text-2xl" dir="ltr">{value}</div>
      {context && <div className="mt-1 text-xs text-ink-muted">{context}</div>}
    </div>
  );
}

export default function Expenses() {
  const defaults = presetRange('month');
  // useParamState seeds from the URL and re-syncs when it changes; the URL is also WRITTEN
  // (replace, no history spam) so the chosen range is genuinely shareable/bookmarkable.
  const [from] = useParamState('from', defaults.from);
  const [to] = useParamState('to', defaults.to);
  const [params, setParams] = useSearchParams();
  const [drill, setDrill] = useState<SupplierRow | null>(null);
  const invalidRange = !!from && !!to && from > to;

  function setRange(nextFrom: string, nextTo: string) {
    if (!nextFrom || !nextTo) return; // a cleared date input is not a range claim
    const next = new URLSearchParams(params);
    next.set('from', nextFrom);
    next.set('to', nextTo);
    setParams(next, { replace: true });
  }

  const { data, loading, fetching, error } = useQuery(async () => {
    if (invalidRange) return { invoices: [], bySupplier: [], catTotals: [], totalAll: 0, coveredTotal: 0, invalidRange: true };
    const end = addCalendarDays(to, 1);
    const [rawInvoices, categories] = await Promise.all([
      fetchAll<RawInvoiceRow>((fromRow, toRow) => supabase.from('invoices')
        .select('id, invoice_number, invoice_date, total_amount, payment_status, supplier_id, supplier:suppliers(name)')
        .gte('invoice_date', from).lt('invoice_date', end)
        .is('deleted_at', null)
        .order('invoice_date', { ascending: false }).order('id').range(fromRow, toRow)),
      fetchAll<{ id: string; name: string }>((fromRow, toRow) => supabase.from('categories')
        .select('id, name').order('name').order('id').range(fromRow, toRow)),
    ]);
    const invoices: InvoiceRow[] = rawInvoices.map((invoice) => ({
      ...invoice,
      supplier: Array.isArray(invoice.supplier) ? invoice.supplier[0] ?? null : invoice.supplier,
    }));
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

    // Category split can only be derived from purchase orders (invoices carry no line items):
    // in-range invoices → invoice_order_links → purchase_order_items at snapshot prices.
    let links: { invoice_id: string; order_id: string }[] = [];
    let items: { qty: number; unit_price: number; product: { category_id: string | null } | null }[] = [];
    if (invoices.length) {
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
      const name = (it.product?.category_id && categoryNames.get(it.product.category_id)) || 'ללא קטגוריה';
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

    return { invoices, bySupplier, catTotals, totalAll, coveredTotal, invalidRange: false };
  }, [from, to, invalidRange]);

  function exportExcel() {
    if (!data || data.invalidRange || fetching || error) return;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.bySupplier.map((r) => ({
      'ספק': r.name, 'חשבוניות': r.count, 'סה"כ': r.total,
      '% מהסך': data.totalAll > 0 ? Number(((r.total / data.totalAll) * 100).toFixed(1)) : null,
    }))), 'לפי ספק');
    const catRows: { 'קטגוריה': string; 'ערך בהזמנות מקושרות': number }[] = [...data.catTotals]
      .sort((a, b) => b.total - a.total)
      .map((c) => ({ 'קטגוריה': c.name, 'ערך בהזמנות מקושרות': c.total }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), 'קטגוריות בהזמנות');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.invoices.map((i) => ({
      'ספק': i.supplier?.name ?? '', 'מספר חשבונית': i.invoice_number, 'תאריך': i.invoice_date,
      'סה"כ': i.total_amount, 'סטטוס תשלום': INVOICE_PAYMENT_STATUS[i.payment_status]?.label,
    }))), 'חשבוניות');
    XLSX.writeFile(wb, `expenses-${todayISO()}.xlsx`);
  }

  if (loading) return <SkeletonCards count={3} cols={3} title />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <ErrorNote message="שגיאה" />;

  const hasInvoices = data.invoices.length > 0;
  // A computed sum over a selected range IS data — ₪0 total with 0 invoices is an honest
  // statement. Only the average is genuinely unmeasurable at 0/0 → "—" (CLAUDE.md).
  const avg = hasInvoices ? data.totalAll / data.invoices.length : null;

  const categoryRows = [...data.catTotals].sort((a, b) => b.total - a.total);
  const categoryTotal = categoryRows.reduce((sum, row) => sum + row.total, 0);

  const columns: Column<SupplierRow>[] = [
    { key: 'name', header: 'ספק', sortValue: (r) => r.name, render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'count', header: 'חשבוניות', className: 'num', sortValue: (r) => r.count, render: (r) => fmtNum(r.count) },
    { key: 'total', header: 'סה״כ', className: 'num', mobileLabel: null, sortValue: (r) => r.total, render: (r) => <span className="font-semibold">{fmtMoneyExact(r.total)}</span> },
    {
      key: 'pct', header: '% מהסך', className: 'num', mobileLabel: '% מהסך', sortValue: (r) => r.total,
      render: (r) => (data.totalAll > 0 ? `${((r.total / data.totalAll) * 100).toFixed(1)}%` : '—'),
    },
  ];

  const drillInvoices = drill ? data.invoices.filter((i) => i.supplier_id === drill.id) : [];

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <div className="text-xs text-ink-muted" role="status">מתעדכן…</div>}
      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <h1 className="page-title">ריכוז הוצאות</h1>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={exportExcel} disabled={!hasInvoices || fetching || !!error || data.invalidRange}><FileSpreadsheet size={15} /> ייצוא Excel</button>
          <button className="btn-secondary" disabled={fetching || !!error || data.invalidRange} onClick={() => window.print()}><Printer size={15} /> הדפסה / PDF</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-line-soft bg-surface px-3 py-3 no-print sm:px-4">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="טווחי תאריכים מהירים">
          {PRESETS.map((p) => {
            const r = presetRange(p.key);
            const active = from === r.from && to === r.to;
            return (
              <button key={p.key} className={`min-h-11 border px-3 text-sm font-medium transition-colors sm:min-h-9 ${active ? 'border-action bg-action-solid text-white' : 'border-line-soft bg-surface text-ink-soft hover:bg-surface-sunken'}`}
                aria-pressed={active} onClick={() => setRange(r.from, r.to)}>
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-soft">
            מ־
            <input type="date" className="input w-auto!" value={from} onChange={(e) => setRange(e.target.value, to)} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-soft">
            עד
            <input type="date" className="input w-auto!" value={to} onChange={(e) => setRange(from, e.target.value)} />
          </label>
        </div>
      </div>

      {data.invalidRange && <Note tone="alert">תאריך ההתחלה חייב להיות מוקדם מתאריך הסיום או זהה לו.</Note>}

      {!data.invalidRange && <div className="print-area space-y-4">
        <div className="hidden print:block">
          <h2 className="text-xl font-bold">ריכוז הוצאות {fmtDate(from)} – {fmtDate(to)}</h2>
        </div>

        <div className="grid grid-cols-1 border-y border-line-strong bg-surface sm:grid-cols-3">
          <StripStat title="סה״כ הוצאות בטווח" icon={Banknote}
            value={fmtMoney(Math.round(data.totalAll))} context={`${fmtDate(from)} – ${fmtDate(to)}`} />
          <StripStat title="מספר חשבוניות" icon={ReceiptText}
            value={fmtNum(data.invoices.length)} context="חשבוניות שאינן מחוקות בטווח" />
          <StripStat title="ממוצע לחשבונית" icon={Calculator}
            value={avg == null ? '—' : fmtMoney(Math.round(avg))}
            context={avg == null ? 'אין חשבוניות בטווח' : 'סה״כ חלקי מספר החשבוניות'} />
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
              <div className="divide-y divide-line-soft border-y border-line-strong bg-surface md:hidden">
                {data.bySupplier.map((supplier) => (
                  <button key={supplier.id} type="button" onClick={() => setDrill(supplier)}
                    className="flex min-h-16 w-full items-center gap-3 px-3 py-2.5 text-start hover:bg-surface-sunken active:bg-action-wash/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-ink-body">{supplier.name}</span>
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        <span className="num">{fmtNum(supplier.count)}</span> חשבוניות
                        {data.totalAll > 0 && <> · <span className="num">{((supplier.total / data.totalAll) * 100).toFixed(1)}%</span> מהסך</>}
                      </span>
                    </span>
                    <strong className="num shrink-0 text-sm text-ink-body">{fmtMoneyExact(supplier.total)}</strong>
                    <ChevronLeft size={16} className="shrink-0 text-ink-ghost" aria-hidden="true" />
                  </button>
                ))}
              </div>
              <div className="hidden md:block">
                <DataTable rows={data.bySupplier} columns={columns} mobile="scroll"
                  onRowClick={(r) => setDrill(r)} emptyTitle="אין חשבוניות בטווח" />
              </div>
            </section>

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
                  חשבוניות מקושרות בסך <span className="num">{fmtMoney(Math.round(data.coveredTotal))}</span> מתוך{' '}
                  <span className="num">{fmtMoney(Math.round(data.totalAll))}</span>. הסכומים למטה הם ערכי פריטי ההזמנה במחירי snapshot.
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
                    אין בטווח חשבוניות עם הזמנה מקושרת ופריטי קטגוריה.
                  </div>
                )}
              </div>
            </details>
          </>
        )}
      </div>}

      <Modal open={!!drill} onClose={() => setDrill(null)} title={drill ? `חשבוניות בטווח — ${drill.name}` : ''}>
        {drill && (
          <ul className="divide-y divide-line-soft">
            {drillInvoices.map((inv) => (
              <li key={inv.id}>
                <Link to={`/invoices/${inv.id}`}
                  className="flex min-h-11 items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-sunken active:bg-action-wash/70 transition-colors">
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

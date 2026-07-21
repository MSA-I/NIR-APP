import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Banknote, Calculator, FileSpreadsheet, Printer, ReceiptText, type LucideIcon } from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useParamState } from '../lib/useParamState';
import { DataTable, EmptyState, ErrorNote, Modal, SkeletonCards, StatusBadge, type Column } from '../components/ui';
import { INVOICE_PAYMENT_STATUS } from '../lib/status';
import { fmtDate, fmtMoney, fmtMoneyExact, fmtNum, toLocalISO, todayISO } from '../lib/format';
import { chartTheme } from '../lib/theme';
import { topCategoriesWithOther } from '../lib/dashboardSeries';

// The uncovered remainder of the donut — invoices with no linked purchase order. Named once:
// the slice, the legend and the Excel sheet must all use the exact same honest label.
const NO_ORDER = 'ללא הזמנה מקושרת';

type InvoiceRow = {
  id: string; invoice_number: string; invoice_date: string; total_amount: number;
  payment_status: string; supplier_id: string; supplier: { name: string } | null;
};
type SupplierRow = { id: string; name: string; count: number; total: number };

type PresetKey = 'month' | 'prevMonth' | 'quarter' | 'year';
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'month', label: 'החודש' },
  { key: 'prevMonth', label: 'חודש קודם' },
  { key: 'quarter', label: '3 חודשים' },
  { key: 'year', label: 'שנה' },
];

// Local calendar ranges (toLocalISO, never toISOString — format.ts:16). "3 חודשים" is a
// three-calendar-month window ending today; "שנה" is the trailing twelve months.
function presetRange(key: PresetKey): { from: string; to: string } {
  const now = new Date();
  const today = toLocalISO(now);
  switch (key) {
    case 'month': return { from: toLocalISO(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case 'prevMonth': return {
      from: toLocalISO(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: toLocalISO(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
    case 'quarter': return { from: toLocalISO(new Date(now.getFullYear(), now.getMonth() - 2, 1)), to: today };
    case 'year': return { from: toLocalISO(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())), to: today };
  }
}

// One segment of the money strip — BandStat's anatomy (icon chip · label · mono value ·
// context) in its quiet, non-linked form. Segments live in ONE .card and separate with
// logical borders (border-t stacked / border-s side-by-side) — never divide-x (DESIGN.md).
function StripStat({ title, value, context, icon: Icon }: {
  title: string; value: string; context?: string; icon: LucideIcon;
}) {
  return (
    <div className="min-h-20 border-t border-line-soft px-4 py-3 first:border-t-0 sm:border-s sm:border-t-0 sm:px-5 sm:first:border-s-0">
      <div className="flex items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-idle-wash text-idle-fg" aria-hidden="true">
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

  function setRange(nextFrom: string, nextTo: string) {
    if (!nextFrom || !nextTo) return; // a cleared date input is not a range claim
    const next = new URLSearchParams(params);
    next.set('from', nextFrom);
    next.set('to', nextTo);
    setParams(next, { replace: true });
  }

  const { data, loading, error } = useQuery(async () => {
    const [invRes, catRes] = await Promise.all([
      supabase.from('invoices')
        .select('id, invoice_number, invoice_date, total_amount, payment_status, supplier_id, supplier:suppliers(name)')
        .gte('invoice_date', from).lte('invoice_date', to)
        .is('deleted_at', null)
        .order('invoice_date', { ascending: false }),
      supabase.from('categories').select('id, name'),
    ]);
    const invoices = unwrap(invRes) as InvoiceRow[];
    const categoryNames = new Map((unwrap(catRes) as { id: string; name: string }[]).map((c) => [c.id, c.name]));

    // Category split can only be derived from purchase orders (invoices carry no line items):
    // in-range invoices → invoice_order_links → purchase_order_items at snapshot prices.
    let links: { invoice_id: string; order_id: string }[] = [];
    let items: { qty: number; unit_price: number; product: { category_id: string | null } | null }[] = [];
    if (invoices.length) {
      links = unwrap(await supabase.from('invoice_order_links')
        .select('invoice_id, order_id')
        .in('invoice_id', invoices.map((i) => i.id))) as { invoice_id: string; order_id: string }[];
      const orderIds = [...new Set(links.map((l) => l.order_id))];
      if (orderIds.length) {
        items = unwrap(await supabase.from('purchase_order_items')
          .select('qty, unit_price, product:products(category_id)')
          .in('order_id', orderIds)) as typeof items;
      }
    }

    // Coverage math: an invoice is "covered" when it has at least one linked order. X (covered)
    // and Y (all) are INVOICE totals; the category slices are PO-item sums (qty × snapshot
    // unit_price) and are therefore an approximation of the covered money — the coverage line
    // states this out loud instead of pretending the donut equals the ledger.
    const linkedIds = new Set(links.map((l) => l.invoice_id));
    const totalAll = invoices.reduce((s, i) => s + i.total_amount, 0);
    const coveredTotal = invoices.filter((i) => linkedIds.has(i.id)).reduce((s, i) => s + i.total_amount, 0);
    const uncoveredTotal = totalAll - coveredTotal;

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

    return { invoices, bySupplier, catTotals, totalAll, coveredTotal, uncoveredTotal };
  }, [from, to]);

  function exportExcel() {
    if (!data) return;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.bySupplier.map((r) => ({
      'ספק': r.name, 'חשבוניות': r.count, 'סה"כ': r.total,
      '% מהסך': data.totalAll > 0 ? Number(((r.total / data.totalAll) * 100).toFixed(1)) : null,
    }))), 'לפי ספק');
    const catRows: { 'קטגוריה': string; 'סכום': number }[] = [...data.catTotals]
      .sort((a, b) => b.total - a.total)
      .map((c) => ({ 'קטגוריה': c.name, 'סכום': c.total }));
    if (data.uncoveredTotal > 0) catRows.push({ 'קטגוריה': NO_ORDER, 'סכום': data.uncoveredTotal });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), 'לפי קטגוריה');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.invoices.map((i) => ({
      'ספק': i.supplier?.name ?? '', 'מספר חשבונית': i.invoice_number, 'תאריך': i.invoice_date,
      'סה"כ': i.total_amount, 'סטטוס תשלום': INVOICE_PAYMENT_STATUS[i.payment_status]?.label,
    }))), 'חשבוניות');
    XLSX.writeFile(wb, `expenses-${todayISO()}.xlsx`);
  }

  if (loading) return <SkeletonCards count={3} cols={3} title />;
  if (error || !data) return <ErrorNote message={error ?? 'שגיאה'} />;

  const t = chartTheme();
  const hasInvoices = data.invoices.length > 0;
  // A computed sum over a selected range IS data — ₪0 total with 0 invoices is an honest
  // statement. Only the average is genuinely unmeasurable at 0/0 → "—" (CLAUDE.md).
  const avg = hasInvoices ? data.totalAll / data.invoices.length : null;

  const donutCats = topCategoriesWithOther(data.catTotals);
  const donutData = [
    ...donutCats,
    ...(data.uncoveredTotal > 0 ? [{ name: NO_ORDER, total: data.uncoveredTotal }] : []),
  ];
  const donutTotal = donutData.reduce((s, c) => s + c.total, 0);
  const hasCoverage = donutCats.length > 0;
  // "אחר" keeps chart-5 exactly like the dashboard donut; the honest no-order remainder is
  // NOT a category, so it takes the neutral/idle chart tone (t.flat) — all via chartTheme().
  const sliceColor = (name: string, index: number) =>
    name === NO_ORDER ? t.flat : name === 'אחר' ? t.bars[4] : t.bars[index % 4];
  const donutAria = `פילוח הוצאות לפי קטגוריה: ${donutData
    .map((c) => `${c.name} ${fmtMoneyExact(c.total)}, ${donutTotal > 0 ? Math.round((c.total / donutTotal) * 100) : 0} אחוז`)
    .join(', ')}`;

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
      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <h1 className="page-title">ריכוז הוצאות</h1>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={exportExcel} disabled={!hasInvoices}><FileSpreadsheet size={15} /> ייצוא Excel</button>
          <button className="btn-secondary" onClick={() => window.print()}><Printer size={15} /> הדפסה / PDF</button>
        </div>
      </div>

      {/* Range filter: preset chips (NewOrder chip pattern) + explicit from/to date inputs. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 no-print">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="טווחי תאריכים מהירים">
          {PRESETS.map((p) => {
            const r = presetRange(p.key);
            const active = from === r.from && to === r.to;
            return (
              <button key={p.key} className={`badge ${active ? 'bg-action-solid text-white' : 'bg-idle-soft text-ink-soft'}`}
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

      <div className="print-area space-y-4">
        <div className="hidden print:block">
          <h2 className="text-xl font-bold">ריכוז הוצאות {fmtDate(from)} – {fmtDate(to)}</h2>
        </div>

        {/* Money strip — one card, three segments, logical separators (BandStat anatomy). */}
        <div className="card grid grid-cols-1 sm:grid-cols-3">
          <StripStat title="סה״כ הוצאות בטווח" icon={Banknote}
            value={fmtMoney(Math.round(data.totalAll))} context={`${fmtDate(from)} – ${fmtDate(to)}`} />
          <StripStat title="מספר חשבוניות" icon={ReceiptText}
            value={fmtNum(data.invoices.length)} context="חשבוניות שאינן מחוקות בטווח" />
          <StripStat title="ממוצע לחשבונית" icon={Calculator}
            value={avg == null ? '—' : fmtMoney(Math.round(avg))}
            context={avg == null ? 'אין חשבוניות בטווח' : 'סה״כ חלקי מספר החשבוניות'} />
        </div>

        {!hasInvoices ? (
          <div className="card">
            <EmptyState title="אין חשבוניות בטווח שנבחר"
              subtitle="שנו את טווח התאריכים או בחרו אחד מהטווחים המהירים" />
          </div>
        ) : (
          <>
            <section className="space-y-2">
              <h2 className="section-title">הוצאות לפי ספק</h2>
              <DataTable rows={data.bySupplier} columns={columns} mobile="cards"
                mobileTitle={(r) => r.name}
                onRowClick={(r) => setDrill(r)}
                emptyTitle="אין חשבוניות בטווח" />
            </section>

            <section className="card overflow-hidden">
              <div className="border-b border-line-soft px-4 py-3 sm:px-5">
                <h2 className="section-title">פילוח לפי קטגוריה</h2>
                {/* Explicit coverage: the donut can only see invoices with a linked order. */}
                <p className="mt-0.5 text-xs text-ink-muted">
                  הפילוח מכסה <span className="num">{fmtMoney(Math.round(data.coveredTotal))}</span> מתוך{' '}
                  <span className="num">{fmtMoney(Math.round(data.totalAll))}</span> — חשבוניות עם הזמנה מקושרת בלבד
                </p>
              </div>
              <div className="p-4 sm:p-5">
                {hasCoverage ? (
                  <div className="flex flex-col items-center gap-4 sm:flex-row">
                    <div dir="ltr" role="img" aria-label={donutAria} className="h-44 w-44 shrink-0">
                      <ResponsiveContainer>
                        <PieChart>
                          <Pie data={donutData} dataKey="total" nameKey="name" innerRadius={52} outerRadius={76}
                            paddingAngle={2} stroke="none" isAnimationActive={false}>
                            {donutData.map((c, i) => <Cell key={c.name} fill={sliceColor(c.name, i)} />)}
                          </Pie>
                          <Tooltip cursor={false} formatter={(value) => fmtMoneyExact(Number(value))} isAnimationActive={false} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <ul className="w-full min-w-0 flex-1 space-y-1.5 text-sm">
                      {donutData.map((c, i) => (
                        <li key={c.name} className="flex items-center gap-2">
                          <span className="size-2 shrink-0 rounded-full" aria-hidden="true"
                            style={{ backgroundColor: sliceColor(c.name, i) }} />
                          <span className={`min-w-0 flex-1 truncate ${c.name === NO_ORDER ? 'text-ink-muted' : 'text-ink-mid'}`}>{c.name}</span>
                          <span className="shrink-0 text-ink-muted">
                            <span className="num">{fmtMoney(Math.round(c.total))}</span>
                            {donutTotal > 0 && <> · <span className="num">{Math.round((c.total / donutTotal) * 100)}%</span></>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="py-8 text-center text-sm text-ink-muted">
                    אין חשבוניות עם הזמנה מקושרת בטווח שנבחר — אין פילוח קטגוריות להצגה
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </div>

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

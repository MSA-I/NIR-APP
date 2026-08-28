import { useT } from '../lib/i18n/LocaleProvider';
import { useMemo, useState } from 'react';
import { AlertTriangle, FileSpreadsheet, Info, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { fmtDate, fmtMoneyExact, fmtNum, formatUnit, todayISO } from '../lib/format';
import { Card, DataTable, ErrorNote, ICON, Note, PageHeader, SkeletonTable, useToast, type Column } from '../components/ui';
import { useAuth } from '../auth/AuthContext';
import {
  downloadRenderedWorkbook,
  productPurchaseTemplateValues,
  renderConfiguredReportTemplate,
} from '../lib/reportTemplateExport';
import { neutralizeSpreadsheetRow } from '../lib/documentExport';
import * as XLSX from 'xlsx';

/**
 * Per-product purchase rollup — the screen for `get_product_purchase_summary` (0114).
 *
 * The number this screen exists to get right is `canonical_qty`: one delivery leaves an order line,
 * a receipt line and an invoice line, and summing them triples both quantity and spend while
 * looking entirely plausible. The server counts it once, through `purchase_order_items.id`, and
 * this screen's job is to show the three sources SEPARATELY beside that answer so the rows where
 * they disagree are the ones a person notices.
 *
 * Two badges carry the provenance the server sends, because a quantity whose source is invisible
 * cannot be defended in a supplier conversation: whether any of it rests on the supplier's word
 * rather than our own count, and whether any of it is still waiting for evidence altogether.
 */
interface SummaryRow {
  product_id: string;
  product_name: string;
  unit: string | null;
  ordered_qty: number | null;
  received_qty: number | null;
  invoiced_qty: number | null;
  canonical_qty: number | null;
  supplier_count: number;
  order_count: number;
  invoice_count: number;
  gross_amount: number | null;
  average_unit_price: number | null;
  includes_invoice_only_quantity: boolean;
  includes_unevidenced_quantity: boolean;
}

interface SummaryResponse {
  from: string;
  to: string;
  products: SummaryRow[];
  unmapped_invoice_lines: number;
  unmapped_invoice_amount: number | null;
  quantity_rule: string;
}

function monthStart(): string {
  return `${todayISO().slice(0, 7)}-01`;
}

export default function ProductPurchaseSummary() {
  const { errorText, locale } = useT();
  const { org } = useAuth();
  const toast = useToast();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO);
  const [exporting, setExporting] = useState(false);

  const { data, loading, error } = useQuery<SummaryResponse>(async () =>
    unwrap(await supabase.rpc('get_product_purchase_summary', {
      p_from: from, p_to: to, p_supplier_id: null,
    })) as SummaryResponse, [from, to]);

  const rows = useMemo(
    () => (data?.products ?? []).map((row) => ({ ...row, id: row.product_id })),
    [data]);

  const columns: Column<SummaryRow & { id: string }>[] = [
    {
      key: 'product', header: 'מוצר', sortValue: (r) => r.product_name,
      render: (r) => (
        <div>
          <div className="font-medium text-ink"><bdi>{r.product_name}</bdi></div>
          <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-ink-muted">
            {r.unit && <span>{formatUnit(r.unit, locale)}</span>}
            {/* Provenance, not decoration. "Some of this rests on the supplier's word" is the
                difference between a number you can quote back to them and one you cannot. */}
            {r.includes_invoice_only_quantity && <span>· חלק מהכמות לפי החשבונית בלבד</span>}
            {r.includes_unevidenced_quantity && <span>· חלק מהשורות טרם אושרו בראיה</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'canonical', header: 'נרכש בפועל', priority: 1,
      sortValue: (r) => r.canonical_qty ?? -1,
      render: (r) => <span className="num font-semibold">{fmtNum(r.canonical_qty)}</span>,
    },
    // Ordered, received and invoiced stay side by side. The rows worth opening are the ones where
    // they disagree, and one merged figure hides exactly that.
    { key: 'ordered', header: 'הוזמן', sortValue: (r) => r.ordered_qty ?? -1,
      render: (r) => <span className="num">{fmtNum(r.ordered_qty)}</span> },
    { key: 'received', header: 'התקבל', sortValue: (r) => r.received_qty ?? -1,
      render: (r) => <span className="num">{fmtNum(r.received_qty)}</span> },
    { key: 'invoiced', header: 'חויב', sortValue: (r) => r.invoiced_qty ?? -1,
      render: (r) => <span className="num">{fmtNum(r.invoiced_qty)}</span> },
    { key: 'gross', header: 'הוצאה', sortValue: (r) => r.gross_amount ?? -1,
      render: (r) => <span className="num">{fmtMoneyExact(r.gross_amount)}</span> },
    { key: 'avg', header: 'מחיר יחידה ממוצע',
      sortValue: (r) => r.average_unit_price ?? -1,
      render: (r) => <span className="num">{fmtMoneyExact(r.average_unit_price)}</span> },
    { key: 'sources', header: 'ספקים · הזמנות · חשבוניות', priority: 3,
      sortValue: (r) => r.supplier_count,
      render: (r) => (
        <span className="num text-ink-muted">
          {r.supplier_count} · {r.order_count} · {r.invoice_count}
        </span>
      ) },
  ];

  async function exportExcel() {
    if (!data || !org || loading || error || from > to) return;
    setExporting(true);
    try {
      const values = productPurchaseTemplateValues({
        orgName: org.name,
        periodLabel: `${fmtDate(from)} – ${fmtDate(to)}`,
        periodFrom: fmtDate(from),
        periodTo: fmtDate(to),
        generatedAt: fmtDate(todayISO()),
        products: data.products,
        unmappedInvoiceLines: data.unmapped_invoice_lines,
        unmappedInvoiceAmount: data.unmapped_invoice_amount,
      });
      const fileName = `product-purchases-${from}-${to}.xlsx`;
      const templated = await renderConfiguredReportTemplate({
        exportKey: 'product_purchase_summary', orgId: org.id, values,
      });
      if (templated) {
        downloadRenderedWorkbook(templated, fileName);
      } else {
        const book = XLSX.utils.book_new();
        const exportRows = data.products.map((row) => neutralizeSpreadsheetRow({
          'מוצר': row.product_name,
          'יחידה': formatUnit(row.unit, locale),
          'הוזמן': row.ordered_qty,
          'התקבל': row.received_qty,
          'חויב': row.invoiced_qty,
          'נרכש בפועל': row.canonical_qty,
          'מספר ספקים': row.supplier_count,
          'מספר הזמנות': row.order_count,
          'מספר חשבוניות': row.invoice_count,
          'הוצאה ברוטו': row.gross_amount,
          'מחיר יחידה ממוצע': row.average_unit_price,
        }));
        XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(exportRows), 'רכישות מוצרים');
        XLSX.writeFile(book, fileName);
      }
      toast('קובץ ה-Excel הורד');
    } catch (exportError) {
      toast(errorText(exportError), 'error');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      <PageHeader title="סיכום רכישות מוצרים"
        meta={data ? `${rows.length} מוצרים · ${data.from} עד ${data.to}` : undefined}
        actions={<button className="btn-secondary" type="button" onClick={() => void exportExcel()}
          disabled={exporting || loading || !!error || !data || rows.length === 0 || from > to}>
            {exporting ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <FileSpreadsheet size={ICON.sm} aria-hidden="true" />}
          {exporting ? 'מכין קובץ…' : 'ייצוא Excel'}
        </button>} />

      <Card pad={false} className="flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className="label" htmlFor="summary-from">מתאריך</label>
          <input id="summary-from" type="date" className="input num" value={from}
            onChange={(event) => setFrom(event.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="summary-to">עד תאריך</label>
          <input id="summary-to" type="date" className="input num" value={to}
            onChange={(event) => setTo(event.target.value)} />
        </div>
      </Card>

      {/* The counting rule, stated on the screen rather than left in a migration comment. A person
          comparing this to their own spreadsheet needs to know which number they are looking at. */}
      <Note tone="info">
        <p className="flex items-start gap-2 text-sm">
          <Info size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>
            „נרכש בפועל” נספר <strong>פעם אחת</strong> לכל משלוח: קבלה שהושלמה גוברת על החשבונית,
            והחשבונית משמשת רק כשאין ראיית קבלה. „הוזמן” אינו נספר כרכישה.
          </span>
        </p>
      </Note>

      {/* Money nobody could place. A work list, not a rounding error — and never folded into a
          product's total, because the product it belongs to is not established. */}
      {data && data.unmapped_invoice_lines > 0 && (
        <Note tone="await" role="status">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>
              <span className="num">{data.unmapped_invoice_lines}</span> שורות חשבונית בסך
              <span className="num"> {fmtMoneyExact(data.unmapped_invoice_amount)}</span> לא שויכו
              לשורת הזמנה, ולכן אינן נספרות באף מוצר. הן ממתינות למיפוי ידני.
            </span>
          </p>
        </Note>
      )}

      {loading && !data ? <SkeletonTable cols={8} /> : (
        <DataTable rows={rows} columns={columns} searchable mobile="cards"
          searchFn={(r, q) => r.product_name.toLowerCase().includes(q)}
          emptyTitle="אין רכישות בטווח שנבחר"
          emptySubtitle="הזמנות שאינן טיוטה בטווח התאריכים יופיעו כאן, עם מה שהתקבל וחויב מולן." />
      )}
    </div>
  );
}

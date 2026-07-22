import { useMemo, useRef, useState } from 'react';
import { useParamState } from '../lib/useParamState';
import { toHebrewError } from "../lib/errors";
import { TrendingUp, TrendingDown, Upload, History, Pencil, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, Modal, useToast, ErrorNote, StatusBadge, Note, SkeletonTable, type Column } from '../components/ui';
import { readSheet, matchColumn, mapRows, cellText, cellNumber, skipRow } from '../lib/importSheet';
import { fmtDate, todayISO } from '../lib/format';
import { PRODUCT_AVAILABILITY } from '../lib/status';
import type { SupplierProduct, Supplier, PriceHistory } from '../lib/types';

type Row = SupplierProduct & { supplier: Supplier; product: { id: string; name: string; unit: string } };

export default function PriceLists() {
  const { profile } = useAuth();
  const toast = useToast();
  const [supplierFilter, setSupplierFilter] = useState('');
  // '1' via ?increases=1 (from the dashboard price-increase card); re-syncs on navigation.
  const [increasesStr, setIncreasesStr] = useParamState('increases');
  const onlyIncreases = increasesStr === '1';
  // ?product=<product_id> deep-links from a product/supplier card to that one product's prices;
  // coexists with the supplier + increases filters and is cleared from the chip below.
  const [productFilter, setProductFilter] = useParamState('product');
  const [historyFor, setHistoryFor] = useState<Row | null>(null);
  const [editFor, setEditFor] = useState<Row | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () =>
    unwrap(await supabase.from('supplier_products')
      .select('*, supplier:suppliers(id, name, status), product:products(id, name, unit)')
      .order('updated_at', { ascending: false })) as Promise<Row[]>);

  const suppliers = useMemo(() => {
    const map = new Map<string, string>();
    data?.forEach((r) => map.set(r.supplier.id, r.supplier.name));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'he'));
  }, [data]);

  const canWrite = profile?.role === 'owner' || profile?.role === 'office';

  const rows = (data ?? []).filter((r) =>
    (!supplierFilter || r.supplier_id === supplierFilter) &&
    (!productFilter || r.product_id === productFilter) &&
    (!onlyIncreases || (r.previous_price != null && r.current_price > r.previous_price)));

  const activeProductName = productFilter ? data?.find((r) => r.product_id === productFilter)?.product.name : null;

  const changePct = (r: Row) => r.previous_price ? ((r.current_price - r.previous_price) / r.previous_price) * 100 : 0;

  const columns: Column<Row>[] = [
    { key: 'product', header: 'מוצר', sortValue: (r) => r.product.name, render: (r) => <span className="font-medium text-ink">{r.product.name}</span> },
    { key: 'supplier', header: 'ספק', sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'unit', header: 'יח׳', render: (r) => r.product.unit },
    { key: 'price', header: 'מחיר נוכחי', className: 'num', sortValue: (r) => r.current_price, render: (r) => <span className="font-semibold">₪{r.current_price.toFixed(2)}</span> },
    { key: 'prev', header: 'מחיר קודם', className: 'num', render: (r) => (r.previous_price != null ? `₪${r.previous_price.toFixed(2)}` : '—') },
    {
      key: 'change', header: 'שינוי', sortValue: changePct,
      render: (r) => {
        const pct = changePct(r);
        if (!r.previous_price || pct === 0) return <span className="text-ink-faint">—</span>;
        return pct > 0
          ? <span className="inline-flex items-center gap-1 text-trend-up-fg font-medium"><TrendingUp size={14} />‎+{pct.toFixed(1)}%</span>
          : <span className="inline-flex items-center gap-1 text-trend-down-fg font-medium"><TrendingDown size={14} />‎{pct.toFixed(1)}%</span>;
      },
    },
    { key: 'date', header: 'בתוקף מ־', sortValue: (r) => r.price_effective_date, render: (r) => fmtDate(r.price_effective_date) },
    { key: 'avail', header: 'זמינות', render: (r) => <StatusBadge meta={PRODUCT_AVAILABILITY[r.available ? 'available' : 'unavailable']} /> },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">מחירונים</h1>
        {canWrite && <button className="btn-secondary" onClick={() => setImportOpen(true)}><Upload size={15} /> ייבוא מ־Excel/CSV</button>}
      </div>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.product.name.toLowerCase().includes(q) || r.supplier.name.toLowerCase().includes(q)}
        searchLabel="חיפוש במחירונים"
        rowLabel={(r) => `${r.product.name} אצל ${r.supplier.name}`}
        rowActions={(r) => [
          { key: 'history', label: 'היסטוריית מחירים', icon: History, onSelect: () => setHistoryFor(r) },
          { key: 'edit', label: 'עדכון מחיר', icon: Pencil, hidden: !canWrite, onSelect: () => setEditFor(r) },
        ]}
        toolbar={
          <>
            {productFilter && (
              <button className="btn-ghost text-sm text-action flex items-center gap-1" onClick={() => setProductFilter('')} title="הסרת סינון מוצר">
                <X size={14} /> {activeProductName ?? 'מוצר'}
              </button>
            )}
            <select className="input w-auto!" aria-label="סינון מחירונים לפי ספק" value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
              <option value="">כל הספקים</option>
              {suppliers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-ink-soft">
              <input type="checkbox" className="rounded" checked={onlyIncreases} onChange={(e) => setIncreasesStr(e.target.checked ? '1' : '')} />
              רק התייקרויות
            </label>
          </>
        } />

      {historyFor && <PriceHistoryModal row={historyFor} onClose={() => setHistoryFor(null)} />}
      {editFor && (
        <EditPriceModal row={editFor} onClose={() => setEditFor(null)}
          onSaved={() => { setEditFor(null); toast('המחיר עודכן'); void refetch(); }} />
      )}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void refetch(); }} />}
    </div>
  );
}

function PriceHistoryModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const { data } = useQuery<PriceHistory[]>(async () =>
    unwrap(await supabase.from('price_history').select('*').eq('supplier_product_id', row.id).order('effective_date', { ascending: false })), [row.id]);
  return (
    <Modal open onClose={onClose} title={`היסטוריית מחירים — ${row.product.name} (${row.supplier.name})`}>
      {data?.length ? (
        <table className="w-full">
          <thead><tr><th className="th">תאריך</th><th className="th">מחיר</th></tr></thead>
          <tbody className="divide-y divide-line-soft">
            {data.map((h) => (
              <tr key={h.id}><td className="td">{fmtDate(h.effective_date)}</td><td className="td num">₪{h.price.toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : <div className="text-sm text-ink-muted py-4 text-center">אין רשומות היסטוריה</div>}
    </Modal>
  );
}

function EditPriceModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [price, setPrice] = useState(row.current_price.toString());
  const [date, setDate] = useState(todayISO());
  const [available, setAvailable] = useState(row.available);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    const p = Number(price);
    if (!p || p <= 0) { toast('מחיר לא תקין', 'error'); return; }
    if (!reason.trim()) { toast('נדרשת סיבה לעדכון המחיר', 'error'); return; }
    setBusy(true);
    const upd = await supabase.rpc('set_supplier_product_price', {
      p_supplier_product_id: row.id,
      p_price: p,
      p_effective_date: date,
      p_available: available,
      p_reason: reason.trim(),
    });
    if (upd.error) { setBusy(false); toast(toHebrewError(upd.error.message), 'error'); return; }
    setBusy(false);
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={`עדכון מחיר — ${row.product.name} (${row.supplier.name})`} busy={busy} statusMessage={busy ? 'שומר את המחיר' : undefined}>
      <div className="space-y-4">
        <div><label className="label" htmlFor="price-list-price">מחיר חדש (₪)</label><input id="price-list-price" type="number" step="0.01" className="input num" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
        <div><label className="label" htmlFor="price-list-date">בתוקף מתאריך</label><input id="price-list-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded" checked={available} onChange={(e) => setAvailable(e.target.checked)} /> זמין אצל הספק</label>
        <div><label className="label">סיבת העדכון *</label><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>שמירה</button>
      </div>
    </Modal>
  );
}

/** Import price list: expects columns ספק / מוצר / מחיר (or supplier/product/price). */
function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ supplier: string; product: string; price: number }[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  async function onFile(file: File) {
    try {
      const sheet = await readSheet(file);
      // exact header names only, as before — this screen has no column-mapping step to correct a wrong guess
      const cols = {
        supplier: matchColumn(sheet.headers, ['ספק', 'supplier'], false),
        product: matchColumn(sheet.headers, ['מוצר', 'product'], false),
        price: matchColumn(sheet.headers, ['מחיר', 'price'], false),
      };
      const { valid } = mapRows(sheet.rows, (r) => {
        const supplier = cellText(r, cols.supplier);
        const product = cellText(r, cols.product);
        const price = cellNumber(r, cols.price) ?? 0;
        if (!supplier || !product || price <= 0) return skipRow('חסר ספק, מוצר או מחיר תקין');
        return { supplier, product, price };
      });
      if (!valid.length) { toast('לא נמצאו שורות תקינות. נדרשות עמודות: ספק, מוצר, מחיר', 'error'); return; }
      setPreview(valid);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'שגיאה בקריאת הקובץ', 'error');
    }
  }

  async function runImport() {
    if (!reason.trim()) { toast('נדרשת סיבה לייבוא המחירון', 'error'); return; }
    setBusy(true);
    try {
      const suppliers = unwrap(await supabase.from('suppliers').select('id, name')) as { id: string; name: string }[];
      const products = unwrap(await supabase.from('products').select('id, name')) as { id: string; name: string }[];
      const unresolved: number[] = [];
      const rows = preview.flatMap((row, index) => {
        const supplier = suppliers.find((candidate) => candidate.name.trim() === row.supplier);
        const product = products.find((candidate) => candidate.name.trim() === row.product);
        if (!supplier || !product) { unresolved.push(index + 2); return []; }
        return [{ supplier_id: supplier.id, product_id: product.id, price: row.price, available: true }];
      });
      if (unresolved.length) {
        throw new Error(`הייבוא בוטל: ספק או מוצר לא נמצאו בשם מדויק בשורות ${unresolved.slice(0, 12).join(', ')}.`);
      }
      const imported = unwrap(await supabase.rpc('import_supplier_prices', {
        p_rows: rows,
        p_effective_date: todayISO(),
        p_reason: reason.trim(),
      })) as { updated: number; created: number; unchanged: number };
      setReport(`עודכנו ${imported.updated} מחירים, נוצרו ${imported.created} רשומות חדשות, ${imported.unchanged} ללא שינוי.`);
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="ייבוא מחירון מ־Excel / CSV" wide busy={busy} statusMessage={report ?? (busy ? 'מייבא את המחירון' : undefined)}>
      {report ? (
        <div className="space-y-4">
          <Note tone="done">{report}</Note>
          <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>סיום</button></div>
        </div>
      ) : preview.length ? (
        <div className="space-y-4">
          <div className="text-sm text-ink-soft">{preview.length} שורות זוהו. ההתאמה מתבצעת לפי שם ספק ושם מוצר מדויקים.</div>
          <div className="max-h-64 overflow-y-auto border border-line-soft rounded-lg">
            <table className="w-full">
              <thead className="bg-surface-sunken sticky top-0"><tr><th scope="col" className="th">ספק</th><th scope="col" className="th">מוצר</th><th scope="col" className="th">מחיר</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {preview.slice(0, 100).map((r, i) => (
                  <tr key={i}><td className="td">{r.supplier}</td><td className="td">{r.product}</td><td className="td num">₪{r.price.toFixed(2)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div><label className="label">סיבת הייבוא *</label><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => setPreview([])}>חזרה</button>
            <button className="btn-primary" disabled={busy} onClick={() => void runImport()}>{busy ? 'מייבא...' : 'אישור וייבוא'}</button>
          </div>
        </div>
      ) : (
        <div className="text-center py-8">
          <p className="text-sm text-ink-soft mb-4">בחר קובץ Excel או CSV עם העמודות: <b>ספק</b>, <b>מוצר</b>, <b>מחיר</b></p>
          <button className="btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={16} /> בחירת קובץ</button>
          <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
        </div>
      )}
    </Modal>
  );
}

import { useRef, useState } from 'react';
import { toHebrewError } from "../lib/errors";
import { Upload, Pencil, Tags } from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, Modal, useToast, ErrorNote, StatusBadge, Note, SkeletonTable, type Column } from '../components/ui';
import { fmtDate, todayISO } from '../lib/format';
import { PRODUCT_AVAILABILITY } from '../lib/status';
import type { Supplier, SupplierProduct } from '../lib/types';

type Row = SupplierProduct & { product: { id: string; name: string; unit: string } };

/**
 * Supplier agent portal — the ONLY screen a supplier login can use.
 * RLS (migration 0004) guarantees the agent reads/writes just its own price rows.
 */
export default function SupplierPrices() {
  const { profile, org } = useAuth();
  const toast = useToast();
  const [editFor, setEditFor] = useState<Row | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    const supplier = unwrap(await supabase.from('suppliers').select('*').eq('id', profile!.supplier_id!).single()) as Supplier;
    const rows = unwrap(await supabase.from('supplier_products')
      .select('*, product:products(id, name, unit)')
      .eq('supplier_id', profile!.supplier_id!)
      .order('updated_at', { ascending: false })) as Row[];
    return { supplier, rows };
  });

  const columns: Column<Row>[] = [
    { key: 'product', header: 'מוצר', sortValue: (r) => r.product.name, render: (r) => <span className="font-medium text-ink">{r.product.name}</span> },
    { key: 'unit', header: 'יח׳', render: (r) => r.product.unit },
    { key: 'price', header: 'מחיר נוכחי', className: 'num', sortValue: (r) => r.current_price, render: (r) => <span className="font-semibold">₪{r.current_price.toFixed(2)}</span> },
    { key: 'prev', header: 'מחיר קודם', className: 'num', render: (r) => (r.previous_price != null ? `₪${r.previous_price.toFixed(2)}` : '—') },
    { key: 'date', header: 'בתוקף מ־', sortValue: (r) => r.price_effective_date, render: (r) => fmtDate(r.price_effective_date) },
    { key: 'avail', header: 'זמינות', render: (r) => <StatusBadge meta={PRODUCT_AVAILABILITY[r.available ? 'available' : 'unavailable']} /> },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error || !data) return <ErrorNote message={error ?? 'שגיאה'} />;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="page-title flex items-center gap-2"><Tags size={22} /> המחירון שלי</h1>
          {/* Read by a supplier agent — names the buying organization, not the vendor. */}
          <div className="text-sm text-ink-muted mt-1">{`${data.supplier.name} — עדכון מחירים וזמינות${org?.name ? ` עבור ${org.name}` : ''}`}</div>
        </div>
        <button className="btn-primary" onClick={() => setImportOpen(true)}><Upload size={15} /> העלאת מחירון (Excel/CSV)</button>
      </div>

      <Note tone="info">
        קובץ המחירון צריך לכלול שתי עמודות: <b>מוצר</b> (שם מדויק) ו-<b>מחיר</b>. מחירים שהשתנו יתועדו בהיסטוריה.
      </Note>

      <DataTable rows={data.rows} columns={columns} searchable
        searchFn={(r, q) => r.product.name.toLowerCase().includes(q)}
        searchLabel="חיפוש במחירון שלי"
        rowLabel={(r) => `מוצר ${r.product.name}`}
        rowActions={(r) => [
          { key: 'edit', label: 'עדכון מחיר וזמינות', icon: Pencil, onSelect: () => setEditFor(r) },
        ]}
        emptyTitle="אין מוצרים במחירון" emptySubtitle="העלה קובץ מחירון כדי להתחיל" />

      {editFor && (
        <EditModal row={editFor} onClose={() => setEditFor(null)}
          onSaved={() => { setEditFor(null); toast('עודכן בהצלחה'); void refetch(); }} />
      )}
      {importOpen && (
        <ImportModal supplierId={profile!.supplier_id!}
          onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void refetch(); }} />
      )}
    </div>
  );
}

function EditModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [price, setPrice] = useState(row.current_price.toString());
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
      p_effective_date: todayISO(),
      p_available: available,
      p_reason: reason.trim(),
    });
    if (upd.error) { setBusy(false); toast(toHebrewError(upd.error.message), 'error'); return; }
    setBusy(false);
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={`עדכון — ${row.product.name}`} busy={busy} statusMessage={busy ? 'שומר את המחיר והזמינות' : undefined}>
      <div className="space-y-4">
        <div><label className="label" htmlFor="supplier-price">מחיר (₪)</label><input id="supplier-price" type="number" step="0.01" className="input num" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded" checked={available} onChange={(e) => setAvailable(e.target.checked)} /> המוצר זמין</label>
        <div><label className="label">סיבת העדכון *</label><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>שמירה</button>
      </div>
    </Modal>
  );
}

function ImportModal({ supplierId, onClose, onDone }: {
  supplierId: string; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ product: string; price: number }[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  async function onFile(file: File) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf);
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
    const rows = json.map((r) => ({
      product: String(r['מוצר'] ?? r['product'] ?? '').trim(),
      price: Number(r['מחיר'] ?? r['price'] ?? 0),
    })).filter((r) => r.product && r.price > 0);
    if (!rows.length) { toast('לא נמצאו שורות תקינות (נדרשות עמודות: מוצר, מחיר)', 'error'); return; }
    setPreview(rows);
  }

  async function runImport() {
    if (!reason.trim()) { toast('נדרשת סיבה לייבוא המחירון', 'error'); return; }
    setBusy(true);
    try {
      const products = unwrap(await supabase.from('products').select('id, name')) as { id: string; name: string }[];
      const unresolved: number[] = [];
      const rows = preview.flatMap((row, index) => {
        const product = products.find((candidate) => candidate.name.trim() === row.product);
        if (!product) { unresolved.push(index + 2); return []; }
        return [{ supplier_id: supplierId, product_id: product.id, price: row.price, available: true }];
      });
      if (unresolved.length) {
        throw new Error(`הייבוא בוטל: שמות מוצר לא נמצאו בקטלוג בשורות ${unresolved.slice(0, 12).join(', ')}.`);
      }
      const imported = unwrap(await supabase.rpc('import_supplier_prices', {
        p_rows: rows,
        p_effective_date: todayISO(),
        p_reason: reason.trim(),
      })) as { updated: number; created: number; unchanged: number };
      setReport(`עודכנו ${imported.updated} מחירים · נוספו ${imported.created} מוצרים · ${imported.unchanged} ללא שינוי.`);
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="העלאת מחירון" wide busy={busy} statusMessage={report ?? (busy ? 'מעדכן את המחירון' : undefined)}>
      {report ? (
        <div className="space-y-4">
          <Note tone="done">{report}</Note>
          <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>סיום</button></div>
        </div>
      ) : preview.length ? (
        <div className="space-y-4">
          <div className="text-sm text-ink-soft">{preview.length} שורות זוהו בקובץ:</div>
          <div className="max-h-64 overflow-y-auto border border-line-soft rounded-lg">
            <table className="w-full">
              <thead className="bg-surface-sunken sticky top-0"><tr><th scope="col" className="th">מוצר</th><th scope="col" className="th">מחיר</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {preview.slice(0, 100).map((r, i) => (
                  <tr key={i}><td className="td">{r.product}</td><td className="td num">₪{r.price.toFixed(2)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div><label className="label">סיבת הייבוא *</label><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => setPreview([])}>חזרה</button>
            <button className="btn-primary" disabled={busy} onClick={() => void runImport()}>{busy ? 'מעדכן...' : 'אישור ועדכון המחירון'}</button>
          </div>
        </div>
      ) : (
        <div className="text-center py-8">
          <p className="text-sm text-ink-soft mb-4">בחר קובץ Excel או CSV עם העמודות: <b>מוצר</b>, <b>מחיר</b></p>
          <button className="btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={16} /> בחירת קובץ</button>
          <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
        </div>
      )}
    </Modal>
  );
}

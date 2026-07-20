import { useRef, useState } from 'react';
import { Upload, Pencil, Tags } from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, Modal, useToast, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { fmtDate, todayISO } from '../lib/format';
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
    { key: 'product', header: 'מוצר', sortValue: (r) => r.product.name, render: (r) => <span className="font-medium text-slate-900">{r.product.name}</span> },
    { key: 'unit', header: 'יח׳', render: (r) => r.product.unit },
    { key: 'price', header: 'מחיר נוכחי', className: 'num', sortValue: (r) => r.current_price, render: (r) => <span className="font-semibold">₪{r.current_price.toFixed(2)}</span> },
    { key: 'prev', header: 'מחיר קודם', className: 'num', render: (r) => (r.previous_price != null ? `₪${r.previous_price.toFixed(2)}` : '—') },
    { key: 'date', header: 'בתוקף מ־', sortValue: (r) => r.price_effective_date, render: (r) => fmtDate(r.price_effective_date) },
    { key: 'avail', header: 'זמינות', render: (r) => (r.available ? <span className="badge-green">זמין</span> : <span className="badge-red">לא זמין</span>) },
    {
      key: 'edit', header: '', render: (r) => (
        <button className="btn-ghost p-1.5!" title="עדכון" onClick={() => setEditFor(r)}><Pencil size={15} /></button>
      ),
    },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error || !data) return <ErrorNote message={error ?? 'שגיאה'} />;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="page-title flex items-center gap-2"><Tags size={22} /> המחירון שלי</h1>
          {/* Read by a supplier agent — names the buying organization, not the vendor. */}
          <div className="text-sm text-slate-500 mt-1">{`${data.supplier.name} — עדכון מחירים וזמינות${org?.name ? ` עבור ${org.name}` : ''}`}</div>
        </div>
        <button className="btn-primary" onClick={() => setImportOpen(true)}><Upload size={15} /> העלאת מחירון (Excel/CSV)</button>
      </div>

      <div className="rounded-lg bg-sky-50 border border-sky-200 text-sky-800 text-sm px-4 py-2.5">
        קובץ המחירון צריך לכלול שתי עמודות: <b>מוצר</b> (שם מדויק) ו-<b>מחיר</b>. מחירים שהשתנו יתועדו בהיסטוריה.
      </div>

      <DataTable rows={data.rows} columns={columns} searchable
        searchFn={(r, q) => r.product.name.toLowerCase().includes(q)}
        emptyTitle="אין מוצרים במחירון" emptySubtitle="העלה קובץ מחירון כדי להתחיל" />

      {editFor && (
        <EditModal row={editFor} onClose={() => setEditFor(null)}
          onSaved={() => { setEditFor(null); toast('עודכן בהצלחה'); void refetch(); }} />
      )}
      {importOpen && (
        <ImportModal supplierId={profile!.supplier_id!} orgId={profile!.org_id} existing={data.rows}
          onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void refetch(); }} />
      )}
    </div>
  );
}

function EditModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [price, setPrice] = useState(row.current_price.toString());
  const [available, setAvailable] = useState(row.available);
  const [busy, setBusy] = useState(false);

  async function save() {
    const p = Number(price);
    if (!p || p <= 0) { toast('מחיר לא תקין', 'error'); return; }
    setBusy(true);
    const upd = await supabase.from('supplier_products').update({
      current_price: p,
      previous_price: p !== row.current_price ? row.current_price : row.previous_price,
      price_effective_date: todayISO(),
      available,
    }).eq('id', row.id);
    if (upd.error) { setBusy(false); toast(upd.error.message, 'error'); return; }
    if (p !== row.current_price) {
      await supabase.from('price_history').insert({
        org_id: profile!.org_id, supplier_product_id: row.id, price: p, effective_date: todayISO(), created_by: profile!.id,
      });
    }
    setBusy(false);
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={`עדכון — ${row.product.name}`}>
      <div className="space-y-4">
        <div><label className="label">מחיר (₪)</label><input type="number" step="0.01" className="input num" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded" checked={available} onChange={(e) => setAvailable(e.target.checked)} /> המוצר זמין</label>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" onClick={onClose}>ביטול</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>שמירה</button>
      </div>
    </Modal>
  );
}

function ImportModal({ supplierId, orgId, existing, onClose, onDone }: {
  supplierId: string; orgId: string; existing: Row[]; onClose: () => void; onDone: () => void;
}) {
  const { profile } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ product: string; price: number }[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    const products = unwrap(await supabase.from('products').select('id, name')) as { id: string; name: string }[];
    let updated = 0, created = 0, unchanged = 0, skipped = 0;
    for (const row of preview) {
      const prod = products.find((p) => p.name.trim() === row.product);
      if (!prod) { skipped++; continue; }
      const cur = existing.find((e) => e.product_id === prod.id);
      if (cur) {
        if (cur.current_price === row.price) { unchanged++; continue; }
        await supabase.from('supplier_products').update({
          current_price: row.price, previous_price: cur.current_price, price_effective_date: todayISO(), available: true,
        }).eq('id', cur.id);
        await supabase.from('price_history').insert({
          org_id: orgId, supplier_product_id: cur.id, price: row.price, effective_date: todayISO(), created_by: profile!.id,
        });
        updated++;
      } else {
        const ins = await supabase.from('supplier_products').insert({
          org_id: orgId, supplier_id: supplierId, product_id: prod.id,
          current_price: row.price, price_effective_date: todayISO(),
        }).select('id').single();
        if (!ins.error && ins.data) {
          await supabase.from('price_history').insert({
            org_id: orgId, supplier_product_id: ins.data.id, price: row.price, effective_date: todayISO(), created_by: profile!.id,
          });
          created++;
        }
      }
    }
    setBusy(false);
    setReport(`עודכנו ${updated} מחירים · נוספו ${created} מוצרים · ${unchanged} ללא שינוי · ${skipped} שורות לא זוהו (שם מוצר לא תואם לקטלוג).`);
  }

  return (
    <Modal open onClose={onClose} title="העלאת מחירון" wide>
      {report ? (
        <div className="space-y-4">
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-3">{report}</div>
          <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>סיום</button></div>
        </div>
      ) : preview.length ? (
        <div className="space-y-4">
          <div className="text-sm text-slate-600">{preview.length} שורות זוהו בקובץ:</div>
          <div className="max-h-64 overflow-y-auto border border-slate-100 rounded-lg">
            <table className="w-full">
              <thead className="bg-slate-50 sticky top-0"><tr><th className="th">מוצר</th><th className="th">מחיר</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {preview.slice(0, 100).map((r, i) => (
                  <tr key={i}><td className="td">{r.product}</td><td className="td num">₪{r.price.toFixed(2)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setPreview([])}>חזרה</button>
            <button className="btn-primary" disabled={busy} onClick={() => void runImport()}>{busy ? 'מעדכן...' : 'אישור ועדכון המחירון'}</button>
          </div>
        </div>
      ) : (
        <div className="text-center py-8">
          <p className="text-sm text-slate-600 mb-4">בחר קובץ Excel או CSV עם העמודות: <b>מוצר</b>, <b>מחיר</b></p>
          <button className="btn-primary" onClick={() => fileRef.current?.click()}><Upload size={16} /> בחירת קובץ</button>
          <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
        </div>
      )}
    </Modal>
  );
}

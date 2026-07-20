import { useState } from 'react';
import { Plus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, Modal, useToast, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { useCategories } from './Suppliers';
import type { Product } from '../lib/types';

interface ProductRow extends Product {
  supplierCount?: number;
  bestPrice?: number | null;
}

export default function Products() {
  const { profile } = useAuth();
  const [editing, setEditing] = useState<Product | null | 'new'>(null);
  const [catFilter, setCatFilter] = useState('');
  const { data: categories } = useCategories();

  const { data, loading, error, refetch } = useQuery(async () => {
    const products = unwrap(await supabase.from('products').select('*, category:categories(id, name)').order('name')) as ProductRow[];
    const sps = unwrap(await supabase.from('supplier_products').select('product_id, current_price, available')) as { product_id: string; current_price: number; available: boolean }[];
    const byProduct = new Map<string, number[]>();
    for (const sp of sps) {
      if (!sp.available) continue;
      const arr = byProduct.get(sp.product_id) ?? [];
      arr.push(sp.current_price);
      byProduct.set(sp.product_id, arr);
    }
    return products.map((p) => ({
      ...p,
      supplierCount: byProduct.get(p.id)?.length ?? 0,
      bestPrice: byProduct.get(p.id)?.length ? Math.min(...byProduct.get(p.id)!) : null,
    }));
  });

  const canWrite = profile?.role !== 'accountant' && profile?.role !== 'payer';
  const rows = (data ?? []).filter((p) => !catFilter || p.category_id === catFilter);

  const columns: Column<ProductRow>[] = [
    { key: 'name', header: 'מוצר', sortValue: (r) => r.name, render: (r) => <span className={`font-medium ${r.active ? 'text-slate-900' : 'text-slate-400 line-through'}`}>{r.name}</span> },
    { key: 'cat', header: 'קטגוריה', sortValue: (r) => r.category?.name ?? '', render: (r) => r.category?.name ?? '—' },
    { key: 'unit', header: 'יחידת מידה', render: (r) => r.unit },
    { key: 'sku', header: 'מק״ט', render: (r) => <span dir="ltr">{r.sku ?? '—'}</span> },
    // Shows 0, not `—`. The dash means "no data"; a product with no supplier is a measured
    // fact and an actionable one — it cannot be ordered. Hiding it behind the same glyph as
    // "unknown" buried the very rows worth looking at.
    { key: 'suppliers', header: 'ספקים', className: 'num', sortValue: (r) => r.supplierCount ?? 0, render: (r) => r.supplierCount ?? 0 },
    {
      key: 'best', header: 'מחיר מיטבי', className: 'num', sortValue: (r) => r.bestPrice ?? 0,
      render: (r) => (r.bestPrice != null ? `₪${r.bestPrice.toFixed(2)}` : '—'),
    },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="page-title">מוצרים</h1>
        {canWrite && <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> מוצר חדש</button>}
      </div>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.name.toLowerCase().includes(q) || (r.sku ?? '').toLowerCase().includes(q)}
        onRowClick={canWrite ? (r) => setEditing(r) : undefined}
        toolbar={
          <select className="input w-auto!" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
            <option value="">כל הקטגוריות</option>
            {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        } />
      {editing && (
        <ProductForm product={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refetch(); }} />
      )}
    </div>
  );
}

function ProductForm({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const { data: categories } = useCategories();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    name: product?.name ?? '', category_id: product?.category_id ?? '', unit: product?.unit ?? 'ק"ג',
    sku: product?.sku ?? '', barcode: product?.barcode ?? '', notes: product?.notes ?? '',
    active: product?.active ?? true, min_stock: product?.min_stock?.toString() ?? '',
  });
  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    if (!f.name.trim()) { toast('שם מוצר הוא שדה חובה', 'error'); return; }
    setBusy(true);
    const row = {
      org_id: profile!.org_id, name: f.name.trim(), category_id: f.category_id || null, unit: f.unit,
      sku: f.sku || null, barcode: f.barcode || null, notes: f.notes || null, active: f.active,
      min_stock: f.min_stock ? Number(f.min_stock) : null,
    };
    const res = product
      ? await supabase.from('products').update(row).eq('id', product.id)
      : await supabase.from('products').insert(row);
    setBusy(false);
    if (res.error) { toast(res.error.message, 'error'); return; }
    toast(product ? 'המוצר עודכן' : 'המוצר נוצר');
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={product ? `עריכת מוצר — ${product.name}` : 'מוצר חדש'}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2"><label className="label">שם המוצר *</label><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div>
          <label className="label">קטגוריה</label>
          <select className="input" value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>
            <option value="">ללא</option>
            {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label className="label">יחידת מידה</label><input className="input" value={f.unit} onChange={(e) => set('unit', e.target.value)} /></div>
        <div><label className="label">מק״ט</label><input className="input" dir="ltr" value={f.sku} onChange={(e) => set('sku', e.target.value)} /></div>
        <div><label className="label">ברקוד</label><input className="input" dir="ltr" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} /></div>
        <div><label className="label">מלאי מינימום (לשימוש עתידי)</label><input type="number" className="input num" value={f.min_stock} onChange={(e) => set('min_stock', e.target.value)} /></div>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} className="rounded" />
            מוצר פעיל
          </label>
        </div>
        <div className="sm:col-span-2"><label className="label">הערות</label><textarea className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" onClick={onClose}>ביטול</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>שמירה</button>
      </div>
    </Modal>
  );
}

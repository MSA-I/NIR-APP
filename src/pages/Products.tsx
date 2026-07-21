import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toHebrewError } from '../lib/errors';
import { Plus, Pencil, Copy, Power } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, Modal, useToast, ErrorNote, SkeletonTable, ConfirmDialog, type Column } from '../components/ui';
import { logAction } from '../lib/audit';
import { useCategories } from './Suppliers';
import type { Product } from '../lib/types';

interface ProductRow extends Product {
  supplierCount?: number;
  bestPrice?: number | null;
}

export default function Products() {
  const { profile } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Product | null | 'new'>(null);
  const [clone, setClone] = useState<Product | null>(null); // "שכפול": prefill without an id
  const [toggleTarget, setToggleTarget] = useState<ProductRow | null>(null);
  const [busyToggle, setBusyToggle] = useState(false);
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

  // Open the product editor straight from a global-search result (?id=). Read-only roles never
  // reach this route, but guard on canWrite anyway; clear the param once consumed.
  useEffect(() => {
    const id = params.get('id');
    if (!id || !data || !canWrite) return;
    const row = data.find((p) => p.id === id);
    if (row) setEditing(row);
    const next = new URLSearchParams(params);
    next.delete('id');
    setParams(next, { replace: true });
  }, [params, data, canWrite, setParams]);

  // Deactivation hides the product from new orders — not a financial delete, but it is a
  // reversible business claim, so deactivating requires a reason for the audit log;
  // reactivating takes an optional-free confirm. Both log to audit_logs.
  async function toggleActive(reason?: string) {
    if (!toggleTarget) return;
    const next = !toggleTarget.active;
    setBusyToggle(true);
    const res = await supabase.from('products').update({ active: next }).eq('id', toggleTarget.id);
    setBusyToggle(false);
    if (res.error) { setToggleTarget(null); toast(toHebrewError(res.error.message), 'error'); return; }
    await logAction({
      orgId: toggleTarget.org_id, action: next ? 'product_activated' : 'product_deactivated',
      entityType: 'products', entityId: toggleTarget.id, reason,
    });
    setToggleTarget(null);
    toast(next ? 'המוצר הופעל' : 'המוצר הושבת');
    void refetch();
  }

  const columns: Column<ProductRow>[] = [
    { key: 'name', header: 'מוצר', sortValue: (r) => r.name, render: (r) => <span className={`font-medium ${r.active ? 'text-ink' : 'text-ink-muted line-through'}`}>{r.name}</span> },
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
        rowActions={canWrite ? (r) => [
          { key: 'edit', label: 'עריכה', icon: Pencil, onSelect: () => setEditing(r) },
          { key: 'duplicate', label: 'שכפול', icon: Copy, onSelect: () => setClone({ ...r, name: `${r.name} (עותק)` }) },
          { key: 'toggle', label: r.active ? 'השבתה' : 'הפעלה', icon: Power, onSelect: () => setToggleTarget(r) },
        ] : undefined}
        toolbar={
          <select className="input w-auto!" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
            <option value="">כל הקטגוריות</option>
            {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        } />
      {(editing || clone) && (
        <ProductForm product={editing && editing !== 'new' ? editing : null} initial={clone ?? undefined}
          onClose={() => { setEditing(null); setClone(null); }}
          onSaved={() => { setEditing(null); setClone(null); void refetch(); }} />
      )}

      <ConfirmDialog open={!!toggleTarget} onClose={() => setToggleTarget(null)}
        onConfirm={(reason) => void toggleActive(reason)}
        title={toggleTarget?.active ? 'השבתת מוצר' : 'הפעלת מוצר'}
        message={toggleTarget?.active
          ? `המוצר ״${toggleTarget?.name}״ לא יופיע יותר בהזמנות חדשות. הפעולה תתועד ביומן הביקורת.`
          : `המוצר ״${toggleTarget?.name}״ יחזור להיות זמין להזמנות. הפעולה תתועד ביומן הביקורת.`}
        confirmLabel={toggleTarget?.active ? 'השבתה' : 'הפעלה'}
        requireReason={!!toggleTarget?.active} busy={busyToggle} />
    </div>
  );
}

function ProductForm({ product, initial, onClose, onSaved }: {
  /** existing row → update; null → insert */
  product: Product | null;
  /** prefill for a NEW product (duplicate flow) — fields only, never an update target */
  initial?: Product;
  onClose: () => void; onSaved: () => void;
}) {
  const { profile } = useAuth();
  const toast = useToast();
  const { data: categories } = useCategories();
  const [busy, setBusy] = useState(false);
  const seed = product ?? initial ?? null;
  const [f, setF] = useState({
    name: seed?.name ?? '', category_id: seed?.category_id ?? '', unit: seed?.unit ?? 'ק"ג',
    sku: seed?.sku ?? '', barcode: seed?.barcode ?? '', notes: seed?.notes ?? '',
    active: seed?.active ?? true, min_stock: seed?.min_stock?.toString() ?? '',
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
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
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
          <label className="flex items-center gap-2 text-sm text-ink-mid">
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

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toHebrewError } from '../lib/errors';
import { Plus, Pencil, Copy, Power, Upload, History } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, Modal, useToast, ErrorNote, PageHeader, SkeletonTable, ConfirmDialog, type Column } from '../components/ui';
import { PriceListUploadModal } from '../components/PriceListUpload';
import { fmtMoneyExact, formatUnit, normalizeUnitInput, productLabel } from '../lib/format';
import { useCategories } from './Suppliers';
import type { Product } from '../lib/types';
import { fetchAll } from '../lib/supabasePaging';
import { ProductNameReview } from './ProductNameReview';

interface ProductRow extends Product {
  supplierCount?: number;
  bestPrice?: number | null;
}

export default function Products() {
  const { profile, organizationAccess } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Product | null | 'new'>(null);
  const [clone, setClone] = useState<Product | null>(null); // "שכפול": prefill without an id
  const [toggleTarget, setToggleTarget] = useState<ProductRow | null>(null);
  const [busyToggle, setBusyToggle] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [catFilter, setCatFilter] = useState('');
  // A mode of this screen, not a route (0149 / defect 16). The naming backlog is a chore that
  // empties itself — a permanent entry on the app's map for a temporary queue is how dead admin
  // screens accumulate, and nobody sends anyone a link to "the naming backlog". Keeping it here
  // also keeps one fetch, one refetch path, and the catalogue one press away for comparison.
  const [reviewMode, setReviewMode] = useState(false);
  /** Ids named through the review queue, so the count stays true without refetching per row. */
  const [namedThisSession, setNamedThisSession] = useState<ReadonlySet<string>>(() => new Set());
  const { data: categories } = useCategories();

  const { data, loading, fetching, error, refetch } = useQuery(async () => {
    const products = await fetchAll<ProductRow>((from, to) => supabase.from('products')
      .select('*, category:categories(id, name)').order('name').order('id').range(from, to));
    const sps = await fetchAll<{ id: string; product_id: string; current_price: number; available: boolean }>((from, to) => supabase.from('supplier_products')
      .select('id, product_id, current_price, available').order('product_id').order('id').range(from, to));
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

  const canWrite = organizationAccess.canWrite && (profile?.role === 'owner' || profile?.role === 'office');
  // Narrower than canWrite: the price-import RPC and the document reservation are owner/office only.
  const canUploadPrices = organizationAccess.canWrite && (profile?.role === 'owner' || profile?.role === 'office');
  const rows = (data ?? []).filter((p) => !catFilter || p.category_id === catFilter);
  // `null`, never an empty array, while the catalogue is unknown: a backlog nobody has counted is
  // not a backlog of zero. The review screen renders that distinction rather than an empty queue.
  const awaitingName = data
    ? data.filter((p) => p.display_name === null && !namedThisSession.has(p.id))
    : null;

  // Leaving the queue is the one place a refetch is worth its cost: the rows named in between are
  // already gone from the queue locally, and a round trip per approval would refetch the whole
  // catalogue plus every supplier price a few hundred times.
  function showCatalogue() {
    setReviewMode(false);
    if (namedThisSession.size > 0) void refetch();
  }

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

  // Activation changes availability for every future order. The RPC owns the row lock, reason
  // and audit record so neither direction can bypass the same business control.
  async function toggleActive(reason?: string) {
    if (!toggleTarget) return;
    const next = !toggleTarget.active;
    setBusyToggle(true);
    const res = await supabase.rpc('set_product_active', {
      p_product_id: toggleTarget.id,
      p_active: next,
      p_reason: reason ?? null,
    });
    setBusyToggle(false);
    if (res.error) { setToggleTarget(null); toast(toHebrewError(res.error.message), 'error'); return; }
    setToggleTarget(null);
    toast(next ? 'המוצר הופעל' : 'המוצר הושבת');
    void refetch();
  }

  const columns: Column<ProductRow>[] = [
    // The catalogue table shows the approved name; the edit modal below goes on showing the raw
    // one, because that is the field it edits and the one matching and the supplier read.
    { key: 'name', header: 'מוצר', sortValue: (r) => productLabel(r), render: (r) => <bdi className={`font-medium ${r.active ? 'text-ink' : 'text-ink-muted line-through'}`}>{productLabel(r)}</bdi> },
    { key: 'cat', header: 'קטגוריה', sortValue: (r) => r.category?.name ?? '', render: (r) => r.category?.name ?? '—' },
    { key: 'unit', header: 'יחידת מידה', render: (r) => formatUnit(r.unit) },
    { key: 'sku', header: 'מק״ט', render: (r) => <span dir="ltr">{r.sku ?? '—'}</span> },
    // Shows 0, not `—`. The dash means "no data"; a product with no supplier is a measured
    // fact and an actionable one — it cannot be ordered. Hiding it behind the same glyph as
    // "unknown" buried the very rows worth looking at.
    { key: 'suppliers', header: 'ספקים', className: 'num', sortValue: (r) => r.supplierCount ?? 0, render: (r) => r.supplierCount ?? 0 },
    {
      key: 'best', header: 'מחיר מיטבי', className: 'num', sortValue: (r) => r.bestPrice ?? 0,
      // The price is exactly the value that invites comparison — it links straight to the
      // cross-supplier view. stopPropagation: the row click underneath opens the edit modal.
      render: (r) => r.bestPrice != null ? (
        <button type="button" className="text-action underline underline-offset-2"
          title={`השוואת מחירי ${productLabel(r)}`}
          onClick={(event) => { event.stopPropagation(); navigate(`/prices?product=${r.id}`); }}>
          {fmtMoneyExact(r.bestPrice)}
        </button>
      ) : fmtMoneyExact(r.bestPrice),
    },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error && !data) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <div className="text-xs text-ink-muted" role="status">מתעדכן…</div>}
      <PageHeader title="מוצרים"
        meta={reviewMode
          ? `${awaitingName ? awaitingName.length : '—'} שמות ממתינים לאישור`
          : `${rows.length} מוצרים בתצוגה`}
        actions={<>
          {/* The same owner/office boundary used by the price-list screen. */}
          {canUploadPrices
            ? <button className="btn-secondary" onClick={() => setUploadOpen(true)}><Upload size={16} /> העלאת מחירון ספק</button>
            : <span className="text-sm text-ink-muted">העלאת מחירונים זמינה לבעלים ולמנהל הרכש בלבד.</span>}
          {canWrite && <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> מוצר חדש</button>}
        </>} />

      {/* Only owner/office can call set_product_display_name (0149), so nobody else is offered a
          queue they cannot act on. The count is a measurement, not a placeholder: `—` when the
          catalogue is unknown, and a real 0 when the work is genuinely finished — the same
          distinction the ספקים column below already draws. */}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="תצוגת מסך המוצרים">
          <button type="button" aria-pressed={!reviewMode} onClick={showCatalogue}
            className={`chip-filter ${reviewMode ? '' : 'chip-filter-active'}`}>קטלוג</button>
          <button type="button" aria-pressed={reviewMode} onClick={() => setReviewMode(true)}
            className={`chip-filter ${reviewMode ? 'chip-filter-active' : ''}`}
            data-testid="name-review-toggle">
            שמות לאישור ({awaitingName ? awaitingName.length : '—'})
          </button>
        </div>
      )}

      {canWrite && reviewMode ? (
        <ProductNameReview queue={awaitingName}
          onApproved={(id) => setNamedThisSession((current) => new Set(current).add(id))} />
      ) : (
        <DataTable rows={rows} columns={columns} searchable
          emptyTitle="אין מוצרים עדיין"
          emptySubtitle={canUploadPrices
            ? 'הדרך המהירה היא העלאת מחירון — הוא יוצר את המוצרים ואת המחירים יחד.'
            : 'הוספת מוצרים והעלאת מחירונים זמינות לבעלים ולמנהל הרכש.'}
          searchFn={(r, q) => (
            // Both names, deliberately. The raw one is what a supplier invoice and an uploaded
            // price list say, so somebody typing what they are holding still finds the row; the
            // approved one is what the table now shows. Searching more can only find more.
            productLabel(r).toLowerCase().includes(q)
            || r.name.toLowerCase().includes(q)
            || (r.sku ?? '').toLowerCase().includes(q)
          )}
          searchLabel="חיפוש במוצרים"
          rowLabel={(r) => `מוצר ${productLabel(r)}`}
          onRowClick={canWrite ? (r) => setEditing(r) : undefined}
          rowActions={canWrite ? (r) => [
            /* G1, finding 19. "האם המחיר של המוצר הזה עלה?" is answered well — a history model with
               a chart — and it lived only at /prices. The screen named after the question had no
               link to it, and `?product=` was already implemented there (PriceLists.tsx:40,:68) with
               exactly one emitter in the entire codebase (Dashboard.tsx:752). Since 18.08.2026 the
               global search product hit also lands on /prices?product= (the comparison), and the
               best-price cell above links there too; this row action stays as the named path. */
            { key: 'prices', label: 'מחירים והיסטוריה', icon: History, onSelect: () => navigate(`/prices?product=${r.id}`) },
            { key: 'edit', label: 'עריכה', icon: Pencil, onSelect: () => setEditing(r) },
            // A copy starts with no canonical name of its own: it is a different product, and the
            // name it will be shown under is a decision nobody has made about it yet.
            { key: 'duplicate', label: 'שכפול', icon: Copy, onSelect: () => setClone({ ...r, name: `${r.name} (עותק)`, display_name: null }) },
            { key: 'toggle', label: r.active ? 'השבתה' : 'הפעלה', icon: Power, onSelect: () => setToggleTarget(r) },
          ] : undefined}
          toolbar={
            <select className="input w-auto!" aria-label="סינון מוצרים לפי קטגוריה" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
              <option value="">כל הקטגוריות</option>
              {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          } />
      )}
      {(editing || clone) && (
        <ProductForm product={editing && editing !== 'new' ? editing : null} initial={clone ?? undefined}
          onClose={() => { setEditing(null); setClone(null); }}
          onSaved={() => { setEditing(null); setClone(null); void refetch(); }} />
      )}
      {uploadOpen && (
        <PriceListUploadModal onClose={() => setUploadOpen(false)} onImported={() => void refetch()} />
      )}

      <ConfirmDialog open={!!toggleTarget} onClose={() => setToggleTarget(null)}
        onConfirm={(reason) => void toggleActive(reason)}
        title={toggleTarget?.active ? 'השבתת מוצר' : 'הפעלת מוצר'}
        message={toggleTarget?.active
          ? `המוצר ״${toggleTarget ? productLabel(toggleTarget) : ''}״ לא יופיע יותר בהזמנות חדשות. הפעולה תתועד ביומן הביקורת.`
          : `המוצר ״${toggleTarget ? productLabel(toggleTarget) : ''}״ יחזור להיות זמין להזמנות. הפעולה תתועד ביומן הביקורת.`}
        confirmLabel={toggleTarget?.active ? 'השבתה' : 'הפעלה'}
        requireReason busy={busyToggle} />
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
      name: f.name.trim(), category_id: f.category_id || null, unit: normalizeUnitInput(f.unit),
      sku: f.sku || null, barcode: f.barcode || null, notes: f.notes || null,
      min_stock: f.min_stock ? Number(f.min_stock) : null,
    };
    const res = product
      ? await supabase.from('products').update(row).eq('id', product.id)
      : await supabase.from('products').insert({ ...row, org_id: profile!.org_id, active: f.active });
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast(product ? 'המוצר עודכן' : 'המוצר נוצר');
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={product ? `עריכת מוצר — ${product.name}` : 'מוצר חדש'} busy={busy} statusMessage={busy ? 'שומר את המוצר' : undefined}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2"><label className="label" htmlFor="product-name">שם המוצר *</label><input id="product-name" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div>
          <label className="label" htmlFor="product-category">קטגוריה</label>
          <select id="product-category" className="input" value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>
            <option value="">ללא</option>
            {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label className="label" htmlFor="product-unit">יחידת מידה</label><input id="product-unit" className="input" value={f.unit} onChange={(e) => set('unit', e.target.value)} /></div>
        <div><label className="label" htmlFor="product-sku">מק״ט</label><input id="product-sku" className="input num" dir="ltr" value={f.sku} onChange={(e) => set('sku', e.target.value)} /></div>
        <div><label className="label" htmlFor="product-barcode">ברקוד</label><input id="product-barcode" className="input num" dir="ltr" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} /></div>
        <div><label className="label" htmlFor="product-min-stock">מלאי מינימום (לשימוש עתידי)</label><input id="product-min-stock" type="number" className="input num" value={f.min_stock} onChange={(e) => set('min_stock', e.target.value)} /></div>
        {!product && <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-sm text-ink-mid">
            <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} className="rounded" />
            מוצר פעיל
          </label>
        </div>}
        <div className="sm:col-span-2"><label className="label" htmlFor="product-notes">הערות</label><textarea id="product-notes" className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>שמירה</button>
      </div>
    </Modal>
  );
}

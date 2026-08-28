import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Plus, Pencil, Copy, Power, Upload, History } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, Modal, useToast, ErrorNote, PageHeader, SkeletonTable, ConfirmDialog, ToggleGroup, ICON, type Column } from '../components/ui';
import { PriceListUploadModal } from '../components/PriceListUpload';
import { fmtMoneyExact, formatUnit, normalizeUnitInput, productLabel } from '../lib/format';
import { useCategories } from './Suppliers';
import type { Product } from '../lib/types';
import { fetchAll } from '../lib/supabasePaging';
import { ProductNameReview } from './ProductNameReview';
import { ProductNameRepairReview, type ProductNameRepairQueue } from './ProductNameRepairReview';

interface ProductRow extends Product {
  supplierCount?: number;
  bestPrice?: number | null;
}

export default function Products() {
  const { errorText, locale, t } = useT();
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
  const [repairMode, setRepairMode] = useState(false);
  /** Ids named through the review queue, so the count stays true without refetching per row. */
  const [namedThisSession, setNamedThisSession] = useState<ReadonlySet<string>>(() => new Set());
  const [repairedThisSession, setRepairedThisSession] = useState<ReadonlySet<string>>(() => new Set());
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
  // The dry run that fills this queue is service_role-only and is triggered out of band, so the
  // ordinary state is "no report was ever produced". `has_dry_run` is what separates that from a
  // finished backlog: without it the chip below asserted `(0)` about something nobody measured.
  const { data: repairSummary, error: repairError, refetch: refetchRepair } = useQuery(async () => {
    if (!canWrite) return null;
    const result = await supabase.rpc('get_product_name_repair_queue');
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? null) as ProductNameRepairQueue | null;
  }, [canWrite]);
  const rows = (data ?? []).filter((p) => !catFilter || p.category_id === catFilter);
  // `null`, never an empty array, while the catalogue is unknown: a backlog nobody has counted is
  // not a backlog of zero. The review screen renders that distinction rather than an empty queue.
  const awaitingName = data
    ? data.filter((p) => p.display_name === null && !namedThisSession.has(p.id))
    : null;
  // Three states, three different sentences: unknown (not loaded), never measured (no dry-run
  // report exists), and measured (a real count, `0` included).
  const repairMeasured = repairSummary ? repairSummary.has_dry_run : null;
  const awaitingRepair = repairSummary
    ? repairSummary.candidates.filter((candidate) => !repairedThisSession.has(candidate.candidate_id))
    : null;
  const repairCount = repairMeasured && awaitingRepair ? awaitingRepair.length : null;

  // Leaving the queue is the one place a refetch is worth its cost: the rows named in between are
  // already gone from the queue locally, and a round trip per approval would refetch the whole
  // catalogue plus every supplier price a few hundred times.
  function showCatalogue() {
    setReviewMode(false);
    setRepairMode(false);
    if (namedThisSession.size > 0) void refetch();
    if (repairedThisSession.size > 0) {
      void refetch();
      void refetchRepair();
    }
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
    if (res.error) { setToggleTarget(null); toast(errorText(res.error.message), 'error'); return; }
    setToggleTarget(null);
    toast(next ? t('products.toast') : t('products.toast_2'));
    void refetch();
  }

  const columns: Column<ProductRow>[] = [
    // The catalogue table shows the approved name; the edit modal below goes on showing the raw
    // one, because that is the field it edits and the one matching and the supplier read.
    { key: 'name', header: t('products.columnName'), sortValue: (r) => productLabel(r), render: (r) => <bdi className={`font-medium ${r.active ? 'text-ink' : 'text-ink-muted line-through'}`}>{productLabel(r)}</bdi> },
    { key: 'cat', header: t('products.text'), sortValue: (r) => r.category?.name ?? '', render: (r) => r.category?.name ?? '—' },
    { key: 'unit', header: t('products.formatUnit'), render: (r) => formatUnit(r.unit, locale) },
    { key: 'sku', header: t('products.text_2'), render: (r) => <span dir="ltr">{r.sku ?? '—'}</span> },
    // Shows 0, not `—`. The dash means "no data"; a product with no supplier is a measured
    // fact and an actionable one — it cannot be ordered. Hiding it behind the same glyph as
    // "unknown" buried the very rows worth looking at.
    { key: 'suppliers', header: t('products.text_3'), className: 'num', sortValue: (r) => r.supplierCount ?? 0, render: (r) => r.supplierCount ?? 0 },
    {
      key: 'best', header: t('products.text_4'), className: 'num', sortValue: (r) => r.bestPrice ?? 0,
      // The price is exactly the value that invites comparison — it links straight to the
      // cross-supplier view. stopPropagation: the row click underneath opens the edit modal.
      render: (r) => r.bestPrice != null ? (
        <button type="button" className="text-action underline underline-offset-2"
          title={t('products.comparePricesTitle', { product: productLabel(r) })}
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
      {fetching && data && <div className="text-xs text-ink-muted" role="status">{t('products.text_5')}</div>}
      <PageHeader title={t('products.title')}
        meta={repairMode
          // #250: a dry run is a safety measure, never an approval gate. This queue is a list of
          // names a person has to approve one by one, so it is named after that — the term
          // „dry-run" stays with the report that produced it.
          ? repairMeasured === false
            ? t('products.text_6')
            : t('products.namesAwaitingRepair', { count: repairCount ?? '—' })
          : reviewMode
          ? t('products.namesAwaitingApproval', { count: awaitingName ? awaitingName.length : '—' })
          : t('products.productsShown', { count: rows.length })}
        actions={<>
          {/* The same owner/office boundary used by the price-list screen. */}
          {canUploadPrices
            ? <button className="btn-secondary" onClick={() => setUploadOpen(true)}><Upload size={ICON.sm} aria-hidden="true" /> {t('products.setUploadOpen')}</button>
            : <span className="text-sm text-ink-muted">{t('products.text_7')}</span>}
          {canWrite && <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={ICON.sm} aria-hidden="true" /> {t('products.setEditing')}</button>}
        </>} />

      {/* Only owner/office can call set_product_display_name (0149), so nobody else is offered a
          queue they cannot act on. The count is a measurement, not a placeholder: `—` when the
          catalogue is unknown, and a real 0 when the work is genuinely finished — the same
          distinction the ספקים column below already draws. */}
      {canWrite && (
        <ToggleGroup label={t('products.label')}
          value={reviewMode ? 'review' : repairMode ? 'repair' : 'catalogue'}
          onChange={(mode) => {
            if (mode === 'review') { setReviewMode(true); setRepairMode(false); return; }
            if (mode === 'repair') { setRepairMode(true); setReviewMode(false); return; }
            showCatalogue();
          }}
          items={[
            { key: 'catalogue', label: t('products.text_8') },
            { key: 'review', label: t('products.tabNamesForApproval', { count: awaitingName ? awaitingName.length : '—' }), testId: 'name-review-toggle' },
            { key: 'repair', label: t('products.tabRepairFromSource', { count: repairCount ?? '—' }), testId: 'source-name-repair-toggle' },
          ]} />
      )}

      {repairError && repairMode && <ErrorNote message={repairError} />}
      {canWrite && repairMode ? (
        <ProductNameRepairReview queue={awaitingRepair} dryRunProduced={repairMeasured}
          onApplied={(id) => setRepairedThisSession((current) => new Set(current).add(id))} />
      ) : canWrite && reviewMode ? (
        <ProductNameReview queue={awaitingName}
          onApproved={(id) => setNamedThisSession((current) => new Set(current).add(id))} />
      ) : (
        <DataTable rows={rows} columns={columns} searchable
          emptyTitle={t('products.emptyTitle')}
          emptySubtitle={canUploadPrices
            ? t('products.text_9')
            : t('products.text_10')}
          searchFn={(r, q) => (
            // Both names, deliberately. The raw one is what a supplier invoice and an uploaded
            // price list say, so somebody typing what they are holding still finds the row; the
            // approved one is what the table now shows. Searching more can only find more.
            productLabel(r).toLowerCase().includes(q)
            || r.name.toLowerCase().includes(q)
            || (r.sku ?? '').toLowerCase().includes(q)
          )}
          searchLabel={t('products.searchLabel')}
          rowLabel={(r) => t('products.rowLabel', { product: productLabel(r) })}
          onRowClick={canWrite ? (r) => setEditing(r) : undefined}
          rowActions={canWrite ? (r) => [
            /* G1, finding 19. "האם המחיר של המוצר הזה עלה?" is answered well — a history model with
               a chart — and it lived only at /prices. The screen named after the question had no
               link to it, and `?product=` was already implemented there (PriceLists.tsx:40,:68) with
               exactly one emitter in the entire codebase (Dashboard.tsx:752). Since 18.08.2026 the
               global search product hit also lands on /prices?product= (the comparison), and the
               best-price cell above links there too; this row action stays as the named path. */
            { key: 'prices', label: t('products.actionPrices'), icon: History, onSelect: () => navigate(`/prices?product=${r.id}`) },
            { key: 'edit', label: t('products.setEditing_2'), icon: Pencil, onSelect: () => setEditing(r) },
            // A copy starts with no canonical name of its own: it is a different product, and the
            // name it will be shown under is a decision nobody has made about it yet.
            // The suffix stays HEBREW while every label around it translates, and that is the
            // protected-class rule rather than an oversight: this string is not shown and then
            // discarded, it is prefilled into `products.name` and saved. The catalogue's words
            // are the business's own — `name_match_key` is built on them — and an English suffix
            // on a Hebrew product name would put two languages inside one catalogue row.
            { key: 'duplicate', label: t('products.actionDuplicate'), icon: Copy, onSelect: () => setClone({ ...r, name: `${r.name} (עותק)`, display_name: null }) },
            { key: 'toggle', label: r.active ? t('products.setToggleTarget') : t('products.setToggleTarget_2'), icon: Power, onSelect: () => setToggleTarget(r) },
          ] : undefined}
          toolbar={
            <select className="input w-auto!" aria-label={t('products.aria_label')} value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
              <option value="">{t('products.text_11')}</option>
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
        title={toggleTarget?.active ? t('products.text_12') : t('products.text_13')}
        message={toggleTarget?.active
          ? t('products.deactivateConfirm', { product: toggleTarget ? productLabel(toggleTarget) : '' })
          : t('products.reactivateConfirm', { product: toggleTarget ? productLabel(toggleTarget) : '' })}
        confirmLabel={toggleTarget?.active ? t('products.text_14') : t('products.text_15')}
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
  const { errorText, t } = useT();
  const { profile } = useAuth();
  const toast = useToast();
  const { data: categories } = useCategories();
  const [busy, setBusy] = useState(false);
  const seed = product ?? initial ?? null;
  const [f, setF] = useState({
    // `'ק"ג'` is the stored default for a new product, not a label: `products.unit` stays
    // Hebrew by owner decision #282, and `formatUnit` is what turns it into `kg` on screen.
    name: seed?.name ?? '', category_id: seed?.category_id ?? '', unit: seed?.unit ?? 'ק"ג',
    sku: seed?.sku ?? '', barcode: seed?.barcode ?? '', notes: seed?.notes ?? '',
    active: seed?.active ?? true, min_stock: seed?.min_stock?.toString() ?? '',
  });
  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    if (!f.name.trim()) { toast(t('products.trim'), 'error'); return; }
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
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    toast(product ? t('products.toast_3') : t('products.toast_4'));
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={product ? t('products.editTitle', { product: product.name }) : t('products.newTitle')} busy={busy} statusMessage={busy ? t('products.savingProduct') : undefined}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2"><label className="label" htmlFor="product-name">{t('products.set')}</label><input id="product-name" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div>
          <label className="label" htmlFor="product-category">{t('products.text_17')}</label>
          <select id="product-category" className="input" value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>
            <option value="">{t('products.text_18')}</option>
            {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label className="label" htmlFor="product-unit">{t('products.set_2')}</label><input id="product-unit" className="input" value={f.unit} onChange={(e) => set('unit', e.target.value)} /></div>
        <div><label className="label" htmlFor="product-sku">{t('products.set_3')}</label><input id="product-sku" className="input num" dir="ltr" value={f.sku} onChange={(e) => set('sku', e.target.value)} /></div>
        <div><label className="label" htmlFor="product-barcode">{t('products.set_4')}</label><input id="product-barcode" className="input num" dir="ltr" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} /></div>
        <div><label className="label" htmlFor="product-min-stock">{t('products.set_5')}</label><input id="product-min-stock" type="number" className="input num" value={f.min_stock} onChange={(e) => set('min_stock', e.target.value)} /></div>
        {!product && <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-sm text-ink-mid">
            <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} className="rounded" />
            {t('products.text_19')}
          </label>
        </div>}
        <div className="sm:col-span-2"><label className="label" htmlFor="product-notes">{t('products.set_6')}</label><textarea id="product-notes" className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>{t('products.text_20')}</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>{t('products.save')}</button>
      </div>
    </Modal>
  );
}

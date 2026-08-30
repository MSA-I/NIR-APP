import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toHebrewError } from '../lib/errors';
import { Plus, Pencil, Copy, Power, Upload, History } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { reasonOr } from '../lib/reason';
import { useAuth } from '../auth/AuthContext';
import { DataTable, Modal, useToast, ErrorNote, PageHeader, SkeletonTable, ToggleGroup, ICON, type Column } from '../components/ui';
import { PriceListUploadModal } from '../components/PriceListUpload';
import { fmtMoneyExact, formatUnit, normalizeUnitInput, productLabel } from '../lib/format';
import { useCategories } from './Suppliers';
import type { Product } from '../lib/types';
import { fetchAll } from '../lib/supabasePaging';
import { ProductNameReview } from './ProductNameReview';
import { ProductNameRepairReview, type ProductNameRepairQueue } from './ProductNameRepairReview';

interface ProductRow extends Product {
  supplierCount?: number;
  /**
   * The lowest price among this product's available suppliers — and null when they do not all
   * quote in the SAME currency (0217, #277). `Math.min` over 12 and 40 answers 12 whether those
   * are dollars and shekels or the other way round, and a "best price" column that returns the
   * dollar figure because the number is smaller is a recommendation nobody could defend. It is the
   * same rule `purchase_comparison` and `inventory_intelligence` now follow on the server.
   */
  bestPrice?: number | null;
  bestPriceCurrency?: string | null;
  /** True when the offers span currencies, so the column can say why it has no answer. */
  pricesSpanCurrencies?: boolean;
}

export default function Products() {
  const { profile, organizationAccess } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Product | null | 'new'>(null);
  const [clone, setClone] = useState<Product | null>(null); // "שכפול": prefill without an id
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
    const sps = await fetchAll<{ id: string; product_id: string; current_price: number; currency: string; available: boolean }>((from, to) => supabase.from('supplier_products')
      .select('id, product_id, current_price, currency, available').order('product_id').order('id').range(from, to));
    const byProduct = new Map<string, { price: number; currency: string }[]>();
    for (const sp of sps) {
      if (!sp.available) continue;
      const arr = byProduct.get(sp.product_id) ?? [];
      arr.push({ price: sp.current_price, currency: sp.currency });
      byProduct.set(sp.product_id, arr);
    }
    return products.map((p) => {
      const offers = byProduct.get(p.id) ?? [];
      const currencies = new Set(offers.map((offer) => offer.currency));
      const comparable = currencies.size === 1;
      return {
        ...p,
        supplierCount: offers.length,
        bestPrice: offers.length && comparable ? Math.min(...offers.map((offer) => offer.price)) : null,
        bestPriceCurrency: comparable ? offers[0]?.currency ?? null : null,
        pricesSpanCurrencies: currencies.size > 1,
      };
    });
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

  /**
   * Activation changes availability for every future order. The RPC owns the row lock, the reason
   * and the audit record so neither direction can bypass the same business control.
   *
   * There is no confirmation dialog in front of it any more (0225). Asking "are you sure?" before
   * a change that one press puts back is a tax on the ninety-nine cases to catch the one — and it
   * bought nothing here, because the answer to a mis-press is the same RPC with the flag flipped.
   * `set_product_active` answers idempotently when the row already holds the requested value, so a
   * double press of Undo is a no-op rather than a second toggle.
   */
  async function setActive(row: ProductRow, next: boolean, action: string): Promise<boolean> {
    setBusyToggle(true);
    const res = await supabase.rpc('set_product_active', {
      p_product_id: row.id,
      p_active: next,
      // Nobody types a reason for this any more, so the ledger gets a sentence naming the
      // direction. One string for both directions would be false half the time.
      p_reason: reasonOr(null, action),
    });
    setBusyToggle(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return false; }
    void refetch();
    return true;
  }

  async function toggleActive(row: ProductRow) {
    if (busyToggle) return;
    const next = !row.active;
    if (!await setActive(row, next, next ? 'הפעלת מוצר' : 'השבתת מוצר')) return;
    toast(next ? 'המוצר הופעל' : 'המוצר הושבת', 'success', {
      label: 'ביטול הפעולה',
      onAct: () => { void undoToggle(row, next); },
    });
  }

  /**
   * The reversal. It is a second audited write and a second `audit_logs` row on purpose: the
   * ledger should show that the product was disabled and then re-enabled, because that is what
   * happened. Collapsing the pair would make the ledger a summary of intent instead of a record.
   */
  async function undoToggle(row: ProductRow, applied: boolean) {
    if (!await setActive(row, !applied, applied ? 'ביטול הפעלת מוצר' : 'ביטול השבתת מוצר')) return;
    toast(applied ? 'ההפעלה בוטלה — המוצר מושבת' : 'ההשבתה בוטלה — המוצר פעיל');
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
      render: (r) => (r.bestPrice != null ? (
        <button type="button" className="text-action underline underline-offset-2"
          title={`השוואת מחירי ${productLabel(r)}`}
          onClick={(event) => { event.stopPropagation(); navigate(`/prices?product=${r.id}`); }}>
          {fmtMoneyExact(r.bestPrice, r.bestPriceCurrency)}
        </button>
      ) : r.pricesSpanCurrencies ? (
        /* Not "no price" — "no comparable price". The link still opens the comparison, where every
           offer is listed with its own currency and a person can decide. */
        <button type="button" className="text-action underline underline-offset-2"
          title={`השוואת מחירי ${productLabel(r)}`}
          onClick={(event) => { event.stopPropagation(); navigate(`/prices?product=${r.id}`); }}>
          מחירים בכמה מטבעות
        </button>
      ) : '—'),
    },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error && !data) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <div className="text-xs text-ink-muted" role="status">מתעדכן…</div>}
      <PageHeader title="מוצרים"
        meta={repairMode
          // #250: a dry run is a safety measure, never an approval gate. This queue is a list of
          // names a person has to approve one by one, so it is named after that — the term
          // „dry-run" stays with the report that produced it.
          ? repairMeasured === false
            ? 'לא הופק דוח dry-run'
            : `${repairCount ?? '—'} שמות ממתינים לתיקון ממקור`
          : reviewMode
          ? `${awaitingName ? awaitingName.length : '—'} שמות ממתינים לאישור`
          : `${rows.length} מוצרים בתצוגה`}
        actions={<>
          {/* The same owner/office boundary used by the price-list screen. */}
          {canUploadPrices
            ? <button className="btn-secondary" onClick={() => setUploadOpen(true)}><Upload size={ICON.sm} aria-hidden="true" /> העלאת מחירון ספק</button>
            : <span className="text-sm text-ink-muted">העלאת מחירונים זמינה לבעלים ולמנהל הרכש בלבד.</span>}
          {canWrite && <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={ICON.sm} aria-hidden="true" /> מוצר חדש</button>}
        </>} />

      {/* Only owner/office can call set_product_display_name (0149), so nobody else is offered a
          queue they cannot act on. The count is a measurement, not a placeholder: `—` when the
          catalogue is unknown, and a real 0 when the work is genuinely finished — the same
          distinction the ספקים column below already draws. */}
      {canWrite && (
        <ToggleGroup label="תצוגת מסך המוצרים"
          value={reviewMode ? 'review' : repairMode ? 'repair' : 'catalogue'}
          onChange={(mode) => {
            if (mode === 'review') { setReviewMode(true); setRepairMode(false); return; }
            if (mode === 'repair') { setRepairMode(true); setReviewMode(false); return; }
            showCatalogue();
          }}
          items={[
            { key: 'catalogue', label: 'קטלוג' },
            { key: 'review', label: `שמות לאישור (${awaitingName ? awaitingName.length : '—'})`, testId: 'name-review-toggle' },
            { key: 'repair', label: `תיקון ממקור (${repairCount ?? '—'})`, testId: 'source-name-repair-toggle' },
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
            { key: 'toggle', label: r.active ? 'השבתה' : 'הפעלה', icon: Power, onSelect: () => { void toggleActive(r); } },
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

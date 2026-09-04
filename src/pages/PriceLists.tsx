import { useT } from '../lib/i18n/LocaleProvider';
import { INTL_LOCALE, type Locale } from '../lib/i18n/locale';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { reasonOr } from '../lib/reason';
import { useParamState } from '../lib/useParamState';
import { TrendingUp, TrendingDown, Upload, History, Pencil, X, FileCheck2, ScrollText } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, Modal, useToast, ErrorNote, PageHeader, StatusBadge, Note, SkeletonTable, EmptyState, Card, ICON, type Column } from '../components/ui';
import { PriceListUploadModal } from '../components/PriceListUpload';
import { readSheet, matchColumn, mapRows, cellText, skipRow, groupSkipped, type SkippedRow } from '../lib/importSheet';
import { fetchAll } from '../lib/supabasePaging';
import type { TKey } from '../lib/i18n/t';
import { PRICE_REASON_KEYS, parsePrice } from '../lib/price';
import { addCalendarDays, bidiIsolate, fmtDate, fmtMoneyExact, fmtMoneyRounded, formatUnit, productLabel, todayISO, fmtNum } from '../lib/format';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { useChartTheme } from '../lib/theme';
import { PRODUCT_AVAILABILITY } from '../lib/status';
import type { SupplierProduct, Supplier, PriceHistory, SupplierPriceSubmission } from '../lib/types';

type Row = SupplierProduct & {
  supplier: Supplier;
  product: { id: string; name: string; display_name: string | null; unit: string };
};
type ManagerSubmission = SupplierPriceSubmission & { supplier: Pick<Supplier, 'id' | 'name'> };
type ImportReport = { updated: number; created: number; unchanged: number };
/** A previewed row keeps the line it came from, so every later message can name the FILE. */
type ImportPreviewRow = { row: number; supplier: string; product: string; price: number };

const SUBMISSION_STATUS = {
  accepted: { key: 'submission_accepted', tone: 'done' },
  accepted_with_rejections: { key: 'submission_accepted_with_rejections', tone: 'await' },
  rejected: { key: 'submission_rejected', tone: 'alert' },
} as const;

/**
 * The trailing windows `?days=` accepts, as strings because that is what a URL carries.
 * 30 is the one the dashboard tile and `p2_suppliers_with_price_increase_since` both use; 7 and
 * 90 are offered so the reader can widen or narrow without leaving the screen.
 */
const PRICE_WINDOW_DAYS = ['7', '30', '90'] as const;

const monthLabel = (value: string, locale: Locale) => new Intl.DateTimeFormat(INTL_LOCALE[locale], {
  month: 'long', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${value.slice(0, 7)}-01T00:00:00Z`));

export default function PriceLists() {
  const { locale, t } = useT();
  const { profile, organizationAccess } = useAuth();
  const canWrite = organizationAccess.canWrite && (profile?.role === 'owner' || profile?.role === 'office');
  /**
   * "מי שינה את המחיר" lives in יומן עדכון ספקים, and that screen is owner-only — `audit_logs` is
   * owner+accountant while the names it resolves are owner+office. Offering the row action to
   * office would send them to a Guard that turns them away, so the door is shown to the role that
   * can walk through it.
   */
  const canReadSupplierLog = profile?.role === 'owner';
  const navigate = useNavigate();
  const toast = useToast();
  const [supplierFilter, setSupplierFilter] = useState('');
  // '1' via ?increases=1 (from the dashboard price-increase card); re-syncs on navigation.
  const [increasesStr, setIncreasesStr] = useParamState('increases');
  const onlyIncreases = increasesStr === '1';
  /**
   * `?days=30` — how far back a change has to have taken effect to be listed.
   *
   * `?increases=1` on its own asks a question with no clock in it: "is the last recorded change
   * on this row upward". Every screen that COUNTS price rises asks a bounded one — the dashboard
   * tile is labelled "(30 יום)" and fetches thirty days, and `p2_suppliers_with_price_increase_since`
   * bounds `price_effective_date` the same way. So a tile saying "no supplier raised a price"
   * opened a screen headed with every historic rise the catalogue still remembers. This is the
   * missing half of that filter, and it is in the URL for the same reason the others are: the
   * count and the list it opens have to be able to state the same window.
   *
   * Anything outside the offered windows is dropped back to "no window" rather than silently
   * emptying the table — the rule `Inventory` already applies to `?stock=`.
   */
  const [daysStr, setDaysStr] = useParamState('days');
  const windowDays = (PRICE_WINDOW_DAYS as readonly string[]).includes(daysStr) ? daysStr : '';
  const windowFrom = windowDays ? addCalendarDays(todayISO(), -Number(windowDays)) : null;
  // ?product=<product_id> deep-links from a product/supplier card to that one product's prices;
  // coexists with the supplier + increases filters and is cleared from the chip below.
  const [productFilter, setProductFilter] = useParamState('product');
  const [historyFor, setHistoryFor] = useState<Row | null>(null);
  const [editFor, setEditFor] = useState<Row | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [documentOpen, setDocumentOpen] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () =>
    unwrap(await supabase.from('supplier_products')
      .select('*, supplier:suppliers(id, name, status), product:products(id, name, display_name, unit)')
      .order('updated_at', { ascending: false })) as Promise<Row[]>);

  const { data: submissions, loading: submissionsLoading, error: submissionsError } = useQuery(async () => {
    if (!canWrite) return [];
    return unwrap(await supabase.from('supplier_price_submissions')
      .select('*, supplier:suppliers!supplier_price_submissions_supplier_fk(id, name)')
      .order('target_month', { ascending: false })
      .order('revision', { ascending: false })
      .limit(50)) as ManagerSubmission[];
  }, [canWrite]);

  const suppliers = useMemo(() => {
    const map = new Map<string, string>();
    data?.forEach((r) => map.set(r.supplier.id, r.supplier.name));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'he'));
  }, [data]);

  // With ?product= this screen IS the cross-supplier comparison (user decision 18.08.2026):
  // cheapest first, the gap to the runner-up named. Computed from rows already in memory —
  // reusing the inventory_intelligence view would add a round trip to derive a min and a delta.
  // The eligibility rule mirrors that view (0102): available, from a supplier still traded with.
  const comparison = useMemo(() => {
    if (!productFilter || !data) return null;
    const productRows = data.filter((r) => r.product_id === productFilter);
    if (!productRows.length) return null;
    const offers = productRows
      .filter((r) => r.available && ['active', 'problematic'].includes(r.supplier.status))
      .sort((a, b) => a.current_price - b.current_price);
    /* A CHEAPEST OFFER EXISTS ONLY INSIDE ONE CURRENCY (0217, #277). Sorting a $12 quote below a
       ₪40 one returns the dollar supplier as cheaper, which is not a smaller price — it is a
       smaller number in a different unit, presented on the screen a person picks a supplier from.
       The same rule the server now applies in `purchase_comparison` and `inventory_intelligence`.
       Every offer stays listed, each with its own currency; only the RANKING is withheld. */
    const offerCurrencies = new Set(offers.map((offer) => offer.currency));
    const comparable = offerCurrencies.size === 1;
    const cheapest = comparable ? offers[0] ?? null : null;
    const next = comparable ? offers[1] ?? null : null;
    return {
      product: productRows[0].product,
      supplierCount: productRows.length,
      spansCurrencies: offerCurrencies.size > 1,
      cheapest,
      delta: cheapest && next ? next.current_price - cheapest.current_price : null,
      deltaPct: cheapest && next && cheapest.current_price > 0
        ? ((next.current_price - cheapest.current_price) / cheapest.current_price) * 100
        : null,
    };
  }, [data, productFilter]);

  const rows = useMemo(() => {
    const filtered = (data ?? []).filter((r) =>
      (!supplierFilter || r.supplier_id === supplierFilter) &&
      (!productFilter || r.product_id === productFilter) &&
      (!onlyIncreases || (r.previous_price != null && r.current_price > r.previous_price)) &&
      // Same column and same comparison the counting definitions use: `price_effective_date`,
      // inclusive of the boundary day.
      (!windowFrom || r.price_effective_date >= windowFrom));
    if (!productFilter) return filtered;
    // Comparison order: offers first, cheapest to dearest; unavailable rows sink to the bottom.
    return [...filtered].sort((a, b) => Number(b.available) - Number(a.available) || a.current_price - b.current_price);
  }, [data, supplierFilter, productFilter, onlyIncreases, windowFrom]);

  const activeProductRow = productFilter ? data?.find((r) => r.product_id === productFilter) : null;
  const activeProductName = activeProductRow ? productLabel(activeProductRow.product) : null;

  const changePct = (r: Row) => r.previous_price ? ((r.current_price - r.previous_price) / r.previous_price) * 100 : 0;

  const columns: Column<Row>[] = [
    { key: 'product', header: t('priceLists.productLabel'), priority: 3, sortValue: (r) => productLabel(r.product), render: (r) => <bdi className="font-medium text-ink">{productLabel(r.product)}</bdi> },
    { key: 'supplier', header: t('priceLists.text'), priority: 3, sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'unit', header: t('priceLists.formatUnit'), priority: 3, render: (r) => formatUnit(r.product.unit, locale) },
    { key: 'price', header: t('priceLists.fmtMoneyExact'), className: 'num', sortValue: (r) => r.current_price, render: (r) => <span className="font-semibold">{fmtMoneyExact(r.current_price, r.currency)}</span> },
    // Comparison-only column: how far each offer stands from the cheapest eligible one.
    ...(productFilter ? [{
      key: 'delta', header: t('priceLists.text_2'), className: 'num',
      render: (r: Row) => {
        const cheapest = comparison?.cheapest;
        if (!cheapest || !r.available) return <span className="text-ink-faint">—</span>;
        if (r.id === cheapest.id) return <StatusBadge meta={{ key: 'priceList_cheapest', tone: 'done' }} />;
        const diff = r.current_price - cheapest.current_price;
        if (diff <= 0) return <span className="text-ink-faint">—</span>;
        const pct = cheapest.current_price > 0 ? (diff / cheapest.current_price) * 100 : null;
        return <span className="text-trend-up-fg">‎+{fmtMoneyExact(diff, r.currency)}{pct != null ? ` (+${pct.toFixed(1)}%)` : ''}</span>;
      },
    } satisfies Column<Row>] : []),
    { key: 'prev', header: t('priceLists.fmtMoneyExact_2'), priority: 3, className: 'num', render: (r) => fmtMoneyExact(r.previous_price, r.currency) },
    {
      key: 'change', header: t('priceLists.text_3'), sortValue: changePct,
      render: (r) => {
        const pct = changePct(r);
        if (!r.previous_price || pct === 0) return <span className="text-ink-faint">—</span>;
        return pct > 0
          ? <span className="inline-flex items-center gap-1 text-trend-up-fg font-medium"><TrendingUp size={ICON.xs} aria-hidden="true" />‎+{pct.toFixed(1)}%</span>
          : <span className="inline-flex items-center gap-1 text-trend-down-fg font-medium"><TrendingDown size={ICON.xs} aria-hidden="true" />‎{pct.toFixed(1)}%</span>;
      },
    },
    { key: 'date', header: t('priceLists.fmtDate'), priority: 2, sortValue: (r) => r.price_effective_date, render: (r) => fmtDate(r.price_effective_date) },
    { key: 'avail', header: t('priceLists.text_4'), priority: 3, render: (r) => <StatusBadge meta={PRODUCT_AVAILABILITY[r.available ? 'available' : 'unavailable']} /> },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <PageHeader title={t('priceLists.title')}
        /* Counted over the ROWS ON SCREEN, not over the whole catalogue — and this line is the
           other half of the `?days=` filter above. „7 התייקרויות" stood in this header whatever
           was filtered below it, so an answer reading "no supplier raised a price this month"
           opened a screen headed with seven of them. A page header describes its page; every
           other list screen here already counts what it is showing (`Orders` names shown and
           total, `PaymentRequests` counts its filtered rows). With no filter on, `rows` IS
           `data` and the numbers are the ones that were always there. */
        meta={t('priceListsTail.meta', {
          priceCount: rows.length,
          increaseCount: rows.filter((row) => row.previous_price != null && row.current_price > row.previous_price).length,
        })}
        actions={canWrite ? (
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => setImportOpen(true)}><Upload size={ICON.sm} aria-hidden="true" /> ייבוא רב־ספקים מ־Excel</button>
            <button data-tour-anchor="prices-upload" className="btn-primary" onClick={() => setDocumentOpen(true)}><Upload size={ICON.sm} aria-hidden="true" /> העלאת מחירון</button>
          </div>
        ) : (
          /* „מנהל רכש”, not „משרד”: PRODUCT.md:13 and status.ts's ROLE_LABEL both name `office`
             that way, and this screen used the other word while the sentence beside it used this
             one. One role, one word. */
          <span className="text-sm text-ink-muted">{t('priceLists.text_5')}</span>
        )} />

      {comparison && (
        <Card as="section" aria-label={t('priceListsTail.comparisonLabel', { product: productLabel(comparison.product) })}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm text-ink-muted">
              <bdi className="text-base font-semibold text-ink">{productLabel(comparison.product)}</bdi>
              {' '}· {formatUnit(comparison.product.unit, locale)} · <span className="num">{comparison.supplierCount}</span>{' '}
              {t('priceListsTail.suppliers')}
            </div>
            {canWrite && <Link className="text-sm text-action underline" to={`/products?id=${comparison.product.id}`}>{t('priceListsTail.editProduct')}</Link>}
          </div>
          <div className="mt-2 text-sm text-ink-body">
            {comparison.spansCurrencies ? (
              <>המוצר מצוטט ביותר ממטבע אחד, ולכן אין הצעה &quot;זולה ביותר&quot;. ההצעות מוצגות למטה, כל אחת במטבע שלה.</>
            ) : comparison.cheapest ? (
              <>
                {t('priceListsTail.cheapest')}{' '}<bdi className="font-medium">{comparison.cheapest.supplier.name}</bdi>
                {' — '}<span className="num font-semibold">{fmtMoneyExact(comparison.cheapest.current_price, comparison.cheapest.currency)}</span>
                {comparison.delta != null && comparison.delta > 0 && (
                  <> {t('priceLists.fmtMoneyExact_3')}<span className="num">{fmtMoneyExact(comparison.delta, comparison.cheapest.currency)}</span>
                    {comparison.deltaPct != null ? ` (${comparison.deltaPct.toFixed(1)}%)` : ''}{' '}
                    {t('priceListsTail.thanNextPrice')}</>
                )}
                {comparison.delta === 0 && <> {t('priceLists.text_6')}</>}
              </>
            ) : (
              // No eligible offer is a fact worth stating, not an empty header.
              <>{t('priceLists.text_7')}</>
            )}
          </div>
        </Card>
      )}
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => (
          // The raw name too: a price list arrives under the supplier's wording, and somebody
          // checking a line against this screen types what the sheet said.
          productLabel(r.product).toLowerCase().includes(q)
          || r.product.name.toLowerCase().includes(q)
          || r.supplier.name.toLowerCase().includes(q)
        )}
        searchLabel={t('priceLists.searchLabel')}
        rowLabel={(r) => t('priceListsTail.rowLabel', { product: productLabel(r.product), supplier: r.supplier.name })}
        mobileTitle={(r) => <><bdi>{productLabel(r.product)}</bdi> · <bdi>{r.supplier.name}</bdi></>}
        mobileTrailing={(r) => <StatusBadge meta={PRODUCT_AVAILABILITY[r.available ? 'available' : 'unavailable']} />}
        rowActions={(r) => [
          { key: 'history', label: t('priceLists.setHistoryFor'), icon: History, onSelect: () => setHistoryFor(r) },
          {
            key: 'log', label: t('priceLists.text_8'), icon: ScrollText, hidden: !canReadSupplierLog,
            onSelect: () => navigate(`/supplier-log?entity=supplier_products&supplier=${r.supplier_id}`),
          },
          { key: 'edit', label: t('priceLists.setEditFor'), icon: Pencil, hidden: !canWrite, onSelect: () => setEditFor(r) },
        ]}
        activeFilters={[supplierFilter, productFilter, onlyIncreases ? '1' : ''].filter(Boolean).length}
        onClearFilters={() => { setSupplierFilter(''); setProductFilter(''); setIncreasesStr(''); }}
        toolbar={
          <>
            {productFilter && (
              <button className="btn-ghost text-sm text-action flex items-center gap-1" onClick={() => setProductFilter('')} title={t('priceLists.title_2')}>
                <X size={ICON.xs} aria-hidden="true" /> {activeProductName ?? t('priceLists.text_9')}
              </button>
            )}
            <select className="input w-auto!" aria-label={t('priceLists.aria_label')} value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
              <option value="">{t('priceLists.text_10')}</option>
              {suppliers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-ink-soft">
              <input type="checkbox" className="rounded" checked={onlyIncreases} onChange={(e) => setIncreasesStr(e.target.checked ? '1' : '')} />
              {t('priceLists.text_11')}
            </label>
            {/* The window the counting screens use, made visible and changeable here so a reader
                who arrives from one of them can see WHICH window produced the number. */}
            <select className="input w-auto!" aria-label={t('priceLists.windowFilterLabel')} value={windowDays}
              onChange={(e) => setDaysStr(e.target.value)}>
              <option value="">{t('priceLists.windowAnyTime')}</option>
              {PRICE_WINDOW_DAYS.map((days) => (
                <option key={days} value={days}>{t('priceLists.windowLastDays', { days })}</option>
              ))}
            </select>
          </>
        }
        emptyTitle={t('priceLists.emptyTitle')}
        emptySubtitle={t('priceLists.emptySubtitle')}
        emptyAction={canWrite && <button className="btn-primary" onClick={() => setDocumentOpen(true)}><Upload size={ICON.sm} aria-hidden="true" /> {t('priceLists.setDocumentOpen_2')}</button>} />

      {canWrite && (
        <section className="card p-4" aria-labelledby="price-submissions-heading">
          <div className="flex items-center gap-2 mb-3">
            <FileCheck2 size={ICON.md} className="text-action" aria-hidden="true" />
            <h2 id="price-submissions-heading" className="section-title">{t('priceLists.text_12')}</h2>
          </div>
          {submissionsLoading ? <p className="text-sm text-ink-muted">{t('priceLists.text_13')}</p>
            : submissionsError ? <ErrorNote message={submissionsError} />
              : submissions?.length ? (
                <div className="divide-y divide-line-soft">
                  {submissions.map((submission) => (
                    <div key={submission.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-medium text-ink"><bdi>{submission.supplier.name}</bdi> · {monthLabel(submission.target_month, locale)} · {t('priceListsTail.version')}{' '}<span className="num">{submission.revision}</span></div>
                        <StatusBadge meta={SUBMISSION_STATUS[submission.status]} />
                      </div>
                      <div className="mt-1 text-sm text-ink-muted break-words">
                        <bdi>{submission.file_name ?? t('priceLists.text_14')}</bdi> · {t('priceListsTail.accepted')}{' '}<span className="num">{submission.accepted_count}</span> {t('priceLists.text_15')} <span className="num">{submission.unchanged_count}</span> {t('priceLists.text_16')} <span className="num">{submission.rejected_count}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : <p className="text-sm text-ink-muted">{t('priceLists.text_17')}</p>}
        </section>
      )}

      {historyFor && <PriceHistoryModal row={historyFor} onClose={() => setHistoryFor(null)} />}
      {editFor && (
        <EditPriceModal row={editFor} onClose={() => setEditFor(null)}
          onSaved={() => { setEditFor(null); toast(t('priceLists.setEditFor_2')); void refetch(); }} />
      )}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void refetch(); }} />}
      {documentOpen && (
        <PriceListUploadModal onClose={() => setDocumentOpen(false)} onImported={() => void refetch()} />
      )}
    </div>
  );
}

function PriceHistoryModal({ row, onClose }: { row: Row; onClose: () => void }) {
  /* One supplier_product, so one currency throughout the chart and the table. A price history row
     carries its own (0217); the row this modal opened on names the one the axis is drawn in. */
  const currency = row.currency;
  const { t } = useT();
  // Hoisted out of the IIFE below (31.08.2026): a hook cannot live inside a JSX callback, and the
  // chart has to re-render on a theme swap or recharts keeps painting the previous palette.
  const theme = useChartTheme();
  const { data } = useQuery<PriceHistory[]>(async () =>
    unwrap(await supabase.from('price_history').select('*').eq('supplier_product_id', row.id).order('effective_date', { ascending: false })), [row.id]);
  return (
    <Modal open onClose={onClose} title={t('priceListsTail.historyTitle', {
      product: bidiIsolate(productLabel(row.product)),
      supplier: bidiIsolate(row.supplier.name),
    })}>
      {data && data.length >= 2 && (() => {
        const asc = [...data].reverse();
        const first = asc[0].price;
        const last = asc[asc.length - 1].price;
        const stroke = last > first ? theme.trendUp : last < first ? theme.trendDown : theme.flat;
        const chartData = asc.map((h) => ({ date: fmtDate(h.effective_date), price: h.price }));
        return (
          <div dir="ltr" className="mb-4 h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: theme.tick, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
                <YAxis tick={{ fill: theme.tick, fontSize: 11 }} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => fmtMoneyRounded(v, currency)} />
                <Tooltip formatter={(v: number) => [fmtMoneyExact(v, currency), t('priceLists.fmtMoneyExact_4')]} />
                <Line type="stepAfter" dataKey="price" stroke={stroke} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        );
      })()}
      {data?.length ? (
        /* Stays a raw <table> rather than a DataTable: it lives inside a Modal, and DataTable
           would add a pagination bar and a column picker to a two-column reading list. What it
           was missing is the rest of the raw-table contract — `.th`/`.td` carry whitespace-nowrap
           globally (index.css), so a table without a scroller widens the document instead of
           scrolling inside itself, and the scroller was reachable by mouse only. */
        <div className="table-scroll overflow-x-auto" tabIndex={0} role="region" aria-label={t('priceLists.aria_label_2')}>
        <table className="w-full">
          <thead className="table-head"><tr><th scope="col" className="th">{t('priceLists.text_18')}</th><th scope="col" className="th">{t('priceLists.text_19')}</th></tr></thead>
          <tbody className="divide-y divide-line-soft">
            {data.map((h) => (
              <tr key={h.id}><td className="td">{fmtDate(h.effective_date)}</td><td className="td num">{fmtMoneyExact(h.price, h.currency)}</td></tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : <EmptyState title={t('priceLists.title_3')} subtitle={t('priceLists.subtitle')} icon={<History size={ICON.hero} />} />}
    </Modal>
  );
}

function EditPriceModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const { errorText, t } = useT();
  const toast = useToast();
  const [price, setPrice] = useState(row.current_price.toString());
  const [date, setDate] = useState(todayISO());
  const [available, setAvailable] = useState(row.available);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    const p = Number(price);
    if (!p || p <= 0) { toast(t('priceLists.toast'), 'error'); return; }
    setBusy(true);
    const upd = await supabase.rpc('set_supplier_product_price', {
      p_supplier_product_id: row.id,
      p_price: p,
      p_effective_date: date,
      p_available: available,
      p_reason: reasonOr(reason, 'עדכון המחיר'),
    });
    if (upd.error) { setBusy(false); toast(errorText(upd.error.message), 'error'); return; }
    setBusy(false);
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={t('priceListsTail.editTitle', {
      product: bidiIsolate(productLabel(row.product)),
      supplier: bidiIsolate(row.supplier.name),
    })} busy={busy} statusMessage={busy ? t('priceListsTail.savingPrice') : undefined}>
      <div className="space-y-4">
        {/* The row already carries its currency and every READ on this screen honours it — the
            table, the trend column, the chart axis and the history table all format from
            `r.currency`. This one label was the exception, and it is the field that WRITES. */}
        <div><label className="label" htmlFor="price-list-price">{`מחיר חדש (${row.currency})`}</label><input id="price-list-price" type="number" step="0.01" className="input num" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
        <div><label className="label" htmlFor="price-list-date">בתוקף מתאריך</label><input id="price-list-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded" checked={available} onChange={(e) => setAvailable(e.target.checked)} /> זמין אצל הספק</label>
        <div><label className="label" htmlFor="price-list-reason">סיבת העדכון (רשות)</label><input id="price-list-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>{t('priceLists.text_20')}</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>{t('priceLists.save')}</button>
      </div>
    </Modal>
  );
}

/**
 * Every row that did not become a price, with the line it occupies in the UPLOADED FILE.
 *
 * `mapRows` has always returned `{valid, skipped}` and has always carried the source line
 * (`importSheet.ts`), and the per-supplier door has always rendered it. This door bound only
 * `valid`, so six of eight rows could vanish with no count, no reason and no panel — one product
 * answering the same question two different ways (`PL-01`). The markup is the sister door's, on
 * purpose: two doors that report a refusal differently are the defect, not the fix.
 */
function SkippedRowsPanel({ skipped }: { skipped: SkippedRow[] }) {
  const { t } = useT();
  if (!skipped.length) return null;
  return (
    <div className="space-y-2">
      <Note tone="await">{t('priceUpload.rowsSkipped', { count: skipped.length })}</Note>
      <details className="text-sm">
        <summary className="link flex min-h-11 cursor-pointer items-center">{t('priceUpload.text_8')}</summary>
        <ul className="mt-2 space-y-1 text-ink-soft">
          {groupSkipped(skipped).map(({ reason: skipReason, rows: skipRows }) => (
            <li key={skipReason}>
              {skipReason}{t('priceUpload.rowsWord')}<span className="num">{skipRows.slice(0, 12).join(', ')}</span>
              {skipRows.length > 12 ? t('priceUpload.andMore', { more: skipRows.length - 12 }) : ''}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** Import price list: expects columns ספק / מוצר / מחיר (or supplier/product/price). */
function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { errorText, t } = useT();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ rows: ImportPreviewRow[]; skipped: SkippedRow[] } | null>(null);
  const [report, setReport] = useState<{ summary: ImportReport; skipped: SkippedRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  async function onFile(file: File) {
    try {
      const sheet = await readSheet(file, t);
      // exact header names only, as before — this screen has no column-mapping step to correct a wrong guess
      const cols = {
        supplier: matchColumn(sheet.headers, ['ספק', 'supplier'], false),
        product: matchColumn(sheet.headers, ['מוצר', 'product'], false),
        price: matchColumn(sheet.headers, ['מחיר', 'price'], false),
      };
      // ONE PARSER, THE SAME ONE THE WRITER USES. This preview used to read the price with
      // `cellNumber`, which deletes every character that is not a digit, a dot or a minus -- so
      // `$12.50` previewed as a plain 12.50 and would have been written in whatever currency the
      // named supplier trades in. This sheet carries many suppliers, so the currency is resolved
      // per row from the supplier the row names; a row naming a supplier this organisation does
      // not have is skipped here rather than at import.
      // PAGED, like every other read of a whole table here (`supabasePaging.ts`). One request
      // stops at PostgREST's page ceiling, so a catalogue past it resolved NOTHING — silently,
      // with an HTTP 200 and no error anywhere. `PL-10`.
      const suppliers = await fetchAll<{ id: string; name: string; default_currency: string }>((from, to) =>
        supabase.from('suppliers').select('id, name, default_currency').is('deleted_at', null)
          .order('id').range(from, to));
      const currencyByName = new Map(suppliers.map((row) => [row.name.trim(), row.default_currency]));
      const codes = new Set(suppliers.map((row) => row.default_currency));
      const { valid, skipped } = mapRows(sheet.rows, (r, rowNumber) => {
        const supplier = cellText(r, cols.supplier);
        const product = cellText(r, cols.product);
        const parsed = parsePrice(cellText(r, cols.price, 64), currencyByName.get(supplier), codes);
        if (!supplier || !product) return skipRow(t('priceLists.skipRow'));
        if (!parsed.ok || parsed.value === null) {
          return skipRow(t(PRICE_REASON_KEYS[parsed.reason ?? 'price_unreadable'] as TKey, {
            currency: parsed.currency ?? '', printed: parsed.printedCurrency ?? '',
          }));
        }
        return { row: rowNumber, supplier, product, price: parsed.value };
      }, t('importSheet.invalidRow'));
      if (!valid.length) { toast(t('priceLists.toast_2'), 'error'); return; }
      setPreview({ rows: valid, skipped });
    } catch (e) {
      toast(e instanceof Error ? e.message : t('priceLists.toast_3'), 'error');
    }
  }

  async function runImport() {
    if (!preview) return;
    setBusy(true);
    try {
      // Both catalogue reads are PAGED, for the reason spelled out at the preview's read above.
      const suppliers = await fetchAll<{ id: string; name: string }>((from, to) =>
        supabase.from('suppliers').select('id, name').order('id').range(from, to));
      // MATCHING, not display: the sheet the user is importing carries the supplier's own wording,
      // and the raw `name` is what that wording was ever compared against. `display_name` is a
      // name we composed, so a row would stop resolving the moment somebody approved one.
      const products = await fetchAll<{ id: string; name: string }>((from, to) =>
        supabase.from('products').select('id, name').order('id').range(from, to));
      // ONE RULE FOR THE WHOLE DOOR, the sister door's rule: a row that cannot be used is reported
      // with the line it occupies in the FILE and the reason it was refused, and every other row
      // is imported. This counter used to be `index + 2` over the ALREADY FILTERED preview, so it
      // named line 3 for a problem on line 9 — and one unresolved row discarded the rows that did
      // resolve along with it. `PL-02`.
      const unresolved: SkippedRow[] = [];
      const rows = preview.rows.flatMap((row) => {
        const supplier = suppliers.find((candidate) => candidate.name.trim() === row.supplier);
        const product = products.find((candidate) => candidate.name.trim() === row.product);
        if (!supplier || !product) {
          unresolved.push({ row: row.row, reason: t('priceListsTail.unresolvedReason') });
          return [];
        }
        return [{ supplier_id: supplier.id, product_id: product.id, price: row.price, available: true }];
      });
      // Nothing resolved: there is no partial import to make, so the file is refused — and the
      // refusal names the source lines rather than positions in a list the reader never saw.
      if (!rows.length) {
        toast(t('priceListsTail.unresolvedRows', {
          rows: unresolved.slice(0, 12).map((entry) => entry.row).join(', '),
        }), 'error');
        return;
      }
      const imported = unwrap(await supabase.rpc('import_supplier_prices', {
        p_rows: rows,
        p_effective_date: todayISO(),
        p_reason: reasonOr(reason, 'ייבוא המחירון'),
      })) as ImportReport;
      setReport({ summary: imported, skipped: [...preview.skipped, ...unresolved] });
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const reportText = report ? t('priceListsTail.importReport', report.summary) : null;

  return (
    <Modal open onClose={onClose} title={t('priceLists.title_4')} wide busy={busy} statusMessage={reportText ?? (busy ? t('priceLists.text_21') : undefined)}>
      {report ? (
        <div className="space-y-4">
          <Note tone="done">{reportText}</Note>
          {/* The completed import accounts for EVERY row that did not become a price — the ones
              the parser refused and the ones the catalogue could not match — each by its line in
              the uploaded file. */}
          <SkippedRowsPanel skipped={report.skipped} />
          <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>{t('priceLists.text_22')}</button></div>
        </div>
      ) : preview ? (
        <div className="space-y-4">
          <div className="text-sm text-ink-soft">{t('priceListsTail.previewSummary', { count: preview.rows.length })}</div>
          <SkippedRowsPanel skipped={preview.skipped} />
          <div className="table-scroll max-h-64 overflow-auto rounded-lg border border-line-soft" tabIndex={0} role="region" aria-label={t('priceLists.aria_label_3')}>
            <table className="w-full">
              <thead className="table-head sticky top-0"><tr><th scope="col" className="th">{t('priceLists.text_23')}</th><th scope="col" className="th">{t('priceLists.text_24')}</th><th scope="col" className="th">{t('priceLists.text_25')}</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {preview.rows.slice(0, 100).map((r, i) => (
                  <tr key={i}><td className="td">{r.supplier}</td><td className="td">{r.product}</td>{/* No currency symbol here on purpose: the sheet has no currency column, the supplier is
                        matched by NAME at import time, and the price is stored in THAT supplier own
                        currency by the server. Printing a symbol this screen guessed would be the
                        silent unit swap the whole campaign removes; the note below says where the
                        currency comes from. */}
                    <td className="td num">{fmtNum(r.price)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div><label className="label" htmlFor="price-list-import-reason">{t('priceLists.setReason_2')}</label><input id="price-list-import-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => setPreview(null)}>{t('priceLists.setPreview')}</button>
            <button className="btn-primary" disabled={busy} onClick={() => void runImport()}>{busy ? t('priceLists.runImport') : t('priceLists.runImport_2')}</button>
          </div>
        </div>
      ) : (
        <div className="text-center py-8">
          <p className="text-sm text-ink-soft mb-4">{t('priceLists.text_26')} <b>{t('priceLists.text_27')}</b>, <b>{t('priceLists.text_28')}</b>, <b>{t('priceLists.text_29')}</b></p>
          <button className="btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={ICON.sm} aria-hidden="true" /> {t('priceLists.click')}</button>
          <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
        </div>
      )}
    </Modal>
  );
}

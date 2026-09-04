import { useT } from '../lib/i18n/LocaleProvider';
import { Star } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { ErrorNote, DataTable, PageHeader, SkeletonTable, ICON, type Column } from '../components/ui';
import { fmtOtdPct, hasReportableOtd, OTD_MIN_SAMPLES, fmtLeadDays, type SupplierMetrics, type ScoreTone } from '../components/supplier-metrics';
import { fmtMoneyExact, fmtNum } from '../lib/format';

/**
 * Supplier-performance KPI page (plan §2.2). The same per-supplier metrics that live on each
 * supplier card, aggregated into one sortable leaderboard so a manager can compare delivery time,
 * on-time rate, price volatility and open issues across all suppliers at once. Read-only.
 */

interface SupplierRow { id: string; name: string; rating: number | null; status: string }
interface Row { id: string; name: string; rating: number | null; m: SupplierMetrics | null }

// The threshold is `hasReportableOtd` and lives in supplier-metrics.tsx, not here (ruling #356):
// the same predicate now chooses the VALUE as well, so a supplier can no longer be greyed as
// "not enough data" while the cell beside the colour still prints the percentage.
function otdTone(m: SupplierMetrics | null): ScoreTone {
  if (!hasReportableOtd(m)) return 'idle';
  if (m.on_time_pct >= 90) return 'done';
  if (m.on_time_pct >= 75) return 'await';
  return 'alert';
}
// Table-cell variant of the tile mapping in supplier-metrics.tsx: idle and info are quieter here
// because a leaderboard cell sits in a dense column, not on its own tile. Values unchanged by the
// 2026-08-02 vocabulary unification — only the keys were renamed.
const toneClass: Record<ScoreTone, string> = {
  idle: 'text-ink-muted', done: 'text-done-fg', await: 'text-await-fg', alert: 'text-alert-fg', info: 'text-ink-body',
};

export default function Analytics() {
  const { locale, t } = useT();
  const { data, loading, error } = useQuery<Row[]>(async () => {
    const [suppliers, metrics] = await Promise.all([
      supabase.from('suppliers').select('id, name, rating, status').is('deleted_at', null).order('name'),
      supabase.from('supplier_metrics').select('*'),
    ]);
    const byId = new Map((unwrap(metrics) as SupplierMetrics[]).map((m) => [m.supplier_id, m]));
    return (unwrap(suppliers) as SupplierRow[])
      .filter((s) => s.status !== 'pending')
      .map((s) => ({ id: s.id, name: s.name, rating: s.rating, m: byId.get(s.id) ?? null }));
  });
  if (loading) return <SkeletonTable cols={7} />;
  if (error) return <ErrorNote message={error} />;
  const rows = data ?? [];

  const columns: Column<Row>[] = [
    { key: 'name', header: t('analytics.supplier'), render: (r) => <span className="font-medium">{r.name}</span>, sortValue: (r) => r.name },
    { key: 'rating', header: t('analytics.rating'), className: 'num', sortValue: (r) => r.rating ?? 0,
      render: (r) => r.rating != null ? <span className="inline-flex items-center gap-1"><Star size={ICON.xs} className="fill-star text-star" aria-hidden="true" />{r.rating}</span> : '—' },
    { key: 'lead', header: t('analytics.leadTime'), className: 'num', sortValue: (r) => r.m?.avg_lead_days ?? Number.MAX_SAFE_INTEGER,
      render: (r) => fmtLeadDays(r.m?.avg_lead_days, locale) },
    // Sorted by the same predicate that decides the value: a supplier the column refuses to rate
    // must not be ordered by the rate it is refusing to print, or the reader gets dashes scattered
    // through the ranking at positions only the hidden number explains. -1 keeps them together at
    // the bottom, which is the convention the other unmeasured columns already use.
    { key: 'otd', header: t('analytics.onTime'), className: 'num',
      sortValue: (r) => (hasReportableOtd(r.m) ? r.m.on_time_pct : -1),
      render: (r) => <span className={toneClass[otdTone(r.m)]}>{fmtOtdPct(r.m)}</span> },
    // A supplier with no supplier_metrics row has no measured counts; rendering 0 would assert
    // "nothing happened" instead of "not measured". Sorting still treats absence as 0 so the
    // unmeasured suppliers group at the bottom rather than scattering.
    { key: 'price', header: t('analytics.priceChanges90'), className: 'num', sortValue: (r) => r.m?.price_changes_window ?? 0,
      render: (r) => fmtNum(r.m?.price_changes_window ?? null) },
    { key: 'exceptions', header: t('analytics.openExceptions'), className: 'num', sortValue: (r) => r.m?.open_exceptions ?? 0,
      render: (r) => fmtNum(r.m?.open_exceptions ?? null) },
    { key: 'credits', header: t('analytics.openCredits'), className: 'num', sortValue: (r) => r.m?.open_credits_amount ?? 0,
      /* 0223: null when the supplier holds open credits in more than one currency — the view
         refuses to add them, and this column has always drawn a dash for a figure it cannot read. */
      render: (r) => (r.m?.open_credits_amount
        ? fmtMoneyExact(r.m.open_credits_amount, r.m.open_credits_currency) : '—') },
  ];

  return (
    <div className="space-y-5">
      {/* The header states the rule and the code enforces it, from the SAME constant. It carried
          "after at least 5 receipts" as a literal while the column printed a figure at one — so
          that sentence was not merely unenforced, it was the clearest evidence of the gap. */}
      <PageHeader title={t('analytics.title')}
        meta={t('analytics.meta', { count: rows.length, min: OTD_MIN_SAMPLES })} />
      <DataTable
        rows={rows}
        columns={columns}
        searchable
        searchFn={(r, q) => r.name.toLowerCase().includes(q)}
        searchLabel={t('analytics.searchLabel')}
        rowLabel={(r) => t('analytics.rowLabel', { name: r.name })}
        emptyTitle={t('analytics.emptyTitle')}
        emptySubtitle={t('analytics.emptySubtitle')}
      />
    </div>
  );
}

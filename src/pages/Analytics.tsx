import { Star } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { PageLoader, ErrorNote, DataTable, type Column } from '../components/ui';
import { fmtPct, fmtLeadDays, type SupplierMetrics, type ScoreTone } from '../components/supplier-metrics';
import { fmtMoney } from '../lib/format';

/**
 * Supplier-performance KPI page (plan §2.2). The same per-supplier metrics that live on each
 * supplier card, aggregated into one sortable leaderboard so a manager can compare delivery time,
 * on-time rate, price volatility and open issues across all suppliers at once. Read-only.
 */

interface SupplierRow { id: string; name: string; rating: number | null; status: string }
interface Row { id: string; name: string; rating: number | null; m: SupplierMetrics | null }

// Mirrors Suppliers.tsx: below 5 samples we cannot claim an on-time rate (slate = "not enough data").
function otdTone(m: SupplierMetrics | null): ScoreTone {
  if (!m || m.on_time_pct == null || m.otd_samples < 5) return 'slate';
  if (m.on_time_pct >= 90) return 'green';
  if (m.on_time_pct >= 75) return 'amber';
  return 'red';
}
const toneClass: Record<ScoreTone, string> = {
  slate: 'text-ink-muted', green: 'text-done-fg', amber: 'text-await-fg', red: 'text-alert-fg', blue: 'text-ink-body',
};

export default function Analytics() {
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
  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;
  const rows = data ?? [];

  const columns: Column<Row>[] = [
    { key: 'name', header: 'ספק', render: (r) => <span className="font-medium">{r.name}</span>, sortValue: (r) => r.name },
    { key: 'rating', header: 'דירוג', className: 'num', sortValue: (r) => r.rating ?? 0,
      render: (r) => r.rating != null ? <span className="inline-flex items-center gap-1"><Star size={13} className="fill-star text-star" />{r.rating}</span> : '—' },
    { key: 'lead', header: 'זמן אספקה', className: 'num', sortValue: (r) => r.m?.avg_lead_days ?? Number.MAX_SAFE_INTEGER,
      render: (r) => fmtLeadDays(r.m?.avg_lead_days) },
    { key: 'otd', header: 'עמידה בזמנים', className: 'num', sortValue: (r) => r.m?.on_time_pct ?? -1,
      render: (r) => <span className={toneClass[otdTone(r.m)]}>{fmtPct(r.m?.on_time_pct)}</span> },
    { key: 'price', header: 'שינויי מחיר (30 יום)', className: 'num', sortValue: (r) => r.m?.price_changes_window ?? 0,
      render: (r) => r.m?.price_changes_window ?? 0 },
    { key: 'exceptions', header: 'חריגים פתוחים', className: 'num', sortValue: (r) => r.m?.open_exceptions ?? 0,
      render: (r) => r.m?.open_exceptions ?? 0 },
    { key: 'credits', header: 'זיכויים פתוחים', className: 'num', sortValue: (r) => r.m?.open_credits_amount ?? 0,
      render: (r) => r.m?.open_credits_amount ? fmtMoney(r.m.open_credits_amount) : '—' },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">ביצועי ספקים</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          דירוג, זמני אספקה, עמידה בזמנים ושינויי מחיר לכל הספקים במקום אחד. עמידה בזמנים דורשת 5 קבלות לפחות לספק, אחרת "—".
        </p>
      </div>
      <DataTable
        rows={rows}
        columns={columns}
        searchable
        searchFn={(r, q) => r.name.toLowerCase().includes(q)}
        searchLabel="חיפוש ספק"
        rowLabel={(r) => `ביצועי ${r.name}`}
        emptyTitle="אין ספקים"
        emptySubtitle="ספקים פעילים יופיעו כאן עם מדדי הביצועים שלהם"
      />
    </div>
  );
}

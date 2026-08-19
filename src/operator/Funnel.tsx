import { useState } from 'react';
import { AlertTriangle, TrendingUp } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import { ErrorNote, Note, PageLoader } from '../components/ui';
import { fmtDateTime, fmtNum } from '../lib/format';
import {
  fetchBillingDeadLetters, fetchFunnelMetrics, fetchMyCapabilities,
  type FunnelMetric, type PlatformCapability,
} from '../lib/platform';

const WINDOWS = [
  { key: '30', label: '30 יום', days: 30 },
  { key: '90', label: '90 יום', days: 90 },
  { key: '365', label: 'שנה', days: 365 },
] as const;

/** A rate is a percentage; everything else is a count or a number of days. */
function metricValue(metric: FunnelMetric): string {
  if (!metric.measured || metric.value === null) return '—';
  if (metric.metric_key.endsWith('_rate')) return `${fmtNum(metric.value)}%`;
  if (metric.metric_key.startsWith('avg_days')) return `${fmtNum(metric.value)} ימים`;
  return fmtNum(metric.value);
}

export default function Funnel() {
  const [windowKey, setWindowKey] = useState('90');
  const days = WINDOWS.find((option) => option.key === windowKey)?.days ?? 90;

  const { data, loading, error } = useQuery(
    async () => {
      const capabilities = await fetchMyCapabilities();
      if (!capabilities.includes('usage.view')) return { capabilities, metrics: [], deadLetters: [] };
      const [metrics, deadLetters] = await Promise.all([
        fetchFunnelMetrics(days),
        capabilities.includes('billing.view') ? fetchBillingDeadLetters() : Promise.resolve([]),
      ]);
      return { capabilities, metrics, deadLetters };
    },
    [windowKey],
  );

  const capabilities: PlatformCapability[] = data?.capabilities ?? [];

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;
  if (!capabilities.includes('usage.view')) {
    return (
      <Note tone="alert">
        <span className="min-w-0 flex-1">
          מסך המשפך פתוח למפעילים בעלי הרשאת צפייה בשימוש. ההרשאה מוקצית מחוץ למוצר.
        </span>
      </Note>
    );
  }

  const metrics = data?.metrics ?? [];
  const deadLetters = data?.deadLetters ?? [];
  const measured = metrics.filter((metric) => metric.measured);
  const unmeasured = metrics.filter((metric) => !metric.measured);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="page-title flex items-center gap-2"><TrendingUp size={22} /> משפך ההצטרפות</h1>
        <div role="group" aria-label="טווח זמן" className="ms-auto flex flex-wrap gap-1">
          {WINDOWS.map((option) => (
            <button key={option.key} type="button" aria-pressed={windowKey === option.key}
              className={windowKey === option.key ? 'chip-filter-active' : 'chip-filter'}
              onClick={() => setWindowKey(option.key)}>
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* An unattributable money event is a work queue, not a statistic, so it sits above the
          numbers — and only when there is one. Nothing renders on a clean day. */}
      {deadLetters.length > 0 && (
        <section className="card card-pad space-y-3" aria-labelledby="dead-letters-heading">
          <h2 id="dead-letters-heading" className="section-title flex items-center gap-2 text-alert-fg">
            <AlertTriangle size={17} /> אירועי חיוב שלא שויכו ללקוח
          </h2>
          <p className="text-sm text-ink-muted">
            אירועים שהגיעו מספק החיוב ולא נמצא להם ארגון מקושר. הם נשמרו ולא בוצעה בהם שום פעולה —
            שיוך נעשה בהוספת מזהה הלקוח אצל הספק לכרטיס הארגון.
          </p>
          <ul className="divide-y divide-line-soft">
            {deadLetters.map((event) => (
              <li key={event.id} className="space-y-0.5 py-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-ink">{event.event_type}</span>
                  <span className="text-ink-muted">{event.provider}</span>
                  {event.provider_customer_id && (
                    <span dir="ltr" className="text-ink-body">{event.provider_customer_id}</span>
                  )}
                  <span className="ms-auto text-xs text-ink-muted">{fmtDateTime(event.received_at)}</span>
                </div>
                <p className="text-sm text-ink-muted">{event.dead_letter_reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card card-pad space-y-3" aria-labelledby="funnel-heading">
        <h2 id="funnel-heading" className="section-title">מדדים</h2>
        <dl className="grid gap-4 sm:grid-cols-3">
          {measured.map((metric) => (
            <div key={metric.metric_key}>
              <dt className="text-xs text-ink-muted">{metric.label}</dt>
              <dd className="mt-0.5 text-lg text-ink num">{metricValue(metric)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Named, not hidden. A stage this system cannot see is a fact about our instrumentation,
          and omitting it invites somebody to fill the gap with a zero later. */}
      {unmeasured.length > 0 && (
        <section className="card card-pad space-y-2" aria-labelledby="unmeasured-heading">
          <h2 id="unmeasured-heading" className="section-title">שלבים שאינם נמדדים</h2>
          <ul className="space-y-1.5">
            {unmeasured.map((metric) => (
              <li key={metric.metric_key} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="text-ink-body">{metric.label}</span>
                <span className="text-ink-muted">—</span>
                {metric.note && <span className="text-xs text-ink-muted">{metric.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

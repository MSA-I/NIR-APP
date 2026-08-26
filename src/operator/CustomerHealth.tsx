import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Card, ICON, StatusBadge } from '../components/ui';
import { fmtDate } from '../lib/format';
import { CUSTOMER_HEALTH } from '../lib/status';
import type { CustomerHealth as Health } from '../lib/platform';

const SEVERITY_ICON = { alert: AlertTriangle, warn: Info, good: CheckCircle2 } as const;
const SEVERITY_CLASS = {
  alert: 'text-alert-fg',
  warn: 'text-await-fg',
  good: 'text-done-fg',
} as const;

/**
 * Health, shown the only way this project allows: the status and the reasons that produced it,
 * side by side.
 *
 * There is no number here on purpose. A score compresses several different problems into one
 * figure an operator cannot act on and cannot argue with, and the brief forbids unsupported
 * predictive claims outright — "72% churn risk" is exactly that. `unknown` is rendered as a real
 * answer rather than as green, because a customer we cannot judge is not a healthy one.
 */
export default function CustomerHealth({ health }: { health: Health | null }) {
  if (!health) return null;

  return (
    <Card className="space-y-3" as="section" aria-labelledby="health-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="health-heading" className="section-title">מצב הלקוח</h2>
        <StatusBadge meta={CUSTOMER_HEALTH[health.status]} />
        {health.last_activity_at && (
          <span className="ms-auto text-xs text-ink-muted">
            פעילות אחרונה {fmtDate(health.last_activity_at)}
          </span>
        )}
      </div>

      {health.signals.length === 0 ? (
        // No signals is not a clean bill of health; it is silence, and the status already says so.
        <p className="text-sm text-ink-muted">
          לא נמצאו סימנים לכאן ולכאן. הסטטוס נגזר מהיעדר נתונים, לא מבדיקה שעברה.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {health.signals.map((signal) => {
            const Icon = SEVERITY_ICON[signal.severity] ?? Info;
            return (
              <li key={signal.code} className="flex items-start gap-2 text-sm">
                <Icon size={ICON.sm} aria-hidden="true"
                  className={`mt-0.5 shrink-0 ${SEVERITY_CLASS[signal.severity] ?? ''}`} />
                <span className="min-w-0 flex-1 text-ink-body">{signal.detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

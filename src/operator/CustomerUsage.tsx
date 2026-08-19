import { fmtDate, fmtNum } from '../lib/format';
import type { UsageRow } from '../lib/platform';

const PERIOD_SOURCE: Record<string, string> = {
  subscription: 'לפי תקופת החיוב שהתקבלה מספק החיוב',
  calendar_month: 'לפי חודש קלנדרי (לא התקבלה תקופת חיוב)',
};

/**
 * The operator's view of what a customer has used against what they are allowed.
 *
 * The whole point of this panel is the `measured` flag. A metric nothing counts shows an em dash
 * and says it is not metered — because "0 של 500" for something we do not measure is a claim
 * about the customer's behaviour made out of our own missing instrumentation, and an operator who
 * acts on it (calls them, offers a downgrade) acts on a number we invented.
 */
export default function CustomerUsage({ rows }: { rows: UsageRow[] }) {
  if (rows.length === 0) return null;
  const period = rows[0];

  return (
    <section className="card card-pad space-y-3" aria-labelledby="usage-heading">
      <div>
        <h2 id="usage-heading" className="section-title">שימוש מול מגבלות</h2>
        {/* Which definition produced the window matters: a counter that resets on a calendar month
            and one that resets on the provider's period are different numbers on the same day. */}
        <p className="mt-1 text-sm text-ink-muted">
          {PERIOD_SOURCE[period.period_source] ?? period.period_source}
          {period.period_end ? ` · עד ${fmtDate(period.period_end)}` : ''}
        </p>
      </div>

      <ul className="divide-y divide-line-soft">
        {rows.map((row) => (
          <li key={row.metric_key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <span className="min-w-40 text-sm text-ink-body">{row.label}</span>
            {row.measured ? (
              <>
                <span className="text-sm text-ink num">
                  {fmtNum(row.used ?? 0)}
                  {row.unlimited ? '' : ` / ${fmtNum(row.usage_limit ?? 0)}`}
                </span>
                {row.unlimited && <span className="badge-idle">ללא הגבלה</span>}
                {row.percent_used !== null && (
                  <span className={row.percent_used >= 100
                    ? 'badge-alert num'
                    : row.percent_used >= 80 ? 'badge-await num' : 'text-xs text-ink-muted num'}>
                    {fmtNum(row.percent_used)}%
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="text-sm text-ink-muted">—</span>
                <span className="text-xs text-ink-muted">
                  {row.measure === 'per_period' ? 'לא הוגדרה מגבלה' : 'אינו נמדד'}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { useT } from '../lib/i18n/LocaleProvider';
import { fmtDate, fmtNum } from '../lib/format';
import { usePlanCatalogue } from '../lib/planLabels';
import { usePlanEntitlements, type PlanEntitlementRow } from '../lib/planEntitlements';
import { useOrgScope } from '../lib/query/orgScope';
import { usageSnapshotQuery, type UsageRow } from './PlanLimitNote';
import { ErrorNote, ICON, Skeleton } from './ui';

/**
 * The meter the subscription screen has been promising.
 *
 * WHY IT EXISTS. `/settings/subscription` prints, from the route catalogue, three promises — the
 * plan the business is on, what each plan includes, and how much of the period's quota is gone —
 * and until now answered the first two. `OWN-06`: there was no consumption figure anywhere in the
 * page text, and the organisation the sweep measured sits on a retired rung that appears on none of
 * the five cards, so it could not see what its OWN plan covers either. `ASSIST-03` is the same hole
 * seen from the other end: the assistant is metered at tens of questions per period and its number
 * appeared nowhere in the product, so the only sentence anybody ever read about it was the refusal.
 *
 * IT ASKS THE SERVER FOR NOTHING NEW. Both reads already exist, are already granted to
 * `authenticated`, and are already fetched on this screen or beside it:
 *
 *   * `organization_usage_snapshot()` (0155) — the caller's own usage against their own limits,
 *     one row per numeric entitlement, with the usage period's own boundary. `PlanLimitNote` and
 *     the cancellation dialog share the cache key, so mounting this costs at most one request.
 *   * `my_entitlements()` (0154/0285) — what this organisation is ACTUALLY entitled to, resolved
 *     override over plan over nothing. That is the only source that can describe a rung with no
 *     card, which is why the second promise is answered from there and not from the ladder.
 *
 * THE TWO LISTS ANSWER DIFFERENT QUESTIONS and are not folded together. The first is "how much of
 * this period is gone", and it only has an answer for metrics counted per period. The second is
 * "what do I get", which includes capabilities and ceilings nothing counts. A single merged table
 * would have to invent a consumption figure for the second kind, and inventing a zero there is the
 * exact failure the constitution names.
 *
 * EM DASH, NEVER ZERO. `measured: false` means the entitlement is not stated or nothing counts it —
 * a fact about our configuration, not about the customer's behaviour. `fmtNum(null)` renders the
 * dash and every unmeasured slot goes through it. The assistant on a retired rung is the live
 * example: questions genuinely counted this period against a ceiling nobody stated, so the count is
 * printed and the ceiling is a dash.
 *
 * WHAT THIS PANEL STILL CANNOT SAY, stated here rather than left to be discovered. While an
 * introductory window is open, the ceiling that actually binds the assistant comes from
 * `private.assistant_effective_quota()`, and no read model publishes it —
 * `organization_usage_snapshot` resolves through `effective_entitlement`, which sees the
 * introductory allowance only for an organisation on the free rung. On any other rung this panel
 * shows the plan's figure while the introductory allowance is what refuses. That divergence is
 * `ASSIST-10`'s mechanism and it closes with its migration, not here.
 */
export function PlanUsagePanel() {
  const { t } = useT();
  const { quotaName } = usePlanCatalogue();
  const org = useOrgScope();
  /**
   * `org !== null` for the same reason `PlanLimitNote` and `PlanBadge` carry it: these are tenant
   * resolvers that `anon` holds no EXECUTE on, and asking before AuthProvider has an organisation
   * leaves an anonymous request that can only come back 502.
   */
  const usageQuery = useQuery({ ...usageSnapshotQuery(org), enabled: org !== null });
  const entitlementsQuery = usePlanEntitlements(org !== null);

  const usage = usageQuery.data ?? [];
  const entitlements = entitlementsQuery.data ?? [];
  const loading = org !== null && (usageQuery.isLoading || entitlementsQuery.isLoading);
  const failed = !!(usageQuery.error || entitlementsQuery.error);

  /**
   * Only metrics the period actually counts. `private.usage_rows` reports `used` for
   * `measure = 'per_period'` and null for everything else, so a concurrent ceiling such as the
   * active-user maximum has no consumption to state and belongs in the second list, not this one.
   */
  const periodRows = usage.filter((row) => row.used !== null);
  /** The period boundary is the server's; this component never computes a month. */
  const periodEnd = usage.find((row) => row.period_end !== null)?.period_end ?? null;

  /** A numeric entitlement prints its ceiling, a capability prints whether it is in — neither guesses. */
  const entitlementValue = (row: PlanEntitlementRow): string => {
    if (!row.measured) return fmtNum(null);
    if (row.kind === 'boolean') {
      return row.boolean_value ? t('planUsage.included') : t('planUsage.notIncluded');
    }
    if (row.unlimited) return t('planUsage.unlimited');
    return fmtNum(row.numeric_limit);
  };

  return (
    <section className="card card-pad space-y-5" aria-labelledby="plan-usage-heading">
      <div className="space-y-1">
        <h2 id="plan-usage-heading" className="section-title flex items-center gap-2">
          <Gauge size={ICON.md} /> {t('planUsage.heading')}
        </h2>
        {periodEnd && (
          <p className="text-sm text-ink-muted" data-testid="plan-usage-period">
            {t('planUsage.periodEnds', { date: fmtDate(periodEnd) })}
          </p>
        )}
      </div>

      {failed && <ErrorNote message={t('planUsage.readFailed')} />}

      {loading && (
        <div role="status" aria-busy="true" className="space-y-2">
          <span className="sr-only">{t('planUsage.loading')}</span>
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-52" />
        </div>
      )}

      {!loading && !failed && (
        <>
          {periodRows.length === 0 ? (
            <p className="text-sm text-ink-muted" data-testid="plan-usage-empty">
              {t('planUsage.nothingCounted')}
            </p>
          ) : (
            <ul data-testid="period-usage" className="space-y-2">
              {periodRows.map((row) => (
                <UsageLine key={row.metric_key} row={row}
                  label={quotaName(row.metric_key, row.label)} />
              ))}
            </ul>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-ink-body">{t('planUsage.includedHeading')}</h3>
            {entitlements.length === 0 ? (
              <p className="text-sm text-ink-muted" data-testid="plan-includes-empty">
                {t('planUsage.includedUnavailable')}
              </p>
            ) : (
              <ul data-testid="current-plan-includes" className="space-y-1">
                {entitlements.map((row) => (
                  <li key={row.entitlement_key}
                    data-testid={`plan-includes-${row.entitlement_key}`}
                    className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="min-w-40 text-ink-body">
                      {quotaName(row.entitlement_key, row.label)}
                    </span>
                    <span className="num text-ink">{entitlementValue(row)}</span>
                    {/* A ceiling this organisation was given by hand is a different fact from the
                        rung's own, and the operator's remedy stays invisible unless it is said. */}
                    {row.measured && row.source === 'override' && (
                      <span className="text-xs text-ink-muted">{t('planUsage.fromOverride')}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * One period metric. The count is printed whenever the period counted it, and the ceiling only when
 * the server states one — so an unmeasured ceiling reads as the count beside a dash rather than
 * being suppressed. Suppressing the row would hide a real consumption figure behind a configuration
 * gap, which is the wrong direction: the customer's own number is theirs to see.
 */
function UsageLine({ row, label }: { row: UsageRow; label: string }) {
  const { t } = useT();
  return (
    <li data-testid={`period-usage-${row.metric_key}`}
      className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="min-w-40 text-ink-body">{label}</span>
      <span className="num font-medium text-ink">{fmtNum(row.used)}</span>
      <span className="text-ink-muted">{t('planUsage.outOf')}</span>
      <span className="num text-ink">
        {row.unlimited ? t('planUsage.unlimited') : fmtNum(row.measured ? row.usage_limit : null)}
      </span>
    </li>
  );
}

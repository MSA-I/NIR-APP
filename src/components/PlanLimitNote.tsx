import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { fmtDate, fmtNum } from '../lib/format';
import { DOMAIN, key } from '../lib/query/keys';
import { useOrgScope } from '../lib/query/orgScope';
import { Note } from './ui';

/**
 * The tenant-facing side of a plan limit — shown ONLY on the screen whose action is about to be
 * refused, and only when there is something true to say.
 *
 * The rules this component exists to keep:
 *   * Silence below the first decided threshold. OPEN-DECISIONS #202 names 60% / 80% / 100%; a
 *     banner that is always there is decoration, and decoration about money reads as pressure.
 *   * FACTS ONLY at all three thresholds. #202 forbids a personal plan recommendation and forbids
 *     a judgemental saving-versus-price comparison. The number is the number.
 *   * Over quota, ONLY NEW PROCESSING STOPS. Nothing is deleted and nothing already done is
 *     blocked retroactively (#202, #204). The note says both halves, because a customer who is
 *     refused an upload will otherwise assume the worse one.
 *   * The period is the USAGE period, never the billing period. #242 anchors usage immutably to
 *     the organization's signup timestamp, and payment, renewal, tier change, cancellation and
 *     refund all leave it alone. The two periods are separate facts and calling one by the
 *     other's name would be a lie about when the customer gets capacity back. The boundary comes
 *     from the server; this component never computes a month.
 *   * The two refusals are different sentences. "You have used your quota" is about the customer;
 *     "no quota has been configured" is about us, and must not be dressed up as a reason to buy.
 *     An unmeasured limit renders `—`, never `0` — zero is also a claim about reality.
 */
export interface UsageRow {
  metric_key: string;
  label: string;
  used: number | null;
  usage_limit: number | null;
  unlimited: boolean;
  measured: boolean;
  remaining: number | null;
  percent_used: number | null;
  period_end: string | null;
}

/**
 * The shared cache key for `organization_usage_snapshot()`, and the reason this component and the
 * plans panel now agree on one.
 *
 * ADR-0003 opens with this exact duplicate as its motivating example, and `/settings/subscription`
 * was still shipping it: the screen mounts this note and `OrgSubscriptionPanel` side by side, and
 * each fired its own `useEffect` copy of the same RPC. One key, one request — the second mount is
 * served from the cache rather than from the network.
 *
 * Exported so the panel builds the identical key. A key that is merely "the same shape" in two
 * files is a key that drifts, and a drifted key is a silent second request that nobody notices
 * because both screens still look right.
 */
export const usageSnapshotKey = (org: string | null) => key(org, DOMAIN.subscription, 'usage');

const fetchUsageSnapshot = async (): Promise<UsageRow[]> => {
  const { data, error } = await supabase.rpc('organization_usage_snapshot');
  if (error) throw new Error(error.message);
  return (data ?? []) as UsageRow[];
};

/**
 * The fetcher, shared with the panel for the same reason the key is. Kept beside the key so the
 * two cannot be paired wrongly.
 */
export const usageSnapshotQuery = (org: string | null) => ({
  queryKey: usageSnapshotKey(org),
  queryFn: fetchUsageSnapshot,
});

/**
 * #202's thresholds, in the order they are crossed. The lowest is the point at which the note
 * starts speaking; the list is kept whole so the decision is legible here rather than hidden in a
 * comparison.
 */
const THRESHOLDS = [60, 80, 100] as const;
const FIRST_THRESHOLD = THRESHOLDS[0];

export function PlanLimitNote({ metricKey }: { metricKey: string }) {
  const org = useOrgScope();
  // `null` is the pre-bootstrap and suspended scope. `organization_usage_snapshot` is a tenant
  // resolver `anon` holds no EXECUTE on, and calling it before AuthProvider has an organisation
  // leaves an anonymous request that can only come back 502 — the same lesson `PlanBadge` and
  // `useFeatureFlags` already carry, applied here rather than relearned.
  const { data } = useQuery({ ...usageSnapshotQuery(org), enabled: org !== null });
  const row = data?.find((entry) => entry.metric_key === metricKey) ?? null;

  // No banner while it loads and none if the read fails: this component's whole contract is that it
  // speaks only when there is something true to say, and a skeleton for a note that is usually
  // absent would be a permanent grey box on every documents screen.
  if (!row) return null;

  // An unmeasured limit is a configuration gap on our side. The customer is told the action will
  // be refused and who to ask — not offered an upgrade for a number nobody set.
  if (!row.measured) {
    if (row.unlimited) return null;
    return (
      <Note tone="alert">
        <span className="min-w-0 flex-1">
          מכסת {row.label} למסלול של הארגון מוצגת כ<span className="text-ink-muted">—</span> משום
          שלא נקבעה לה מגבלה, ולכן עיבוד חדש ייעצר. זו הגדרה במערכת — יש לפנות לתמיכה.
        </span>
      </Note>
    );
  }

  if (row.unlimited || row.usage_limit === null || row.percent_used === null) return null;
  if (row.percent_used < FIRST_THRESHOLD) return null;

  const exhausted = (row.remaining ?? 0) <= 0;
  const until = row.period_end ? ` ומסתיימת ב־${fmtDate(row.period_end)}` : '';

  return (
    // Below the ceiling this is a statement with no claim attached, and `idle` is the tone for
    // exactly that. At the ceiling new work is refused, which is a real exception — `alert`.
    // Using `await` at 80% would assert "this needs your attention", and #202 allows only facts.
    <Note tone={exhausted ? 'alert' : 'idle'}>
      <span className="min-w-0 flex-1">
        {exhausted
          ? `נוצלה מלוא מכסת ${row.label} בתקופת השימוש הנוכחית (${fmtNum(row.used)} מתוך ${fmtNum(row.usage_limit)})`
          : `נוצלו ${fmtNum(row.used)} מתוך ${fmtNum(row.usage_limit)} ${row.label} בתקופת השימוש הנוכחית`}
        {until}.{' '}
        {exhausted
          ? 'עיבוד חדש נעצר עד תחילת התקופה הבאה. שום מסמך אינו נמחק, ושום פעולה שכבר נעשתה אינה נחסמת למפרע.'
          : 'מה שכבר נקלט ונשמר אינו מושפע.'}
      </span>
    </Note>
  );
}

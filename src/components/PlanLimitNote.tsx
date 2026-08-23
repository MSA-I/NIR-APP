import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmtDate, fmtNum } from '../lib/format';
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
interface UsageRow {
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
 * #202's thresholds, in the order they are crossed. The lowest is the point at which the note
 * starts speaking; the list is kept whole so the decision is legible here rather than hidden in a
 * comparison.
 */
const THRESHOLDS = [60, 80, 100] as const;
const FIRST_THRESHOLD = THRESHOLDS[0];

export function PlanLimitNote({ metricKey }: { metricKey: string }) {
  const [row, setRow] = useState<UsageRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.rpc('organization_usage_snapshot');
      if (cancelled || error) return;
      const match = ((data ?? []) as UsageRow[]).find((entry) => entry.metric_key === metricKey);
      setRow(match ?? null);
    })();
    return () => { cancelled = true; };
  }, [metricKey]);

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

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmtNum } from '../lib/format';
import { Note } from './ui';

/**
 * The tenant-facing side of a plan limit — shown ONLY on the screen whose action is about to be
 * refused, and only when there is something true to say.
 *
 * The rules this component exists to keep:
 *   * Nothing renders while the limit is unlimited, unmeasured, or comfortably far away. A banner
 *     that is always there is decoration, and decoration about money reads as pressure.
 *   * The two refusals are different sentences. "You have used your quota" is about the customer;
 *     "no quota has been configured" is about us, and must not be dressed up as a reason to buy.
 *   * No countdown, no scarcity, no urgency the data does not support. The number is the number.
 *   * It never claims which plan to buy, because this build has no prices and no plan comparison
 *     yet (OPEN-DECISIONS #157, #161). Saying "upgrade to Pro" before Pro's limits exist would be
 *     inventing the offer.
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

/** Below this the note stays silent: a customer at 60% of their month does not need telling. */
const WARN_AT_PERCENT = 80;

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
          לא הוגדרה מכסת {row.label} למסלול של הארגון, ולכן עיבוד מסמך חדש ייעצר. זו הגדרה במערכת —
          יש לפנות לתמיכה.
        </span>
      </Note>
    );
  }

  if (row.unlimited || row.usage_limit === null || row.percent_used === null) return null;
  if (row.percent_used < WARN_AT_PERCENT) return null;

  const exhausted = (row.remaining ?? 0) <= 0;

  return (
    <Note tone={exhausted ? 'alert' : 'await'}>
      <span className="min-w-0 flex-1">
        {exhausted
          ? `נוצלה מלוא מכסת ${row.label} לתקופת החיוב הנוכחית (${fmtNum(row.used ?? 0)} מתוך ${fmtNum(row.usage_limit)}). `
          : `נוצלו ${fmtNum(row.used ?? 0)} מתוך ${fmtNum(row.usage_limit)} ${row.label} בתקופת החיוב הנוכחית. `}
        {exhausted
          ? 'עיבוד מסמך חדש ייחסם עד תחילת התקופה הבאה או עד שינוי מסלול. המסמכים, החשבוניות והדוחות הקיימים נשארים זמינים במלואם.'
          : 'המסמכים הקיימים אינם מושפעים.'}
      </span>
    </Note>
  );
}

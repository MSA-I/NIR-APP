export type DashboardCategory = { name: string; total: number };
export type DashboardWeeklyPoint = { week: string; total: number; count: number };
// Index signature so a comparison row is a valid chart point-bag (ComparisonLineChart reads by key).
export type DashboardWeeklyComparison = {
  [key: string]: string | number | null;
  week: string;
  purchases: number | null;
  payments: number | null;
};

export function topCategoriesWithOther(categories: readonly DashboardCategory[]): DashboardCategory[] {
  const namedOther = categories.filter((category) => category.name === 'אחר');
  const sorted = categories.filter((category) => category.name !== 'אחר').sort((a, b) => b.total - a.total);
  const top = sorted.slice(0, 4);
  if (namedOther.length === 0 && sorted.length <= 4) return top;
  return [...top, {
    name: 'אחר',
    total: [...namedOther, ...sorted.slice(4)].reduce((sum, category) => sum + category.total, 0),
  }];
}

/**
 * T7.2 zero policy (owner decision, 18.08.2026): the weekly buckets are built over a FULLY
 * fetched window (fetchAll pages the complete range), so a bucket that exists but holds no rows
 * is a TRUE measured zero — plot 0 and keep the line continuous, like the reference. The old
 * behavior nulled it, which cut the line mid-chart every quiet week. The distinction that
 * remains: a week ABSENT from one series entirely (the other series introduced it) is not a
 * measurement of that series → stays null. A count-0 bucket's total is never trusted (it could
 * carry garbage) — the emitted zero is the policy's, not the bucket's.
 */
export function mergeWeeklyComparison(
  purchases: readonly DashboardWeeklyPoint[],
  payments: readonly DashboardWeeklyPoint[],
): DashboardWeeklyComparison[] {
  const weeks = new Map<string, DashboardWeeklyComparison>();
  for (const point of purchases) {
    weeks.set(point.week, { week: point.week, purchases: point.count > 0 ? point.total : 0, payments: null });
  }
  for (const point of payments) {
    const week = weeks.get(point.week) ?? { week: point.week, purchases: null, payments: null };
    week.payments = point.count > 0 ? point.total : 0;
    weeks.set(point.week, week);
  }
  return [...weeks.values()];
}

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

export function mergeWeeklyComparison(
  purchases: readonly DashboardWeeklyPoint[],
  payments: readonly DashboardWeeklyPoint[],
): DashboardWeeklyComparison[] {
  const weeks = new Map<string, DashboardWeeklyComparison>();
  for (const point of purchases) {
    weeks.set(point.week, { week: point.week, purchases: point.count > 0 ? point.total : null, payments: null });
  }
  for (const point of payments) {
    const week = weeks.get(point.week) ?? { week: point.week, purchases: null, payments: null };
    week.payments = point.count > 0 ? point.total : null;
    weeks.set(point.week, week);
  }
  return [...weeks.values()];
}

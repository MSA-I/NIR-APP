import { describe, expect, it } from 'vitest';
import { mergeWeeklyComparison, topCategoriesWithOther } from './dashboardSeries';

describe('dashboard series', () => {
  it('groups the fifth category into other without changing or mutating totals', () => {
    const input = [
      { name: 'ה', total: 5.25 },
      { name: 'א', total: 50.25 },
      { name: 'ד', total: 10.25 },
      { name: 'ב', total: 40.25 },
      { name: 'ג', total: 20.25 },
    ];
    const before = structuredClone(input);
    const result = topCategoriesWithOther(input);

    expect(result.map(({ name }) => name)).toEqual(['א', 'ב', 'ג', 'ד', 'אחר']);
    expect(result.reduce((sum, category) => sum + category.total, 0))
      .toBe(input.reduce((sum, category) => sum + category.total, 0));
    expect(input).toEqual(before);
  });

  it('emits a real other category once with the hidden remainder', () => {
    const result = topCategoriesWithOther([
      { name: 'א', total: 50 },
      { name: 'אחר', total: 7.5 },
      { name: 'ב', total: 40 },
      { name: 'ג', total: 30 },
      { name: 'ד', total: 20 },
      { name: 'ה', total: 10 },
    ]);
    expect(result.map(({ name }) => name)).toEqual(['א', 'ב', 'ג', 'ד', 'אחר']);
    expect(result.at(-1)?.total).toBe(17.5);
  });

  it('אפס-חלון-מלא: דלי ריק הוא 0 נמדד, שבוע נעדר מסדרה נשאר null, וסך מזוהם לעולם לא מחלחל', () => {
    // T7.2 policy: the window is fetched in full, so a PRESENT bucket with count 0 is a true
    // measured zero → 0 (continuous line). A week a series never bucketed (absent) is not a
    // measurement of it → null. The count-0 bucket carries total 900 on purpose: the policy must
    // emit ITS zero, never the bucket's garbage total.
    expect(mergeWeeklyComparison(
      [
        { week: '01/07', total: 0, count: 1 },
        { week: '08/07', total: 900, count: 0 },
      ],
      [
        { week: '01/07', total: 500, count: 1 },
        { week: '15/07', total: 700, count: 1 },
      ],
    )).toEqual([
      { week: '01/07', purchases: 0, payments: 500 },
      { week: '08/07', purchases: 0, payments: null },
      { week: '15/07', purchases: null, payments: 700 },
    ]);
  });
});

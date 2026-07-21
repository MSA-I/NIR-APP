import assert from 'node:assert/strict';
import { mergeWeeklyComparison, topCategoriesWithOther } from '../src/lib/dashboardSeries.ts';

const input = [
  { name: 'ה', total: 5.25 },
  { name: 'א', total: 50.25 },
  { name: 'ד', total: 10.25 },
  { name: 'ב', total: 40.25 },
  { name: 'ג', total: 20.25 },
];
const before = structuredClone(input);
const result = topCategoriesWithOther(input);

assert.deepEqual(result.map(({ name }) => name), ['א', 'ב', 'ג', 'ד', 'אחר'], 'five categories become four plus other');
assert.equal(result.reduce((sum, category) => sum + category.total, 0), input.reduce((sum, category) => sum + category.total, 0), 'grouping preserves the raw sum');
assert.deepEqual(input, before, 'grouping does not mutate its input');

const namedOther = topCategoriesWithOther([
  { name: 'א', total: 50 },
  { name: 'אחר', total: 7.5 },
  { name: 'ב', total: 40 },
  { name: 'ג', total: 30 },
  { name: 'ד', total: 20 },
  { name: 'ה', total: 10 },
]);
assert.deepEqual(namedOther.map(({ name }) => name), ['א', 'ב', 'ג', 'ד', 'אחר'], 'a real other category is emitted once');
assert.equal(namedOther.at(-1)?.total, 17.5, 'a real other category includes the hidden remainder');

assert.deepEqual(
  mergeWeeklyComparison(
    [
      { week: '01/07', total: 0, count: 1 },
      { week: '08/07', total: 900, count: 0 },
    ],
    [
      { week: '01/07', total: 500, count: 1 },
      { week: '15/07', total: 700, count: 1 },
    ],
  ),
  [
    { week: '01/07', purchases: 0, payments: 500 },
    { week: '08/07', purchases: null, payments: null },
    { week: '15/07', purchases: null, payments: 700 },
  ],
  'weekly comparison keeps measured zero, nulls empty buckets, and includes unmatched weeks',
);

console.log('dashboard series: all checks passed');

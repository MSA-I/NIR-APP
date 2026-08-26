import { describe, expect, it } from 'vitest';
import { endLabels } from './charts';

/**
 * The rule the owner asked for on 26.08.2026: each comparison line ends in a dot, and its name
 * sits AT THAT DOT'S HEIGHT — so a dot that moves takes its word with it. The interesting part is
 * the one case where that is impossible, two lines finishing on nearly the same value, which is
 * exactly what /dashboard shows whenever purchases and payments both run down to zero.
 */
describe('שמות הסדרות בקצה הקו', () => {
  it('מציב כל שם בדיוק בגובה הנקודה שלו כששתי הנקודות רחוקות זו מזו', () => {
    const placed = endLabels([{ x: 100, y: 40 }, { x: 100, y: 120 }]);
    expect(placed.map((entry) => [entry.index, entry.y])).toEqual([[0, 40], [1, 120]]);
  });

  it('פותח את הערימה כלפי מעלה כשהנקודות קרובות מדי — התווית התחתונה נשארת בדיוק על הנקודה שלה', () => {
    const placed = endLabels([{ x: 100, y: 200 }, { x: 100, y: 206 }]);
    const [upper, lower] = placed;
    expect(lower.y).toBe(206);
    expect(lower.y - upper.y).toBe(18);
  });

  it('אינו מציב שם מתחת לנקודה הנמוכה ביותר — שם יושבת שורת התאריכים', () => {
    const points = [{ x: 100, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 300 }];
    const placed = endLabels(points);
    const floor = Math.max(...points.map((point) => point.y));
    expect(Math.max(...placed.map((entry) => entry.y))).toBeLessThanOrEqual(floor);
    expect(placed.map((entry) => entry.y)).toEqual([264, 282, 300]);
  });

  it('מדלג על סדרה שאין לה נקודת סיום, ושומר על האינדקס של השאר', () => {
    expect(endLabels([null, { x: 100, y: 55 }])).toEqual([{ index: 1, x: 100, y: 55 }]);
  });
});

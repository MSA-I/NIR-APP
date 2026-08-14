import { describe, expect, it } from 'vitest';
import { formatQuantity, formatUnit, normalizeUnitInput } from './format';

describe('תצוגת יחידות מידה', () => {
  it.each([
    ['חבי', 10, '10 חבילות'],
    ['חבילה', 1, '1 חבילה'],
    ['יח', 3, '3 יחידות'],
    ["יח'", 1, '1 יחידה'],
    ['קרט', 4, '4 קרטונים'],
    ['גל', 2, '2 גלילים'],
    ["ק'ג", 2.5, '2.5 ק״ג'],
    ['ליטר', 3, '3 ל׳'],
  ])('%s בכמות %s מוצג כ-%s', (unit, quantity, expected) => {
    expect(formatQuantity(quantity as number, unit as string)).toBe(expected);
  });

  it('אינו ממציא יחידה עסקית לא מוכרת', () => {
    expect(formatQuantity(7, '  משטח מיוחד  ')).toBe('7 משטח מיוחד');
  });

  it('מחזיר יחידה קנונית להזנות חדשות', () => {
    expect(normalizeUnitInput(' חבי ')).toBe('חבילה');
    expect(normalizeUnitInput('קרט')).toBe('קרטון');
    expect(normalizeUnitInput('מידה מיוחדת')).toBe('מידה מיוחדת');
    expect(formatUnit('יחידות')).toBe('יחידה');
  });
});

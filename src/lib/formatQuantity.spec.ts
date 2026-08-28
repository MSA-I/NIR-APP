import { describe, expect, it } from 'vitest';
import { UNIT_FORMS, formatQuantity, formatUnit, normalizeUnitInput } from './format';

const HEBREW = /[֐-׿]/;

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
    expect(formatQuantity(quantity as number, unit as string, 'he')).toBe(expected);
  });

  // The same aliases, read by an English speaker. Same input, same row in the table, different
  // word — and the quantity 0 is here because English says `0 crates` where a `n === 1` ternary
  // would have said `0 crate`.
  it.each([
    ['חבי', 10, '10 packs'],
    ['חבילה', 1, '1 pack'],
    ['יח', 3, '3 units'],
    ["יח'", 1, '1 unit'],
    ['קרט', 4, '4 cartons'],
    ['גל', 2, '2 rolls'],
    ["ק'ג", 2.5, '2.5 kg'],
    ['ליטר', 3, '3 L'],
    ['ארגז', 0, '0 crates'],
  ])('%s בכמות %s נקרא באנגלית %s', (unit, quantity, expected) => {
    expect(formatQuantity(quantity as number, unit as string, 'en')).toBe(expected);
  });

  it('אינו ממציא יחידה עסקית לא מוכרת', () => {
    expect(formatQuantity(7, '  משטח מיוחד  ', 'he')).toBe('7 משטח מיוחד');
    // And it does not invent one in English either: a word this table has never seen belongs to
    // the business that typed it, and guessing its English would describe different goods.
    expect(formatQuantity(7, '  משטח מיוחד  ', 'en')).toBe('7 משטח מיוחד');
  });

  it('מחזיר יחידה קנונית להזנות חדשות', () => {
    expect(normalizeUnitInput(' חבי ')).toBe('חבילה');
    expect(normalizeUnitInput('קרט')).toBe('קרטון');
    expect(normalizeUnitInput('מידה מיוחדת')).toBe('מידה מיוחדת');
    expect(formatUnit('יחידות', 'he')).toBe('יחידה');
  });

  // What is stored never changes, whoever is reading. This is the whole of decision #282: a
  // display table, and no data migration — the Hebrew value stays the key that `name_match_key`
  // and the three-way match are built on.
  it('אינו משנה את הערך הנשמר גם כשקוראים באנגלית', () => {
    expect(normalizeUnitInput('קג')).toBe('ק״ג');
    expect(formatUnit('קג', 'en', 3)).toBe('kg');
  });

  // The guard that makes the English half complete rather than mostly complete: every alias
  // resolves to a canonical row, every canonical row carries an English word, and no English
  // reading falls back to a Hebrew one. A new unit added without its English fails here.
  it('לכל צורה קנונית יש מילה אנגלית, ולכל כינוי יש את אותה מילה', () => {
    for (const [alias, form] of Object.entries(UNIT_FORMS)) {
      const canonical = UNIT_FORMS[form.singular];
      expect(canonical, `אין שורה קנונית ל-${alias}`).toBeDefined();
      expect(canonical.en, `אין אנגלית לצורה ${form.singular}`).toBeDefined();
      expect(formatUnit(alias, 'en', 1)).not.toMatch(HEBREW);
      expect(formatUnit(alias, 'en', 2)).not.toMatch(HEBREW);
    }
  });
});

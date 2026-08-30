import { describe, expect, it } from 'vitest';
import { en } from './dictionaries/en';
import { he } from './dictionaries/he';
import type { Dictionary } from './dictionaries/he';
import { pluralCategory, translate, tryTranslate } from './t';

const dict = he as unknown as Dictionary;

describe('translate', () => {
  it('returns the string for a known key', () => {
    expect(translate(dict, 'common.save')).toBe('שמירה');
  });

  it('returns the key itself for a miss — a blank cell would hide the fault', () => {
    expect(translate(dict, 'common.nothingHere' as never)).toBe('common.nothingHere');
    expect(translate(dict, 'nosuchns.save' as never)).toBe('nosuchns.save');
    expect(translate(dict, 'nodot' as never)).toBe('nodot');
  });

  it('substitutes {name} placeholders', () => {
    const withVars = { common: { ...dict.common, save: 'שמירת {what}' } } as unknown as Dictionary;
    expect(translate(withVars, 'common.save', { what: 'הזמנה' })).toBe('שמירת הזמנה');
  });

  it('keeps a placeholder that has no value instead of rendering undefined', () => {
    const withVars = { common: { ...dict.common, save: 'שמירת {what}' } } as unknown as Dictionary;
    expect(translate(withVars, 'common.save', { other: 'x' })).toBe('שמירת {what}');
  });
});

describe('tryTranslate', () => {
  it('resolves a key that is only known at runtime', () => {
    expect(tryTranslate(dict, 'common.save')).toBe('שמירה');
  });

  it('returns null on a miss so the caller can fall back to the raw stored value', () => {
    expect(tryTranslate(dict, 'status.some_status_the_map_has_not_caught_up_with')).toBeNull();
  });
});

describe('pluralCategory', () => {
  it('uses each language own rules rather than a hand-rolled n === 1', () => {
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('en', 2)).toBe('other');
    expect(pluralCategory('he', 1)).toBe('one');
    expect(pluralCategory('he', 2)).toBe('two');
  });
});

describe('the English dictionary', () => {
  it('covers every Hebrew key and adds none of its own', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(he).sort());
    for (const namespace of Object.keys(he) as (keyof typeof he)[]) {
      expect(Object.keys(en[namespace]).sort(), namespace)
        .toEqual(Object.keys(he[namespace]).sort());
    }
  });

  it('never ships an empty string — a blank is not a translation', () => {
    // `onboardingSource_none` is the one exception and it is deliberate: it means "no source was
    // recorded", and the operator console prints nothing rather than a word for nothing. Named
    // here rather than skipped by a rule, so a second blank cannot join it quietly.
    const ALLOWED_BLANK = new Set(['onboardingSource_none']);
    for (const namespace of Object.values(en)) {
      for (const [key, value] of Object.entries(namespace)) {
        if (ALLOWED_BLANK.has(key)) continue;
        expect(value.trim(), key).not.toBe('');
      }
    }
  });

  it('reaches for the singular sibling only when the count is one, and only when there is one', () => {
    // English first, because it is the language the sibling exists for.
    expect(translate(en as unknown as Dictionary, 'suppliers.listMeta', { count: 1 }, 'en')).toBe('1 supplier');
    expect(translate(en as unknown as Dictionary, 'suppliers.listMeta', { count: 2 }, 'en')).toBe('2 suppliers');
    expect(translate(en as unknown as Dictionary, 'suppliers.listMeta', { count: 0 }, 'en')).toBe('0 suppliers');

    // Hebrew takes the same door. Its `two` category falls to the plural form on purpose — the
    // three hand-rolled call sites this mechanism generalises already behave that way.
    expect(translate(he as unknown as Dictionary, 'suppliers.listMeta', { count: 1 }, 'he')).toBe('ספק אחד');
    expect(translate(he as unknown as Dictionary, 'suppliers.listMeta', { count: 2 }, 'he')).toBe('2 ספקים');

    // A key with no sibling is untouched, which is what makes this additive rather than a
    // migration: 47 counted phrases still have no `_one` and must keep rendering as they did.
    expect(translate(en as unknown as Dictionary, 'suppliers.tabOrders', { count: 1 }, 'en')).toBe('Orders (1)');

    // No count in vars means no lookup at all — a `{count}`-free key must not pay for this.
    expect(translate(en as unknown as Dictionary, 'common.save', undefined, 'en')).toBe('Save');
  });

  it('pairs every singular sibling across both dictionaries', () => {
    // `_one` keys are part of `Dictionary` like any other, so the compiler already forces parity.
    // What it cannot see is a sibling whose BASE key was deleted, leaving a singular nobody can
    // reach — the same class of orphan the audit found 462 of.
    for (const namespace of Object.keys(he) as (keyof typeof he)[]) {
      for (const key of Object.keys(he[namespace])) {
        if (!key.endsWith('_one')) continue;
        expect(Object.keys(he[namespace]), `${namespace}.${key}`)
          .toContain(key.slice(0, -'_one'.length));
      }
    }
  });
});

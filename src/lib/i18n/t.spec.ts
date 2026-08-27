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
    for (const namespace of Object.values(en)) {
      for (const [key, value] of Object.entries(namespace)) {
        expect(value.trim(), key).not.toBe('');
      }
    }
  });
});

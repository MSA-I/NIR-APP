import { describe, expect, it } from 'vitest';
import { nameKey } from './nameKey';

/**
 * `nameKey` now has a server-side twin: `private.name_match_key` (migration 0106), the fourth rung
 * of the supplier-resolution ladder. Two normalisers that disagree produce the worst kind of bug in
 * this product — a screen that shows a supplier name as matching while the server refuses to resolve
 * it, or the reverse — so this corpus is pinned here and the identical corpus is pinned in
 * `supabase/tests/p27_document_supplier_resolution.sql` §7.
 *
 * A case only belongs here if it also belongs there. If you add one, add both.
 */
describe('nameKey', () => {
  it('strips quotes rather than replacing them with a space', () => {
    // The gershayim in a Hebrew company name is punctuation inside a word, so removing it must not
    // split the word: 'ה"בשר' is 'הבשר'. Replacing it with a space would produce 'ה בשר' and stop
    // matching the same company written without the mark.
    expect(nameKey('מרכז ה"בשר בן דוד')).toBe('מרכז הבשר בן דוד');
    expect(nameKey("מרכז ה'בשר בן דוד")).toBe('מרכז הבשר בן דוד');
    expect(nameKey('מרכז ה״בשר בן דוד')).toBe('מרכז הבשר בן דוד');
    expect(nameKey('מרכז ה׳בשר בן דוד')).toBe('מרכז הבשר בן דוד');
  });

  it('folds runs of whitespace to one and trims the ends', () => {
    expect(nameKey('  מרכז   הבשר  בן דוד ')).toBe('מרכז הבשר בן דוד');
    expect(nameKey('alpha\t\nfoods')).toBe('alpha foods');
  });

  it('folds the two no-break spaces a PDF and a spreadsheet actually print', () => {
    // This is the one place JS and Postgres genuinely differ: `\s` in JavaScript matches U+00A0 and
    // U+202F, and `\s` in Postgres matches neither. 0106 closes the gap with an explicit
    // `translate`, so both sides must agree on exactly these two code points.
    // Written as escapes, not as bytes: a no-break space is invisible in review, and an editor
    // that silently normalised it would make this assertion pass without testing anything.
    expect(nameKey('alpha\u00a0 foods')).toBe('alpha foods');
    expect(nameKey('beta\u202ffoods')).toBe('beta foods');
  });

  it('lowercases, so Latin supplier names match regardless of case', () => {
    expect(nameKey('Alpha FOODS Ltd')).toBe('alpha foods ltd');
  });

  it('reduces a name with nothing left in it to the empty string', () => {
    // The SQL twin returns null here rather than '' — `nullif(..., '')` — because a null cannot
    // match anything by accident, while '' can equal another ''. The client's falsy check is the
    // same guard; what matters is that neither side treats a blank name as matchable.
    expect(nameKey('   ')).toBe('');
    expect(nameKey('""')).toBe('');
    expect(nameKey('')).toBe('');
  });

  it('leaves the two fixture names in p27 colliding', () => {
    // p27 asserts ambiguity by giving two suppliers names that differ only by a gershayim and a
    // doubled space. If this stops holding, that suite silently stops testing ambiguity.
    expect(nameKey('מרכז  ה"בשר בן דוד')).toBe(nameKey('מרכז הבשר בן דוד'));
  });

  it('does not merge names that are merely similar', () => {
    // The ladder's fourth rung is exact-after-normalisation on purpose. Similarity is a suggestion,
    // never an authoritative match (OPEN-DECISIONS #141 line of reasoning, 0106 header).
    expect(nameKey('מרכז הבשר')).not.toBe(nameKey('מרכז הבשר בן דוד'));
    expect(nameKey('alpha foods')).not.toBe(nameKey('alpha food'));
  });
});

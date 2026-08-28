import { describe, expect, it } from 'vitest';
import { fmtMoneyExact } from './format';
import { fieldChanges, renderValue } from './supplierLogChanges';
import { he } from './i18n/dictionaries/he';
import { translate, type TKey } from './i18n/t';

/** The Hebrew resolver. These assertions pin the Hebrew wording the defect was reported about. */
const t = (key: TKey) => translate(he, key);

/**
 * These assertions exist because of a specific complaint about /supplier-log: the diff leaned on an
 * arrow and a dash, and both are glyphs a reader has to decode. The words are the fix, so the words
 * are what is pinned here — an empty value must say `לא הוגדר`, not `—`.
 *
 * Money is asserted against `fmtMoneyExact` itself rather than a hard-coded string. The he-IL
 * currency form carries bidi marks that are invisible in review, and a literal would either be
 * silently wrong or silently rewritten by an editor. Comparing to the one formatter the project
 * allows also states the real rule: this screen never formats money on its own.
 */
describe('renderValue', () => {
  it('says the absent value out loud instead of drawing a dash', () => {
    expect(renderValue(null, t)).toBe('לא הוגדר');
    expect(renderValue(undefined, t)).toBe('לא הוגדר');
    expect(renderValue('', t)).toBe('לא הוגדר');
    expect(renderValue([], t)).toBe('לא הוגדר');
    // The point of the change: no branch may fall back to the glyph the defect was about.
    expect(renderValue(null, t)).not.toBe('—');
  });

  it('formats money through fmtMoneyExact, never on its own', () => {
    expect(renderValue(14, t, 'money')).toBe(fmtMoneyExact(14));
    expect(renderValue(14, t, 'money')).toContain('14.00');
    // A numeric string out of jsonb is still money, not text.
    expect(renderValue('12.5', t, 'money')).toBe(fmtMoneyExact(12.5));
    // Zero is a price, not a missing value.
    expect(renderValue(0, t, 'money')).toBe(fmtMoneyExact(0));
  });

  it('keeps a value that cannot be a number as itself', () => {
    expect(renderValue('לפי הסכם', t, 'money')).toBe('לפי הסכם');
  });

  it('renders booleans and lists as words', () => {
    expect(renderValue(true, t, 'bool')).toBe('זמין');
    expect(renderValue(false, t, 'bool')).toBe('לא זמין');
    expect(renderValue(['א', 'ב'], t)).toBe('א, ב');
  });
});

describe('fieldChanges', () => {
  it('reports only the fields that actually moved', () => {
    const changes = fieldChanges(
      { name: 'אלפא', phone: '03-1111111', org_id: 'org-1' },
      { name: 'אלפא', phone: '03-2222222', org_id: 'org-2' },
      t,
    );
    // `name` did not move and `org_id` is not a tracked field — neither is news.
    expect(changes.map((c) => c.field)).toEqual(['phone']);
    expect(changes[0]).toMatchObject({
      label: 'טלפון', before: '03-1111111', after: '03-2222222',
    });
  });

  it('pairs a price change as before and after, both formatted', () => {
    const changes = fieldChanges({ current_price: 12.5 }, { current_price: 14 }, t);
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toBe(fmtMoneyExact(12.5));
    expect(changes[0].after).toBe(fmtMoneyExact(14));
  });

  it('calls a first-time value "not set" rather than leaving the side blank', () => {
    const changes = fieldChanges(null, { current_price: 14 }, t);
    expect(changes[0].before).toBe('לא הוגדר');
    expect(changes[0].after).toBe(fmtMoneyExact(14));
  });

  it('returns nothing when only untracked columns differ', () => {
    expect(fieldChanges({ id: 'a', updated_at: '2026-08-01' }, { id: 'a', updated_at: '2026-08-02' }, t))
      .toEqual([]);
  });
});

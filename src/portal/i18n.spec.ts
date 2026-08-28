import { describe, expect, it } from 'vitest';
import {
  formatPortalDate,
  formatPortalMoney,
  formatPortalQuantity,
  portalLocaleFromLocation,
} from './i18n';

describe('supplier portal locale', () => {
  it('lets an explicit supported URL locale win and otherwise falls back safely', () => {
    expect(portalLocaleFromLocation('?lang=he', 'en-US')).toBe('he');
    expect(portalLocaleFromLocation('?lang=en', 'he-IL')).toBe('en');
    expect(portalLocaleFromLocation('?lang=fr', 'en-GB')).toBe('en');
    expect(portalLocaleFromLocation('?lang=fr', 'fr-FR')).toBe('he');
  });

  it('formats dates, ILS amounts, and quantities for the selected locale', () => {
    expect(formatPortalDate('en', '2026-08-25')).toBe('08/25/2026');
    expect(formatPortalMoney('en', 10)).toContain('10.00');
    expect(formatPortalMoney('en', 10)).toContain('₪');
    expect(formatPortalQuantity('en', 1.5, 'kg')).toBe('1.5 kg');
    expect(formatPortalQuantity('he', 5, 'kg')).toContain('5');
  });

  // The unit a supplier's portal actually receives is the one stored on the product, and that
  // is Hebrew (`products.unit`, `0001:92`). Until decision #282 this line read the raw stored
  // value straight out to an English reader, so the English portal showed `ק״ג`.
  it('reads a stored Hebrew unit in the reader’s language, without changing what is stored', () => {
    expect(formatPortalQuantity('en', 3, 'ק״ג')).toBe('3 kg');
    expect(formatPortalQuantity('en', 2, 'ארגז')).toBe('2 crates');
    expect(formatPortalQuantity('en', 1, 'יחידות')).toBe('1 unit');
    expect(formatPortalQuantity('he', 3, 'ק״ג')).toBe('3 ק״ג');
  });
});

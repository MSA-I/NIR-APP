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
    expect(formatPortalMoney('en', 10, 'ILS')).toContain('10.00');
    expect(formatPortalMoney('en', 10, 'ILS')).toContain('₪');
    // The supplier sees the currency the ORDER was issued in, in their own locale's number
    // shape (0217, #277). The locale decides how the figure reads; it never decides the money.
    expect(formatPortalMoney('en', 10, 'USD')).toContain('$');
    expect(formatPortalMoney('he', 10, 'USD')).toContain('$');
    expect(formatPortalQuantity('en', 1.5, 'kg')).toBe('1.5 kg');
    expect(formatPortalQuantity('he', 5, 'kg')).toContain('5');
  });
});

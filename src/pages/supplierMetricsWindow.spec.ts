import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { he } from '../lib/i18n/dictionaries/he';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

const PHRASE = 'שינויי מחיר (90 הימים האחרונים)';

describe('supplier metrics 90-day wording', () => {
  /**
   * The window in the phrase is a claim about what the number MEASURES, and the owner approved
   * this wording. The supplier screen now reads it from the dictionary, so the claim splits: the
   * screen renders that key, and the key still carries the exact phrase. Analytics has not been
   * extracted yet and is still checked against its own source.
   */
  it('uses the exact owner-approved phrase on supplier and analytics screens', () => {
    const suppliers = source('./Suppliers.tsx');
    const analytics = source('./Analytics.tsx');
    expect(suppliers).toContain("t('suppliers.priceChanges90')");
    expect(he.suppliers.priceChanges90).toBe(PHRASE);
    expect(analytics).toContain(PHRASE);
    for (const wrongWindow of ['שינויי מחיר (180 יום)', 'שינויי מחיר (30 יום)']) {
      expect(he.suppliers.priceChanges90).not.toContain(wrongWindow);
      expect(suppliers).not.toContain(wrongWindow);
      expect(analytics).not.toContain(wrongWindow);
    }
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../lib/i18n/dictionaries/en';
import { he } from '../lib/i18n/dictionaries/he';

const source = readFileSync(join(process.cwd(), 'src', 'pages', 'PriceLists.tsx'), 'utf8');

describe('price-list language boundaries', () => {
  it('keeps imported header matching independent of the reader locale', () => {
    expect(source).toContain("supplier: matchColumn(sheet.headers, ['ספק', 'supplier'], false)");
    expect(source).toContain("product: matchColumn(sheet.headers, ['מוצר', 'product'], false)");
    expect(source).toContain("price: matchColumn(sheet.headers, ['מחיר', 'price'], false)");
    expect(source).not.toContain("t('priceLists.matchColumn");
    expect(he.priceLists).not.toHaveProperty('matchColumn');
    expect(en.priceLists).not.toHaveProperty('matchColumn');
  });

  it('keeps audit defaults fixed at their write sites', () => {
    expect(source).toContain("p_reason: reasonOr(reason, 'עדכון המחיר')");
    expect(source).toContain("p_reason: reasonOr(reason, 'ייבוא המחירון')");
    expect(source).not.toContain("t('priceLists.reasonOr");
    expect(he.priceLists).not.toHaveProperty('reasonOr');
    expect(en.priceLists).not.toHaveProperty('reasonOr');
  });

  it('stores import result facts and resolves the sentence at render time', () => {
    expect(source).toContain('useState<ImportReport | null>(null)');
    expect(source).toContain('setReport(imported);');
    expect(source).toContain("t('priceListsTail.importReport'");
    expect(source).not.toMatch(/setReport\(`|setReport\(t\(/);
  });

  it('formats submission months in the active locale', () => {
    expect(source).toContain('new Intl.DateTimeFormat(INTL_LOCALE[locale]');
    expect(source).toContain('monthLabel(submission.target_month, locale)');
    expect(source).not.toContain("new Intl.DateTimeFormat('he-IL'");
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('supplier metrics 90-day wording', () => {
  it('uses the exact owner-approved phrase on supplier and analytics screens', () => {
    const suppliers = source('./Suppliers.tsx');
    const analytics = source('./Analytics.tsx');
    expect(suppliers).toContain('שינויי מחיר (90 הימים האחרונים)');
    expect(analytics).toContain('שינויי מחיר (90 הימים האחרונים)');
    expect(suppliers).not.toContain('שינויי מחיר (180 יום)');
    expect(analytics).not.toContain('שינויי מחיר (30 יום)');
  });
});

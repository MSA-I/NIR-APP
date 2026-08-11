import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_DEFINITIONS,
  exportDefinition,
  suggestMapping,
  unmappedCount,
} from './exportTemplates';

/**
 * Package K's mapping, and the one temptation it must keep refusing.
 *
 * The output of this feature is a file an accountant files with the tax authority. A mapping that
 * is merely probably right is worse here than one that is visibly incomplete, because a row saying
 * "matched" invites nobody to look at it twice.
 */
describe('the field catalogue', () => {
  it('covers the three export keys the database admits, and only those', () => {
    // 0123's CHECK and 0126's validator both name the same three. A fourth here would be a button
    // that proposes a template the server refuses.
    expect(EXPORT_DEFINITIONS.map((definition) => definition.key)).toEqual([
      'accountant_monthly_report',
      'owner_expense_summary',
      'product_purchase_summary',
    ]);
  });

  it('agrees with the migration about which keys exist', () => {
    const migration = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0126_propose_export_report_template.sql'),
      'utf8');
    for (const definition of EXPORT_DEFINITIONS) {
      expect(migration).toContain(`'${definition.key}'`);
    }
  });

  it('gives every field a key, a Hebrew label and a sample', () => {
    // The sample is not decoration: the mapping dropdown shows it, and "23,112.00" beside "סה״כ
    // מע״מ" is how somebody notices they picked the wrong one before approving.
    for (const definition of EXPORT_DEFINITIONS) {
      expect(definition.fields.length).toBeGreaterThan(4);
      for (const field of definition.fields) {
        expect(field.key).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(field.label.trim().length).toBeGreaterThan(0);
        expect(field.sample.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('never repeats a key inside one export', () => {
    for (const definition of EXPORT_DEFINITIONS) {
      const keys = definition.fields.map((field) => field.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('answers for a known key and stays quiet for an unknown one', () => {
    expect(exportDefinition('accountant_monthly_report')?.fields.length).toBeGreaterThan(0);
    expect(exportDefinition('whatever_i_typed')).toBeUndefined();
  });
});

describe('suggestMapping', () => {
  const monthly = EXPORT_DEFINITIONS[0];
  const at = (key: string) => ({ key, sheet: 'דוח', cell: 'B2' });

  it('pre-selects an exact key and nothing else', () => {
    const mapping = suggestMapping([at('net_total')], monthly);
    expect(mapping[0].source).toBe('net_total');
  });

  it('leaves a near-miss for a person, which is the whole point', () => {
    // `total`, `NET_TOTAL` and `net total` are all things an accountant might write, and all three
    // could plausibly mean net, gross or VAT. Guessing puts the wrong number in a filed return.
    for (const near of ['total', 'NET_TOTAL', 'net total', 'nettotal', 'net_totals']) {
      expect(suggestMapping([at(near)], monthly)[0].source).toBeNull();
    }
  });

  it('leaves a key from another report unmatched', () => {
    // `committed_total` is real — on the owner's expense summary. On the accountant's monthly
    // report it is a field nobody produces, and filling it would invent a number.
    expect(suggestMapping([at('committed_total')], monthly)[0].source).toBeNull();
  });

  it('keeps the sheet and cell, because "which cell" is what a person is checking', () => {
    const mapping = suggestMapping([{ key: 'vat_total', sheet: 'סיכום', cell: 'D14' }], monthly);
    expect(mapping[0]).toEqual({
      key: 'vat_total', sheet: 'סיכום', cell: 'D14', source: 'vat_total',
    });
  });

  it('counts what still needs someone', () => {
    const mapping = suggestMapping([at('net_total'), at('mystery'), at('vat_total')], monthly);
    expect(unmappedCount(mapping)).toBe(1);
  });

  it('handles a workbook with no placeholders at all', () => {
    expect(suggestMapping([], monthly)).toEqual([]);
    expect(unmappedCount([])).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { translateIn } from './i18n/LocaleProvider';
import { mapRows, readSheet } from './importSheet';

const tEn = (key: Parameters<typeof translateIn>[1], vars?: Record<string, string | number>) =>
  translateIn('en', key, vars);

describe('spreadsheet reader language boundary', () => {
  it('reports file refusals in the caller locale', async () => {
    await expect(readSheet(new File([], 'empty.csv', { type: 'text/csv' }), tEn))
      .rejects.toThrow('The file is empty');
    await expect(readSheet(new File(['x'], 'prices.txt', { type: 'text/plain' }), tEn))
      .rejects.toThrow('This file type is not supported');
  });

  it('uses the caller locale for a non-Error row rejection', () => {
    const result = mapRows([{ value: 1 }], () => { throw 'bad row'; }, tEn('importSheet.invalidRow'));
    expect(result.valid).toEqual([]);
    expect(result.skipped).toEqual([{ row: 2, reason: 'Invalid row' }]);
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.spec\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('payable invoice browser-query boundary', () => {
  it('filters every direct invoices query outside the reconciliation workspace', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const source = readFileSync(file, 'utf8');
      let cursor = 0;
      while ((cursor = source.indexOf(".from('invoices')", cursor)) !== -1) {
        const query = source.slice(cursor, cursor + 800);
        if (!query.includes(".eq('financial_role', 'payable')")) missing.push(file);
        cursor += 17;
      }
    }
    expect(missing).toEqual([]);
  });

  it('adds the same predicate to the server-driven invoice list', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'pages', 'Invoices.tsx'), 'utf8');
    expect(source).toContain("{ kind: 'eq', column: 'financial_role', value: 'payable' }");
  });
});

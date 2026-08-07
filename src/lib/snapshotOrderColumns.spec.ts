// Every table the snapshot loader sorts must actually have the column it sorts by.
//
// This exists because assuming did not work. `fetchByColumnIds` hard-coded `order('created_at')`,
// which was true of the six tables it had ever been pointed at. `document_filings` records
// `decided_at` instead — a filing is stamped with when someone DECIDED — so PostgREST answered the
// request with 400, `fetchAll` threw, and the throw took the entire document snapshot down. The
// review screen rendered one line: "הפעולה נכשלה. אם הבעיה חוזרת — פנה לתמיכה."
//
// The unit suite could not see it: it never reaches real PostgREST, and TypeScript has no opinion
// about whether a string names a column. So the check is made against the migrations, which are
// the only offline source of truth for what columns exist.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const migrationsDir = join(root, 'supabase', 'migrations');
const loaderSource = readFileSync(join(root, 'src', 'lib', 'useDocumentProcessing.ts'), 'utf8');

/** table → every column name that any migration ever creates or adds on it. */
function columnsByTable(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    const key = table.replace(/^public\./, '');
    if (!tables.has(key)) tables.set(key, new Set());
    tables.get(key)!.add(column);
  };

  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    // `create table [if not exists] [public.]name ( … )` — body taken up to the line that closes
    // it at column 0, which is how every migration in this repo formats a table.
    for (const match of sql.matchAll(/create table (?:if not exists )?([\w.]+)\s*\(([\s\S]*?)\n\);/g)) {
      for (const line of match[2].split('\n')) {
        const column = line.match(/^\s{2}([a-z_]+)\s+[a-z]/);
        if (column) add(match[1], column[1]);
      }
    }
    for (const match of sql.matchAll(/alter table ([\w.]+)\s+add column (?:if not exists )?([a-z_]+)/g)) {
      add(match[1], match[2]);
    }
  }
  return tables;
}

/** Every fetchByColumnIds call site: the table it reads and the column it orders by. */
function orderedReads(): { table: string; orderColumn: string }[] {
  return [...loaderSource.matchAll(
    /fetchByColumnIds<[^>]+>\(\s*'([a-z_]+)',\s*'[a-z_]+',\s*[\w.]+(?:,\s*'([a-z_]+)')?\s*\)/g,
  )].map((m) => ({ table: m[1], orderColumn: m[2] ?? 'created_at' }));
}

describe('the snapshot loader only sorts by columns that exist', () => {
  const schema = columnsByTable();

  it('parsed the migrations at all', () => {
    // Without this the scan below can pass by finding nothing, which is how a guard rots.
    expect(schema.size).toBeGreaterThan(30);
    expect(schema.get('document_filings')).toBeDefined();
    expect(orderedReads().length).toBeGreaterThanOrEqual(8);
  });

  it('knows document_filings has decided_at and no created_at — the exact trap', () => {
    const columns = schema.get('document_filings')!;
    expect(columns.has('decided_at')).toBe(true);
    expect(columns.has('created_at')).toBe(false);
  });

  it('names a real column for every ordered read', () => {
    const broken = orderedReads().filter(({ table, orderColumn }) => {
      const columns = schema.get(table);
      // An unknown table is a failure too: it means this scan lost sight of a read.
      return !columns || !columns.has(orderColumn);
    });
    expect(broken).toEqual([]);
  });
});

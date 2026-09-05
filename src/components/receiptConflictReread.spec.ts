import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePostgrestSelect, schemaColumnsFrom } from '../lib/schemaColumns';
import { RECEIPT_CONFLICT_READ } from './ReceiptConflictDialog';

/**
 * `PROC-01`, and the whole class it belongs to.
 *
 * The conflict dialog is the product's designated recovery path when the device and the server
 * disagree about what arrived on a truck. From 2026-08-06 it asked PostgREST for
 * `goods_receipts.created_at` — a column `0001_init.sql:174-183` never defined and no migration
 * ever added — so every re-read came back HTTP 400 `42703`, for every role, every time. The screen
 * then degraded exactly as designed: every server field an em dash, and re-submission blocked
 * "until a successful re-read" that could never happen. A safety net that had never once caught
 * anything.
 *
 * The one-column fix is worth less than this test. A column name inside a `.select()` is a string,
 * this repo generates no database types, and nothing between the editor and the browser reads it.
 * So the legal names are derived from `supabase/migrations/*.sql` — the same files that build the
 * database — and every name the re-read uses is checked against them. The next absent column fails
 * here instead of in front of a clerk holding a crate.
 *
 * Two things keep this from being decorative. The select strings are read from the same constant
 * the queries are built from, so the guard cannot bless a query the code does not run; and the
 * schema reader's own competence is proved in `lib/schemaColumns.spec.ts`, because one that
 * quietly returned nothing would satisfy every assertion here by vacuum.
 */

const MIGRATIONS = resolve('supabase/migrations');

const schema = schemaColumnsFrom(
  readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(resolve(MIGRATIONS, name), 'utf8')),
);

type TableRead = { readonly select: string; readonly filter: readonly string[]; readonly order?: string };
const queries = Object.entries(RECEIPT_CONFLICT_READ) as [string, TableRead][];

/** Every table/column pair the re-read names — selected (embeds included), filtered or ordered. */
const named = queries.flatMap(([table, read]) => {
  const selected = parsePostgrestSelect(table, read.select);
  const extra = [...read.filter, ...(read.order ? [read.order] : [])];
  return selected.map((entry) => (
    entry.table === table ? { ...entry, columns: [...entry.columns, ...extra] } : entry
  ));
});

describe('the receipt-conflict re-read names only columns that exist', () => {
  it('resolves every table it touches, embedded ones included', () => {
    // Guards the guard twice over: a select the parser could not read would produce no entries,
    // and a table the migrations do not create would make its column check vacuous.
    expect(named.map((entry) => entry.table).sort()).toEqual([
      'audit_logs', 'goods_receipt_items', 'goods_receipts',
      'profiles', 'purchase_order_items', 'purchase_orders',
    ]);
    for (const { table, columns } of named) {
      expect({ table, known: schema.has(table), empty: columns.length === 0 })
        .toEqual({ table, known: true, empty: false });
    }
  });

  it.each(named.map((entry) => entry.table))('%s — every column it names is real', (table) => {
    const columns = schema.get(table);
    if (!columns) throw new Error(`no such table in the migrations: ${table}`);
    const asked = named.filter((entry) => entry.table === table).flatMap((entry) => entry.columns);

    // A set difference rather than one membership at a time, so a failure names the offending
    // column instead of reporting that false is not true.
    expect({ table, absent: asked.filter((column) => !columns.has(column)) })
      .toEqual({ table, absent: [] });
  });

  it('stays live against the exact column that broke it for a month', () => {
    // The ordering column was half of PROC-01 and is the easy half to lose again: `.order()` is a
    // separate call from `.select()`, and PostgREST rejects the whole request over it.
    expect(schema.get('goods_receipts')?.has('created_at')).toBe(false);
    const receipts = named.find((entry) => entry.table === 'goods_receipts');
    expect(receipts?.columns).not.toContain('created_at');
  });

  it('keeps the queries built from this constant, so the guard cannot bless one it never read', () => {
    const source = readFileSync(resolve('src/components/ReceiptConflictDialog.tsx'), 'utf8');
    // Every `.select(` in the file reads its argument from RECEIPT_CONFLICT_READ. A column list
    // written inline would be invisible to everything above — which is how the original defect
    // stayed invisible for a month.
    const selects = source.match(/\.select\(/g) ?? [];
    const fromConstant = source.match(/\.select\(RECEIPT_CONFLICT_READ\./g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    expect(fromConstant).toHaveLength(selects.length);

    // `goods_receipt_items` is reached as an embedded resource inside the `goods_receipts` select,
    // so it has no `from()` of its own. Compared as booleans, not with `toContain`, so a failure
    // names the missing reference instead of printing the whole file.
    for (const [table] of queries) {
      expect({ table, queried: source.includes(`from('${table}')`) }).toEqual({ table, queried: true });
    }
    expect(RECEIPT_CONFLICT_READ.goods_receipts.select).toContain('items:goods_receipt_items(');
  });
});

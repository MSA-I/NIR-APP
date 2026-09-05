import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectSchemaColumns, parsePostgrestSelect, schemaColumnsFrom, stripSqlNoise,
} from './schemaColumns';

/**
 * The parser that `receiptConflictReread.spec.ts` trusts, proving it can be trusted.
 *
 * A guard built on a schema reader is only as honest as the reader: one that quietly returned an
 * empty map would pass every "this column exists" assertion by vacuum, and would have let
 * `PROC-01` through a second time. So this file asserts the reader's competence in both
 * directions — columns known to exist are found, and names known not to exist are not invented.
 */

const MIGRATIONS = resolve('supabase/migrations');

const allMigrations = (): string[] => readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(resolve(MIGRATIONS, name), 'utf8'));

const columnsOf = (map: Map<string, Set<string>>, table: string): Set<string> => {
  const found = map.get(table);
  if (!found) throw new Error(`schemaColumns found no table named ${table}`);
  return found;
};

describe('stripSqlNoise — DDL inside a comment or a quoted body is not DDL', () => {
  it('blanks line and block comments', () => {
    expect(stripSqlNoise('-- create table ghost (id uuid);\nselect 1;')).not.toMatch(/create\s+table/i);
    expect(stripSqlNoise('/* create table ghost (id uuid); */ select 1;')).not.toMatch(/create\s+table/i);
  });

  it('blanks a function body, where a create table is a template and not a migration', () => {
    const sql = "create function f() returns void language plpgsql as $$ begin create table ghost (id uuid); end $$;";
    expect(stripSqlNoise(sql)).not.toMatch(/create\s+table/i);
  });

  it('blanks single-quoted text, doubled quotes included', () => {
    expect(stripSqlNoise("select 'create table ghost (id uuid)'' still quoted';")).not.toMatch(/create\s+table/i);
  });

  it('leaves real DDL alone and preserves line count, so nothing shifts', () => {
    const sql = 'create table real_one (\n  id uuid -- the key\n);\n';
    const clean = stripSqlNoise(sql);
    expect(clean).toMatch(/create\s+table\s+real_one/i);
    expect(clean.split('\n')).toHaveLength(sql.split('\n').length);
  });
});

describe('collectSchemaColumns — what a create table actually declares', () => {
  it('reads columns and refuses to read constraints as columns', () => {
    const map = collectSchemaColumns(`
      create table t (
        id uuid primary key default gen_random_uuid(),
        amount numeric(12,2) not null default 0,
        constraint t_amount_positive check (amount >= 0),
        primary key (id),
        unique (id, amount),
        foreign key (id) references other(id)
      );
    `);
    expect([...columnsOf(map, 't')].sort()).toEqual(['amount', 'id']);
  });

  it('folds alter table … add column into the same table, several actions per statement', () => {
    const map = collectSchemaColumns('create table t (id uuid);');
    collectSchemaColumns('alter table t add column a text, add column if not exists b int;', map);
    collectSchemaColumns('alter table public.t add column c uuid;', map);
    expect([...columnsOf(map, 't')].sort()).toEqual(['a', 'b', 'c', 'id']);
  });

  it('does not mistake create table … as select for a column list', () => {
    const map = collectSchemaColumns('create temp table snapshot as select 1 as n;');
    expect(map.has('snapshot')).toBe(false);
  });
});

describe('parsePostgrestSelect — an embedded column belongs to the embedded table', () => {
  it('reads a flat list', () => {
    expect(parsePostgrestSelect('t', 'id, qty, received_qty')).toEqual([
      { table: 't', columns: ['id', 'qty', 'received_qty'] },
    ]);
  });

  it('attributes an embedded resource to the table it embeds, not the one it hangs off', () => {
    // The whole reason this is not a split on commas: checking `qty_received` against
    // `goods_receipts` would be a worse answer than checking nothing.
    expect(parsePostgrestSelect(
      'goods_receipts',
      'id, status, items:goods_receipt_items(order_item_id, qty_received)',
    )).toEqual([
      { table: 'goods_receipts', columns: ['id', 'status'] },
      { table: 'goods_receipt_items', columns: ['order_item_id', 'qty_received'] },
    ]);
  });

  it('sees through a renamed column and a renamed embed alike', () => {
    expect(parsePostgrestSelect('t', 'shown:real_column, kids:child(a)')).toEqual([
      { table: 't', columns: ['real_column'] },
      { table: 'child', columns: ['a'] },
    ]);
  });

  it('handles an embed inside an embed', () => {
    expect(parsePostgrestSelect('a', 'x, b(y, c(z))')).toEqual([
      { table: 'a', columns: ['x'] },
      { table: 'b', columns: ['y'] },
      { table: 'c', columns: ['z'] },
    ]);
  });
});

describe('the real migrations, read end to end', () => {
  const map = schemaColumnsFrom(allMigrations());

  it('finds the tables the receipt-conflict re-read touches', () => {
    for (const table of [
      'goods_receipts', 'goods_receipt_items', 'purchase_orders', 'purchase_order_items',
      'profiles', 'audit_logs',
    ]) expect(map.has(table)).toBe(true);
  });

  it('reads goods_receipts exactly as 0001 and 0055 declare it', () => {
    // 0001_init.sql:174-183 plus 0055_scope_columns_and_indexes.sql:44. Spelled out rather than
    // spot-checked: an over-eager parser that swept in neighbouring identifiers would pass a
    // "contains" assertion and fail this one.
    expect([...columnsOf(map, 'goods_receipts')].sort()).toEqual(
      ['id', 'notes', 'number', 'order_id', 'org_id', 'received_at', 'received_by', 'status', 'unit_id'],
    );
  });

  it('does not invent goods_receipts.created_at — the column PROC-01 queried for a month', () => {
    expect(columnsOf(map, 'goods_receipts').has('created_at')).toBe(false);
  });

  it('finds columns added by a later migration, not only by the create table', () => {
    expect(columnsOf(map, 'purchase_orders').has('currency')).toBe(true);   // 0217:196
    expect(columnsOf(map, 'audit_logs').has('correlation_id')).toBe(true);  // 0062:16
    expect(columnsOf(map, 'audit_logs').has('causation_id')).toBe(true);    // 0063:45
    expect(columnsOf(map, 'profiles').has('supplier_id')).toBe(true);       // 0004:6
  });

  it('never reports a constraint keyword as a column', () => {
    for (const [table, columns] of map) {
      for (const keyword of ['constraint', 'primary', 'unique', 'foreign', 'check']) {
        expect(`${table}.${keyword}`).toBe(columns.has(keyword) ? 'never' : `${table}.${keyword}`);
      }
    }
  });
});

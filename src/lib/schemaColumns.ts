/**
 * The columns each table actually has, read from the migrations themselves.
 *
 * This exists because of `PROC-01`: `ReceiptConflictDialog` selected and ordered by
 * `goods_receipts.created_at` — a column `0001_init.sql:174-183` never defined and no migration
 * ever added. PostgREST answered `42703` on every call, for every role, for a month, and the
 * failure surfaced as a recovery dialog full of em dashes rather than as an error anyone could
 * see. TypeScript could not catch it: the repo has no generated database types, so a column name
 * is only a string inside a `.select()`.
 *
 * A hand-kept list of legal column names would rot exactly the way the query did. So the set is
 * derived from `supabase/migrations/*.sql` at test time — the same files that build the database.
 * A column no migration creates is not a column, and the test that reads this fails.
 *
 * Scope, said plainly: this understands `create table` and `alter table … add column`, which is
 * the whole of how this repo's tables get their columns — no migration drops one. It does not
 * model views, functions or dynamic DDL, and it is not a Postgres parser. Its competence is
 * asserted in `schemaColumns.spec.ts` against columns known to exist and names known not to, so a
 * parser that quietly returned nothing could not make a guard built on it pass.
 */

/** Keywords that open a table constraint rather than a column definition. */
const CONSTRAINT_STARTERS = new Set([
  'constraint', 'primary', 'unique', 'foreign', 'check', 'exclude', 'like', 'partition', 'deferrable',
]);

/**
 * Blanks out comments and every kind of quoted body, so a DDL regex cannot match text Postgres
 * would never read as DDL — a `create table` inside a function body, or a `--` note. Replaced
 * with spaces rather than deleted, so no offset downstream shifts.
 */
export function stripSqlNoise(sql: string): string {
  const out = sql.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === '/*') {
      // Postgres block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') { depth += 1; j += 2; }
        else if (sql.slice(j, j + 2) === '*/') { depth -= 1; j += 2; }
        else j += 1;
      }
      blank(i, j);
      i = j;
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") { j += 1; break; }
        else j += 1;
      }
      blank(i, j);
      i = j;
    } else if (sql[i] === '$') {
      // Dollar quoting: $tag$ … $tag$, tag possibly empty. Anything else beginning with $ is not
      // an opener — `$1` in a function body, for one — and is left alone.
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (!tag) { i += 1; continue; }
      const close = sql.indexOf(tag[0], i + tag[0].length);
      const stop = close === -1 ? sql.length : close + tag[0].length;
      blank(i, stop);
      i = stop;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** `public."Foo"` and `Foo` name the same table; identifiers fold the way Postgres folds them. */
const normalizeTable = (raw: string): string => {
  const last = raw.split('.').pop() ?? raw;
  return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
};

const normalizeColumn = (raw: string): string => (
  raw.startsWith('"') ? raw.slice(1, -1) : raw.toLowerCase()
);

/** Splits a `create table` body on the commas that are not inside parentheses. */
function topLevelItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) { items.push(body.slice(start, i)); start = i + 1; }
  }
  items.push(body.slice(start));
  return items;
}

const IDENT = '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)';
const QUALIFIED = `(?:${IDENT}\\.)?${IDENT}`;

/**
 * Adds every column `sql` creates to `into`, and returns it.
 *
 * Feed the same map every migration in order: a table created by `0001` and extended by `0055`
 * ends with both sets of columns, which is what the running database holds.
 */
export function collectSchemaColumns(
  sql: string,
  into: Map<string, Set<string>> = new Map(),
): Map<string, Set<string>> {
  const clean = stripSqlNoise(sql);

  // `create temp table … as select` has no column list and no place in a schema check; requiring
  // an opening paren right after the name skips it along with every other `create table … as`.
  const created = new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(${QUALIFIED})\\s*\\(`,
    'gi',
  );
  for (let match = created.exec(clean); match; match = created.exec(clean)) {
    // Walk to the matching close paren, so a nested type or check expression cannot end the body early.
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < clean.length && depth > 0) {
      if (clean[end] === '(') depth += 1;
      else if (clean[end] === ')') depth -= 1;
      end += 1;
    }
    const table = normalizeTable(match[1]);
    const columns = into.get(table) ?? new Set<string>();
    for (const item of topLevelItems(clean.slice(match.index + match[0].length, end - 1))) {
      const first = new RegExp(`^\\s*(${IDENT})`).exec(item);
      if (!first) continue;
      const name = normalizeColumn(first[1]);
      if (CONSTRAINT_STARTERS.has(name)) continue;
      columns.add(name);
    }
    into.set(table, columns);
  }

  // One `alter table` may carry several comma-separated actions, so every `add column` in the
  // statement is collected, not only the first.
  const altered = new RegExp(
    `alter\\s+table\\s+(?:only\\s+)?(?:if\\s+exists\\s+)?(${QUALIFIED})([^;]*);`,
    'gi',
  );
  for (let match = altered.exec(clean); match; match = altered.exec(clean)) {
    const table = normalizeTable(match[1]);
    const adds = new RegExp(`add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?(${IDENT})`, 'gi');
    for (let add = adds.exec(match[2]); add; add = adds.exec(match[2])) {
      const columns = into.get(table) ?? new Set<string>();
      columns.add(normalizeColumn(add[1]));
      into.set(table, columns);
    }
  }

  return into;
}

/** Every migration's DDL, folded into one table→columns map. */
export function schemaColumnsFrom(migrations: readonly string[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const sql of migrations) collectSchemaColumns(sql, map);
  return map;
}

/** One table and the columns a PostgREST select asks it for. */
export interface SelectedColumns { table: string; columns: string[] }

/**
 * Reads a PostgREST `select` string — the argument of a supabase-js `.select()` — into the
 * tables and columns it actually names.
 *
 * Embedded resources are the reason this is not a `split(',')`. The receipt re-read asks
 * `goods_receipts` for `items:goods_receipt_items(order_item_id, qty_received)`, and those two
 * column names belong to the embedded table, not to the one the query started from. Checking them
 * against the wrong table would be worse than not checking them.
 */
export function parsePostgrestSelect(table: string, select: string): SelectedColumns[] {
  const columns: string[] = [];
  const nested: SelectedColumns[] = [];

  for (const raw of topLevelItems(select)) {
    const item = raw.trim();
    if (!item) continue;
    const embed = /^(?:([^:()\s]+)\s*:\s*)?([^:()\s]+)\s*\(([\s\S]*)\)$/.exec(item);
    if (embed) {
      // `alias:table(…)` and `table(…)` both embed `table`; the alias renames the result only.
      nested.push(...parsePostgrestSelect(embed[2], embed[3]));
      continue;
    }
    // `alias:column` renames a column; the schema knows it by the name after the colon.
    const [, aliased] = /^[^:]+:(.+)$/.exec(item) ?? [];
    columns.push((aliased ?? item).trim());
  }

  return [{ table, columns }, ...nested];
}

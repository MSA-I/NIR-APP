/**
 * check:currency — three assertions that stand between a money column and a false total.
 *
 * `check:money` guards the client: one place decides what an amount looks like. Nothing guarded
 * the schema, and the schema is where the lie starts. A column called `amount` with no currency
 * beside it is a number without a unit, and `numeric(12,2)` is not a synonym for money — 23 of the
 * numeric columns in these migrations are quantities, rates and confidences (PLAN §1.1). Handing
 * one of those a currency is the first failure mode of a search-and-replace through this schema.
 *
 * THE THREE ASSERTIONS, each with its own exit code so a failure says which one fell:
 *
 *   columns       (2) every numeric column a migration declares is classified in
 *                     scripts/currency-baseline.json as money or explicitly not-money. Once the
 *                     `currencies` table exists, every money column marked `own` or `allocation`
 *                     must actually have a `currency` column on its table.
 *   aggregates    (3) from the migration pinned in `aggregatesEnforcedFrom` onward, a function that
 *                     sums money and never mentions `currency` fails. One forgotten `group by` is
 *                     all it takes to print ₪12,400 + $3,100 as one number.
 *   intake-guard  (4) `private.document_reconciliation_assessment` still refuses a printed currency
 *                     it cannot recognise, with severity `error`. Phase 4 NARROWS this rejection;
 *                     it must never delete it, because "I could not read it" is not "shekels".
 *
 * The third assertion is the reason this file exists at all. A guard that only passes today is
 * worthless: it is written to keep passing after the phase that changes what it guards.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const migrationsDir = join(root, 'supabase', 'migrations');
const baseline = JSON.parse(readFileSync(join(root, 'scripts', 'currency-baseline.json'), 'utf8'));

const EXIT = { columns: 2, aggregates: 3, 'intake-guard': 4 };

const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const read = (file) => readFileSync(join(migrationsDir, file), 'utf8');
const migrationNumber = (file) => file.slice(0, 4);

/** `create table x (...)` bodies, paren-balanced — a nested `numeric(12,2)` must not end the block. */
function createTableBlocks(text) {
  const blocks = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_.""]+)\s*\(/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    blocks.push({ table: match[1].replace(/"/g, '').replace(/^public\./, ''), body: text.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return blocks;
}

/**
 * Statements, split on the `;` that actually ends one.
 *
 * A naive split loses more than half the schema: `;` appears inside every `$$ … $$` function body,
 * inside string literals and inside `--` comments. This walker skips all three, which is what makes
 * a multi-column `alter table … add column a …, add column b …` readable as one statement.
 */
function statements(text) {
  const out = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '$') {
      const tag = /^\$[a-z_]*\$/i.exec(text.slice(i));
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? text.length : end + tag[0].length;
        continue;
      }
    }
    if (c === "'") { const end = text.indexOf("'", i + 1); i = end === -1 ? text.length : end + 1; continue; }
    if (c === '-' && text[i + 1] === '-') { const nl = text.indexOf('\n', i); i = nl === -1 ? text.length : nl + 1; continue; }
    if (c === ';') { out.push(text.slice(start, i)); start = i + 1; }
    i++;
  }
  out.push(text.slice(start));
  return out;
}

const alterTarget = (stmt) => {
  const m = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-z_."]+)/i.exec(stmt);
  return m ? m[1].replace(/"/g, '').replace(/^public\./, '') : null;
};

/**
 * Every numeric column the migrations declare, in a create table or in any later add column.
 *
 * `numeric\b` and not `numeric\(\d+,\d+\)`: a bare `numeric` is still money or still a quantity,
 * and the first draft of this function missed 28 of the 79 columns in the tree by insisting on a
 * precision and by reading only the FIRST `add column` of a multi-column `alter table`. The
 * inventory it returns was checked column-for-column against `pg_attribute` on a database that had
 * replayed every migration — 79 parsed, 79 live, no difference in either direction.
 */
function declaredNumericColumns() {
  const found = new Map();
  for (const file of files) {
    const text = read(file);
    for (const { table, body } of createTableBlocks(text)) {
      for (const line of body.split('\n')) {
        const m = /^\s*([a-z_]+)\s+numeric\b/i.exec(line);
        if (m && !found.has(`${table}.${m[1]}`)) found.set(`${table}.${m[1]}`, file);
      }
    }
    for (const stmt of statements(text)) {
      const table = alterTarget(stmt);
      if (!table) continue;
      const add = /add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_]+)\s+numeric\b/gi;
      let m;
      while ((m = add.exec(stmt)) !== null) {
        if (!found.has(`${table}.${m[1]}`)) found.set(`${table}.${m[1]}`, file);
      }
    }
  }
  return found;
}

/** `table.column` for every currency-bearing column, from a create table or a later add column. */
function currencyColumns() {
  const carriers = new Set();
  const named = /^\s*([a-z_]*currency)\s+text\b/i;
  for (const file of files) {
    const text = read(file);
    for (const { table, body } of createTableBlocks(text)) {
      for (const line of body.split('\n')) {
        const m = named.exec(line);
        if (m) carriers.add(`${table}.${m[1]}`);
      }
    }
    for (const stmt of statements(text)) {
      const table = alterTarget(stmt);
      if (!table) continue;
      const add = /add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_]*currency)\s/gi;
      let m;
      while ((m = add.exec(stmt)) !== null) carriers.add(`${table}.${m[1]}`);
    }
  }
  return carriers;
}

const schemaHasCurrencies = files.some((f) => /create\s+table\s+(?:if\s+not\s+exists\s+)?currencies\s*\(/i.test(read(f)));

function assertColumns() {
  const problems = [];
  const declared = declaredNumericColumns();
  for (const [column, file] of declared) {
    if (column in baseline.money || column in baseline.notMoney) continue;
    problems.push(
      `  ${column} (${file}) is a numeric column nobody classified.\n`
      + '    Add it to scripts/currency-baseline.json: to "money" with its carrier (own /\n'
      + '    inherits:<table> / allocation), or to "notMoney" with the reason it is not an amount.',
    );
  }

  // The carrier half only becomes checkable once the reference table exists. Before the phase-1
  // migration it would fail on every row by construction, and a guard that cannot pass is noise.
  if (schemaHasCurrencies) {
    const carriers = currencyColumns();
    for (const [column, carrier] of Object.entries(baseline.money)) {
      const table = column.slice(0, column.lastIndexOf('.'));
      if (carrier === 'evidence') {
        // Evidence is read, never rewritten (plan §3.3). Its currency is decided by the reader of
        // the interpretation that produced it, so there is no column here to check.
        continue;
      } else if (carrier === 'own' || carrier === 'allocation' || carrier.startsWith('own:')) {
        // `own:<column>` names the bearer, because a table may carry more than one currency and
        // "the currency column" is then ambiguous — suppliers.min_order_amount is stated in
        // suppliers.default_currency, and a second column holding the same fact could disagree.
        const bearer = carrier.startsWith('own:') ? carrier.slice('own:'.length) : 'currency';
        if (!carriers.has(`${table}.${bearer}`)) {
          problems.push(`  ${column} is marked "${carrier}" but ${table}.${bearer} does not exist.`);
        }
      } else if (carrier.startsWith('inherits:')) {
        const parent = carrier.slice('inherits:'.length);
        if (!carriers.has(`${parent}.currency`)) {
          problems.push(`  ${column} inherits from ${parent}, which has no currency column.`);
        }
      } else {
        problems.push(`  ${column} has an unknown carrier "${carrier}".`);
      }
    }
  }

  if (problems.length > 0) {
    console.error(
      `check:currency columns FAILED — ${problems.length} problem(s).\n\n${problems.join('\n\n')}\n\n`
      + '  numeric(12,2) is not a synonym for money. A quantity that is handed a currency and an\n'
      + '  amount that is not are the same mistake seen from two sides.',
    );
    return EXIT.columns;
  }
  console.log(
    `GATE_CURRENCY_COLUMNS_OK — ${declared.size} numeric columns declared, all classified `
    + `(${Object.keys(baseline.money).length} money, ${Object.keys(baseline.notMoney).length} not money); `
    + `carrier check ${schemaHasCurrencies ? 'enforced' : 'pending the currencies table'}.`,
  );
  return 0;
}

/** Function bodies in one migration, keyed by name, delimited by the `$$`-style dollar quoting. */
function functionBodies(text) {
  const bodies = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+([a-z_.]+)\s*\([\s\S]*?(\$[a-z_]*\$)/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const tag = match[2];
    const end = text.indexOf(tag, re.lastIndex);
    if (end === -1) continue;
    bodies.push({ name: match[1], body: text.slice(re.lastIndex, end) });
    re.lastIndex = end + tag.length;
  }
  return bodies;
}

function assertAggregates() {
  const names = new Set([
    ...Object.keys(baseline.money).map((k) => k.slice(k.lastIndexOf('.') + 1)),
    ...baseline.extraMoneyNames,
  ]);
  const moneySum = new RegExp(
    `sum\\s*\\(\\s*(?:distinct\\s+)?(?:coalesce\\s*\\(\\s*)?(?:[a-z_]+\\.)?(${[...names].join('|')})\\b`,
    'i',
  );

  const problems = [];
  for (const file of files) {
    if (migrationNumber(file) < baseline.aggregatesEnforcedFrom) continue;
    for (const { name, body } of functionBodies(read(file))) {
      const hit = moneySum.exec(body);
      if (!hit) continue;
      if (/currency/i.test(body)) continue;
      problems.push(
        `  ${file}: ${name}() sums ${hit[1]} and never mentions currency.\n`
        + '    Group by the currency, or return null for a metric that cannot be split. A total\n'
        + '    that spans two currencies is a false number on a screen decisions are made from.',
      );
    }
  }

  if (problems.length > 0) {
    console.error(`check:currency aggregates FAILED — ${problems.length} problem(s).\n\n${problems.join('\n\n')}`);
    return EXIT.aggregates;
  }
  console.log(`GATE_CURRENCY_AGGREGATES_OK — money aggregates enforced from ${baseline.aggregatesEnforcedFrom} onward.`);
  return 0;
}

function assertIntakeGuard() {
  const ASSESSMENT = 'document_reconciliation_assessment';
  const defining = files.filter((f) => new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+private\\.${ASSESSMENT}`, 'i').test(read(f)));
  if (defining.length === 0) {
    console.error(`check:currency intake-guard FAILED — no migration defines private.${ASSESSMENT}().`);
    return EXIT['intake-guard'];
  }

  const latest = defining[defining.length - 1];
  const body = functionBodies(read(latest)).find((f) => f.name.endsWith(ASSESSMENT))?.body ?? '';
  // `currency_not_ils` is today's code; phase 4 narrows the rejection to `currency_unrecognised`.
  // Either spelling satisfies this gate. Deleting the rejection does not.
  const code = /'(currency_not_ils|currency_unrecognised|currency_unsupported)'/.exec(body);
  if (!code) {
    console.error(
      `check:currency intake-guard FAILED — ${latest} defines private.${ASSESSMENT}() with no\n`
      + '  currency rejection. A printed currency the system cannot recognise must reach a person;\n'
      + '  recording its numbers as shekels is silent and expensive.',
    );
    return EXIT['intake-guard'];
  }
  const severity = new RegExp(`'code',\\s*'${code[1]}',\\s*'severity',\\s*'error'`).test(body);
  if (!severity) {
    console.error(
      `check:currency intake-guard FAILED — ${latest} raises ${code[1]} at a severity other than\n`
      + '  `error`. A warning does not block approval, and this finding must.',
    );
    return EXIT['intake-guard'];
  }
  console.log(`GATE_CURRENCY_INTAKE_GUARD_OK — ${latest} still rejects an unrecognised currency as ${code[1]}/error.`);
  return 0;
}

const ASSERTIONS = { columns: assertColumns, aggregates: assertAggregates, 'intake-guard': assertIntakeGuard };
const requested = process.argv[2] ?? 'all';

if (requested !== 'all' && !(requested in ASSERTIONS)) {
  console.error(`Unknown assertion "${requested}". Expected one of: ${Object.keys(ASSERTIONS).join(', ')}, all.`);
  process.exit(1);
}

const toRun = requested === 'all' ? Object.values(ASSERTIONS) : [ASSERTIONS[requested]];
for (const assertion of toRun) {
  const code = assertion();
  if (code !== 0) process.exit(code);
}

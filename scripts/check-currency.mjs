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
  }
  return blocks;
}

/** Every numeric column the migrations declare, whether in a create table or a later add column. */
function declaredNumericColumns() {
  const found = new Map();
  for (const file of files) {
    const text = read(file);
    for (const { table, body } of createTableBlocks(text)) {
      for (const line of body.split('\n')) {
        const m = /^\s*([a-z_]+)\s+numeric\(\d+,\s*\d+\)/i.exec(line);
        if (m && !found.has(`${table}.${m[1]}`)) found.set(`${table}.${m[1]}`, file);
      }
    }
    const add = /alter\s+table\s+(?:if\s+exists\s+)?([a-z_."]+)[\s\S]{0,200}?add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_]+)\s+numeric\(\d+,\s*\d+\)/gi;
    let m;
    while ((m = add.exec(text)) !== null) {
      const key = `${m[1].replace(/"/g, '').replace(/^public\./, '')}.${m[2]}`;
      if (!found.has(key)) found.set(key, file);
    }
  }
  return found;
}

/** Tables that carry a `currency` column, from a create table or a later add column. */
function tablesCarryingCurrency() {
  const carriers = new Set();
  for (const file of files) {
    const text = read(file);
    for (const { table, body } of createTableBlocks(text)) {
      if (/^\s*currency\s+/im.test(body)) carriers.add(table);
    }
    const add = /alter\s+table\s+(?:if\s+exists\s+)?([a-z_."]+)[\s\S]{0,200}?add\s+column\s+(?:if\s+not\s+exists\s+)?currency\s/gi;
    let m;
    while ((m = add.exec(text)) !== null) carriers.add(m[1].replace(/"/g, '').replace(/^public\./, ''));
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
    const carriers = tablesCarryingCurrency();
    for (const [column, carrier] of Object.entries(baseline.money)) {
      const table = column.slice(0, column.lastIndexOf('.'));
      if (carrier === 'own' || carrier === 'allocation') {
        if (!carriers.has(table)) {
          problems.push(`  ${column} is marked "${carrier}" but ${table} has no currency column.`);
        }
      } else if (carrier.startsWith('inherits:')) {
        const parent = carrier.slice('inherits:'.length);
        if (!carriers.has(parent)) {
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

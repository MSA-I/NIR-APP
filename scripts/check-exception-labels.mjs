#!/usr/bin/env node
/**
 * check:exception-labels — an exception the database can raise but the screen cannot name.
 *
 * WHAT WENT WRONG, AND WHY NOTHING CAUGHT IT. `0273` added the eleventh `exception_type` value,
 * `expected_document_missing`, in its own migration. The scanner in `0274` opens exceptions with
 * it. Nothing added it to `EXCEPTION_TYPE` in `src/lib/status.ts` or to either dictionary, and
 * nothing failed: TypeScript is satisfied because the map is `Record<string, string>`, and the
 * i18n guards only check that keys which ARE referenced exist. A key nobody wrote is a key nobody
 * misses.
 *
 * The result is worse than an ugly label. `/exceptions` renders the type through
 * `EXCEPTION_TYPE[row.type]`, so an unmapped value renders EMPTY — the row shows a blank where its
 * kind should be. And the filter dropdown is built by iterating that same map, so the type is not
 * merely mislabelled: it cannot be selected at all. An exception that only this scanner raises is
 * invisible to anyone filtering for it, on the screen whose entire job is "what needs attention".
 *
 * THE DATABASE IS THE AUTHORITY, NOT A HAND-KEPT LIST. The values are read out of the migrations —
 * the `create type` in `0001` plus every `add value` after it — so adding a twelfth value to the
 * enum and forgetting the label fails here, in seconds, instead of appearing as a blank cell in
 * production. A list maintained beside the enum would drift the same way the labels did.
 *
 * `INJECT=drop-label` removes one real label from a copy in memory, which is how
 * check:gate-controls proves this guard bites.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
const statusPath = path.join(repoRoot, 'src', 'lib', 'status.ts');
const dictionaries = {
  he: path.join(repoRoot, 'src', 'lib', 'i18n', 'dictionaries', 'he.ts'),
  en: path.join(repoRoot, 'src', 'lib', 'i18n', 'dictionaries', 'en.ts'),
};
const inject = process.env.EXCEPTION_LABELS_INJECT;

function fail(message) {
  console.error(message);
  process.exit(1);
}

for (const p of [migrationsDir, statusPath, ...Object.values(dictionaries)]) {
  if (!existsSync(p)) fail(`check:exception-labels FAILED — ${p} is not there.`);
}

// ---------------------------------------------------------------- the enum, from the migrations
const values = new Set();
for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(path.join(migrationsDir, name), 'utf8');

  // `create type exception_type as enum ('a','b',...)` — the original list.
  const created = sql.match(/create\s+type\s+exception_type\s+as\s+enum\s*\(([^)]*)\)/i);
  if (created) {
    for (const m of created[1].matchAll(/'([^']+)'/g)) values.add(m[1]);
  }
  // `alter type exception_type add value [if not exists] 'x'` — every later addition.
  for (const m of sql.matchAll(
    /alter\s+type\s+exception_type\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([^']+)'/gi)) {
    values.add(m[1]);
  }
}

if (values.size === 0) {
  fail('check:exception-labels FAILED — parsed zero values out of the `exception_type` enum. The\n'
    + '  migrations changed shape and this guard is measuring nothing.');
}

// ---------------------------------------------------------------- the labels, from the product
let statusSource = readFileSync(statusPath, 'utf8');
const mapMatch = statusSource.match(/export const EXCEPTION_TYPE[^=]*=\s*\{([\s\S]*?)\n\};/);
if (!mapMatch) {
  fail('check:exception-labels FAILED — could not read EXCEPTION_TYPE out of src/lib/status.ts.\n'
    + '  Its shape changed, so this guard can no longer tell a labelled type from an unlabelled one.');
}

const mapped = new Map();      // enum value -> i18n key
for (const m of mapMatch[1].matchAll(/^\s*(\w+)\s*:\s*'([^']+)'/gm)) mapped.set(m[1], m[2]);

const sources = {};
for (const [locale, file] of Object.entries(dictionaries)) sources[locale] = readFileSync(file, 'utf8');

if (inject === 'drop-label') {
  // Take away one label that really is there, the way forgetting to add one leaves it absent.
  const victim = [...mapped.keys()][0];
  mapped.delete(victim);
}

const missingFromMap = [...values].filter((v) => !mapped.has(v)).sort();
const missingFromDictionary = [];
for (const [value, key] of mapped) {
  if (!values.has(value)) continue;   // a label for something the enum no longer has: reported below
  for (const [locale, source] of Object.entries(sources)) {
    if (!new RegExp(`\\b${key}\\s*:`).test(source)) missingFromDictionary.push(`${value} (${locale})`);
  }
}
const labelledButNotInEnum = [...mapped.keys()].filter((v) => !values.has(v)).sort();

const problems = [];
if (missingFromMap.length) {
  problems.push('  Raised by the database, but not in EXCEPTION_TYPE (src/lib/status.ts):\n'
    + missingFromMap.map((v) => `    ${v}`).join('\n')
    + '\n\n    These render as an EMPTY cell on /exceptions, and — because the filter dropdown is\n'
    + '    built by iterating that same map — they cannot be selected at all. An exception nobody\n'
    + '    can filter for is an exception nobody finds.');
}
if (missingFromDictionary.length) {
  problems.push('  Mapped to an i18n key that one of the dictionaries does not define:\n'
    + missingFromDictionary.map((v) => `    ${v}`).join('\n'));
}
if (labelledButNotInEnum.length) {
  problems.push('  Labelled in the product, but not a value the enum has:\n'
    + labelledButNotInEnum.map((v) => `    ${v}`).join('\n')
    + '\n\n    Either the migration that adds it has not landed, or the label outlived its type.');
}

if (problems.length) {
  fail(`check:exception-labels FAILED — ${values.size} value(s) in the exception_type enum:\n\n`
    + `${problems.join('\n\n')}\n`);
}

console.log(`check:exception-labels passed: ${values.size} exception_type value(s), every one `
  + `mapped in EXCEPTION_TYPE and named in both dictionaries.`);

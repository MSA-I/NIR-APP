/**
 * `select('*')` against `suppliers` returns HTTP 403. This makes that a build failure.
 *
 * Migration 0112 took `bank_details` out of the browser's reach with a COLUMN privilege — the only
 * mechanism that can hide a column, since RLS cannot — which means PostgREST's `*` expansion now
 * includes a column the client role may not read, and PostgreSQL refuses the whole statement.
 *
 * The reason this check exists rather than a comment: the failure is invisible where it is written
 * and loud somewhere else entirely. It reached CI as three browser scenarios timing out on "main
 * heading did not become visible", twenty minutes in, with the 403 buried in a captured network
 * log. Nobody reading `select('*')` in a component would connect the two.
 *
 * Embeds are fine and deliberately not flagged: `supplier:suppliers(id, name)` names its columns.
 * What is flagged is the star, on this table, in either the `.from('suppliers').select('*')` form
 * or a PostgREST URL.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: this repository lives under a Hebrew path, and pathname hands
// back a percent-encoded string that scandir cannot open.
const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full)
      : /\.tsx?$/.test(entry) ? [full] : [];
  });
}

const offenders: string[] = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line, index) => {
    // `.from('suppliers')` … `.select('*')` on one line, which is how every call site in this
    // codebase is written, plus the raw REST shape a test or a fixture might use.
    const chained = /from\(\s*['"]suppliers['"]\s*\)[^\n]*select\(\s*['"]\s*\*/.test(line);
    const rest = /suppliers\?select=\*/.test(line);
    if (chained || rest) {
      offenders.push(`${relative(SRC, file)}:${index + 1}  ${line.trim().slice(0, 110)}`);
    }
  });
}

if (offenders.length > 0) {
  console.error('check:supplier-columns FAILED — `select(\'*\')` on suppliers returns HTTP 403.\n');
  offenders.forEach((line) => console.error(`  ${line}`));
  console.error(
    '\n  0112 revoked the column privilege on suppliers.bank_details, so PostgREST\'s `*`'
    + '\n  expansion now asks for a column the client role cannot read and Postgres refuses the'
    + '\n  whole statement. Use SUPPLIER_COLUMNS from src/lib/supplierColumns.ts.'
    + '\n\n  This check exists because the failure surfaces nowhere near where it is written: it'
    + '\n  reached CI as three browser scenarios timing out on a missing heading.');
  process.exit(1);
}

console.log(
  `check:supplier-columns passed: zero \`select('*')\` against suppliers across ${walk(SRC).length} files.`);

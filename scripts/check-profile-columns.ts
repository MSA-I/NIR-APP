/**
 * `select('*')` against `profiles` or `organizations` hands the browser columns no screen renders.
 * This makes that a build failure.
 *
 * Two different costs, and the guard exists for both.
 *
 * The privacy one is live today: `*` on `profiles` returns every colleague's `phone` AND
 * `backup_email` — the address a person nominates so they can recover their account — to every
 * member of the tenant. Measured against production on 05.09.2026 as office and as accountant:
 * six rows, five phone numbers, each time.
 *
 * The breakage one arrives with migration 0319, and it is the reason a comment would not have been
 * enough. Once a COLUMN privilege is revoked — the only mechanism that can hide a column, since
 * RLS cannot — PostgREST's `*` expansion asks for a column the client role may not read and
 * PostgreSQL refuses the ENTIRE statement rather than the one column. The identical failure on
 * `suppliers.bank_details` reached CI as three browser scenarios timing out on "main heading did
 * not become visible", twenty minutes in, with the 403 buried in a captured network log. Nobody
 * reading `select('*')` in a component would connect the two, which is why this is a guard and
 * lives next to `check:supplier-columns`.
 *
 * Embeds are fine and deliberately not flagged: `actor:profiles(id, full_name)` names its columns.
 * What is flagged is the star, on these two tables, in either the `.from('profiles').select('*')`
 * form or a PostgREST URL.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: this repository lives under a Hebrew path, and pathname hands
// back a percent-encoded string that scandir cannot open.
const SRC = fileURLToPath(new URL('../src', import.meta.url));

const TABLES = ['profiles', 'organizations'] as const;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full)
      : /\.tsx?$/.test(entry) ? [full] : [];
  });
}

const files = walk(SRC);
const offenders: string[] = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line, index) => {
    for (const table of TABLES) {
      // `.from('profiles')` … `.select('*')` on one line, which is how every call site in this
      // codebase is written, plus the raw REST shape a test or a fixture might use.
      const chained = new RegExp(`from\\(\\s*['"]${table}['"]\\s*\\)[^\\n]*select\\(\\s*['"]\\s*\\*`).test(line);
      const rest = new RegExp(`${table}\\?select=\\*`).test(line);
      if (chained || rest) {
        offenders.push(`${relative(SRC, file)}:${index + 1}  ${line.trim().slice(0, 110)}`);
      }
    }
  });
}

if (offenders.length > 0) {
  console.error(
    'check:profile-columns FAILED — `select(\'*\')` on profiles/organizations returns columns no'
    + ' screen renders, and HTTP 403 once 0319 lands.\n');
  offenders.forEach((line) => console.error(`  ${line}`));
  console.error(
    '\n  `*` asks PostgREST for every column the table has, so a profiles read hands every member'
    + '\n  of the tenant each colleague\'s phone and backup_email, and an organizations read hands'
    + '\n  them the commercial columns no tenant screen draws. Migration 0319 revokes those column'
    + '\n  privileges, after which the `*` expansion asks for a column the client role cannot read'
    + '\n  and PostgreSQL refuses the whole statement.'
    + '\n\n  Use PROFILE_COLUMNS / ORGANIZATION_COLUMNS from src/lib/accountColumns.ts.'
    + '\n  A colleague\'s phone is read by the owner through organization_people_directory.');
  process.exit(1);
}

console.log(
  `check:profile-columns passed: zero \`select('*')\` against profiles or organizations across ${files.length} files.`);

/**
 * check:exemptions — the definer-exemption pin, checked in milliseconds instead of at minute
 * nineteen of a twenty-minute gate.
 *
 * `private.scope_definer_exemptions` is the ledger of SECURITY DEFINER functions that touch a
 * scope-enforced table without filtering on auth_scopes() (0057). `p9_five_domains.sql` pins its
 * row count so that adding one is a deliberate, argued act rather than a silent widening of the
 * A5 hole — the pin's own comment says "zero silent additions".
 *
 * The pin works. What did not work is WHERE it lives: a suite the author of a migration has no
 * reason to run. Four consecutive waves added an exemption, left the pin alone, and discovered it
 * only when `npm run quality` reached p9 — 0075 (B1), 0077 twice (C2 and C5), each costing a full
 * gate run to find a one-line edit. This script is the same assertion, moved to `npm run build`.
 *
 * It is arithmetic, not a database read, so it runs with no stack: count what the migrations
 * explicitly add and drain, apply it to 0057's seed, and require p9 to agree.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
const p9Path = fileURLToPath(new URL('../supabase/tests/p9_five_domains.sql', import.meta.url));

/**
 * 0057:260-266 seeds the registry from pg_proc, so its size is decided at migration time and
 * cannot be counted from the text. 59 is what that seed produced, and it is not a number this
 * script has to trust: p9 re-reads the live registry every gate run, so a seed that drifts fails
 * there. Here it is only the origin the deltas below are applied to.
 */
const SEED_0057 = 59;

/** An explicit row: `insert into private.scope_definer_exemptions (...) values ( 'sig'::... */
const EXPLICIT_INSERT =
  /insert\s+into\s+private\.scope_definer_exemptions\b[\s\S]*?values\s*\(/gi;

/** A drain: `delete from private.scope_definer_exemptions ... in ( sig, sig, sig )` */
const EXPLICIT_DELETE =
  /delete\s+from\s+private\.scope_definer_exemptions\b([\s\S]*?);/gi;

interface Ledger { file: string; added: number; drained: number }

const ledger: Ledger[] = [];

for (const name of readdirSync(migrationsDir).sort()) {
  if (!name.endsWith('.sql')) continue;
  // 0057 defines and seeds the table; its seed is the baseline, not a delta.
  if (name.startsWith('0057_')) continue;

  const sql = readFileSync(join(migrationsDir, name), 'utf8');
  if (!/private\.scope_definer_exemptions/i.test(sql)) continue;

  const added = [...sql.matchAll(EXPLICIT_INSERT)].length;

  // Each drained signature is one `to_regprocedure('…')` inside the delete's IN list. Counting
  // the statement would say "one" for a delete that removes three, which is exactly what 0073 does.
  let drained = 0;
  for (const [, body] of sql.matchAll(EXPLICIT_DELETE)) {
    drained += [...body.matchAll(/to_regprocedure\s*\(/gi)].length;
  }

  if (added || drained) ledger.push({ file: name, added, drained });
}

const added = ledger.reduce((n, e) => n + e.added, 0);
const drained = ledger.reduce((n, e) => n + e.drained, 0);
const expected = SEED_0057 + added - drained;

const p9 = readFileSync(p9Path, 'utf8');
const pinned = /count\(\*\)\s*from\s+private\.scope_definer_exemptions\s*\)\s*=\s*(\d+)/i.exec(p9);

if (!pinned) {
  console.error(
    'check:exemptions FAILED — could not find the row-count pin in supabase/tests/p9_five_domains.sql.\n'
    + '  The pin is the only thing standing between a new SECURITY DEFINER exemption and a silent\n'
    + '  widening of the A5 hole. If it was deliberately removed, this script must go with it.',
  );
  process.exit(1);
}

const pinnedCount = Number(pinned[1]);

if (pinnedCount !== expected) {
  const rows = ledger
    .map((e) => `    ${e.file}: +${e.added} -${e.drained}`)
    .join('\n');
  console.error(
    `check:exemptions FAILED — the definer exemption registry and its pin disagree.\n\n`
    + `  p9_five_domains.sql pins  : ${pinnedCount}\n`
    + `  the migrations imply      : ${expected}   (0057 seeded ${SEED_0057}, +${added} added, -${drained} drained)\n\n`
    + `${rows}\n\n`
    + `  A migration added or drained an exemption without moving the pin. That is the check\n`
    + `  working, not a nuisance: every row here is a definer that reads a scope-enforced table\n`
    + `  without filtering on auth_scopes(), and the pin exists so adding one is argued rather\n`
    + `  than absorbed. Update supabase/tests/p9_five_domains.sql to ${expected} AND write why the\n`
    + `  new exemption cannot be an invoker — the multi-unit enablement wave reads that reason to\n`
    + `  decide whether the row can ever be drained.`,
  );
  process.exit(1);
}

console.log(
  `check:exemptions passed: pin ${pinnedCount} matches ${ledger.length} migration(s) `
  + `(+${added} / -${drained} over 0057's seed of ${SEED_0057}).`,
);

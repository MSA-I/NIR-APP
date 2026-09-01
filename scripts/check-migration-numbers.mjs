#!/usr/bin/env node
/**
 * check:migration-numbers — two migrations may not carry the same number, and the sequence
 * may not have a hole.
 *
 * WHY. On 31.08.2026 two open pull requests both created `0268`, with different contents, days
 * after #173 fixed the identical accident on owner-decision `#306`. Nothing in the repo said no.
 * The check that was supposed to cover this was `git ls-tree … | sort` in a plan document —
 * which PRINTS a list. It cannot fail. This one exits non-zero.
 *
 * A HOLE matters as much as a duplicate, and less obviously. Production applies migrations
 * forward-only while CI rebuilds from `supabase db reset`. If `0281` lands and `0279` arrives
 * afterwards, production applies 0279 AFTER 0281 while a fresh reset applies it BEFORE — two
 * different schemas from the same files, and no gate says a word. That is not hypothetical: it
 * is how `0279` came to take a foreign key on a table that `0281` had not created yet.
 */
import { readdirSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
let migrationsDir = path.join(repoRoot, 'supabase', 'migrations');

// The injections exist only for check-gate-controls.mjs, which must watch this guard fail on a
// broken sequence before anyone is asked to trust it on a good one. They work on a COPY.
const inject = process.env.MIGRATION_NUMBERS_INJECT;
let scratch = null;
if (inject) {
  scratch = mkdtempSync(path.join(tmpdir(), 'mignum-'));
  cpSync(process.env.MIGRATION_NUMBERS_DIR || migrationsDir, scratch, { recursive: true });
  migrationsDir = scratch;
  const names = readdirSync(scratch).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const last = names.at(-1);
  const lastNumber = Number(last.slice(0, 4));
  if (inject === 'duplicate') {
    writeFileSync(path.join(scratch, `${String(lastNumber).padStart(4, '0')}_a_second_claim.sql`), '-- injected\n');
  } else if (inject === 'gap') {
    writeFileSync(path.join(scratch, `${String(lastNumber + 2).padStart(4, '0')}_after_a_hole.sql`), '-- injected\n');
  }
}

const cleanup = () => { if (scratch) rmSync(scratch, { recursive: true, force: true }); };
function fail(message) {
  cleanup();
  console.error(message);
  process.exit(1);
}

const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));

const malformed = files.filter((f) => !/^\d{4}_[a-z0-9_]+\.sql$/i.test(f));
if (malformed.length) {
  fail('check:migration-numbers FAILED — file name(s) do not match NNNN_name.sql:\n'
    + malformed.map((f) => `    - ${f}`).join('\n'));
}

const byNumber = new Map();
for (const file of files) {
  const n = Number(file.slice(0, 4));
  if (!byNumber.has(n)) byNumber.set(n, []);
  byNumber.get(n).push(file);
}

const duplicates = [...byNumber.entries()].filter(([, list]) => list.length > 1).sort((a, b) => a[0] - b[0]);
if (duplicates.length) {
  fail('check:migration-numbers FAILED — a migration number is used twice:\n\n'
    + duplicates.map(([n, list]) => `    ${String(n).padStart(4, '0')} is used twice:\n`
      + list.map((f) => `      - ${f}`).join('\n')).join('\n\n')
    + '\n\n  Two different changes cannot share one number: the second to be applied is skipped\n'
    + '  or clobbers the first, depending on how it arrived. Renumber the later one, and carry\n'
    + '  the number through the file body too — see check:renumber-closure.');
}

// Four gaps predate this guard. Measured on main at 417775b9: these numbers were claimed and
// abandoned long ago and no file will ever fill them, so they are harmless — a hole is only
// dangerous when something is still expected to land IN it. They are pinned by value rather
// than tolerated by a count, so that a NEW hole cannot hide inside a tolerance.
const HISTORICAL_GAPS = new Set(['0071→0073', '0182→0184', '0191→0195', '0212→0217']);

const numbers = [...byNumber.keys()].sort((a, b) => a - b);
const gaps = [];
for (let i = 1; i < numbers.length; i += 1) {
  const previous = numbers[i - 1];
  const current = numbers[i];
  if (current === previous + 1) continue;
  const span = `${String(previous).padStart(4, '0')}→${String(current).padStart(4, '0')}`;
  if (HISTORICAL_GAPS.has(span)) continue;
  gaps.push({ span, missing: current - previous - 1 });
}

if (gaps.length) {
  fail('check:migration-numbers FAILED — a NEW gap opened in the sequence:\n\n'
    + gaps.map((g) => `    ${g.span} — ${g.missing} number(s) missing`).join('\n')
    + '\n\n  A new gap means a migration is expected to land LATER with a LOWER number. Production\n'
    + '  applies forward-only while CI rebuilds from a reset, so the two would then apply the same\n'
    + '  files in different orders — and if the lower one depends on the higher one, a fresh reset\n'
    + '  simply fails. Close the gap, or renumber the pending migration upward.\n'
    + '  If the number is genuinely abandoned, add the span to HISTORICAL_GAPS with a reason.');
}

cleanup();
console.log(`check:migration-numbers passed: ${files.length} migrations, `
  + `${String(numbers[0]).padStart(4, '0')}–${String(numbers.at(-1)).padStart(4, '0')}, no duplicate and no gap.`);

#!/usr/bin/env node
/**
 * check:renumber-closure — renumbering a migration is not renaming its file.
 *
 * WHY. Four migrations have to be renumbered to land the open pull requests, and the number
 * does not only live in the filename. Measured on the branches: `0281_a_document_carries…`
 * carries its own number 39 times, 23 of them as `raise exception '0281: …'` prefixes;
 * `0279_a_number_that_can_receive…` 20 times; `0280_subscription_activation_email` 10 times;
 * `0268_profile_theme` 18 times including a `$assert_0268$` dollar tag. Plus references from
 * `p9_five_domains.sql`, `DEBT-REGISTER.md` and `billing-webhook/index.ts`.
 *
 * Rename the file alone and you get a database where a runtime failure names the WRONG
 * migration. That is not a cosmetic defect: it is a false clue, in the one place a person looks
 * when something has already gone wrong.
 *
 * WHAT IS AND IS NOT A VIOLATION. Only SELF-REFERENTIAL constructs are checked — the header,
 * `raise exception 'NNNN: …'` prefixes, and `$assert_NNNN$` dollar tags. A migration is allowed
 * to mention another migration in prose ("supersedes 0157"); that is a citation, not a stale
 * identity. Separately, any reference anywhere in the repo to a migration FILENAME that no
 * longer exists is a violation, because that is what a half-finished rename leaves behind.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
const inject = process.env.RENUMBER_CLOSURE_INJECT;

const violations = [];

// ---------------------------------------------------------------- 1. self-reference inside migrations
const files = readdirSync(migrationsDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const known = new Set(files.map((f) => f.slice(0, 4)));

for (const file of files) {
  const own = file.slice(0, 4);
  let body = readFileSync(path.join(migrationsDir, file), 'utf8');

  // Positive control: pretend this file was renamed but its innards were not updated.
  if (inject === 'prefix' && file === files.at(-1)) {
    body += "\ndo $$ begin raise exception '0001: injected by the positive control'; end $$;\n";
  }

  const lines = body.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNo = index + 1;

    for (const m of line.matchAll(/raise\s+exception\s+'(\d{4}):/gi)) {
      if (m[1] !== own) {
        violations.push({ file, lineNo, own, found: m[1], kind: 'raise exception prefix', text: line.trim().slice(0, 96) });
      }
    }
    for (const m of line.matchAll(/\$assert_(\d{4})\$/g)) {
      if (m[1] !== own) {
        violations.push({ file, lineNo, own, found: m[1], kind: 'dollar tag', text: line.trim().slice(0, 96) });
      }
    }
    // The header is line 1 and names the migration it opens.
    if (lineNo === 1) {
      const header = line.match(/^--\s*(\d{4})\b/);
      if (header && header[1] !== own) {
        violations.push({ file, lineNo, own, found: header[1], kind: 'header', text: line.trim().slice(0, 96) });
      }
    }
  });
}

// ---------------------------------------------------------------- 2. references to filenames that do not exist
// A half-finished rename leaves pointers to the old filename in tests, docs and functions.
let referenceHits = [];
try {
  // `--untracked` matters: without it git grep searches only TRACKED files, so this guard would
  // report different results before and after `git add` — a check whose verdict depends on the
  // index is not a check.
  const out = execFileSync('git', ['grep', '--untracked', '-nIoE', '[0-9]{4}_[a-z0-9_]+\\.sql', '--',
    'supabase', 'docs', 'scripts', 'src', '*.md'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  referenceHits = out.split('\n').filter(Boolean);
} catch {
  // git grep exits 1 when there are no matches at all; that is not an error here.
}
// This file names the historical filenames in order to excuse them, and names an invented one
// for the positive control. A guard that trips over the list of things it is told to allow is
// reading its own comment as evidence — the same trap that once broke a scope-enforcement check
// in this repo.
const SELF = 'scripts/check-renumber-closure.mjs';
referenceHits = referenceHits.filter((hit) => !hit.startsWith(`${SELF}:`));
if (inject === 'external') {
  referenceHits.push('supabase/tests/p9_five_domains.sql:1:9999_a_migration_that_never_existed.sql');
}

// Ten dangling names predate this guard, all in prose: teaching examples in a skill file, and
// planning documents that describe migrations as they were numbered at the time. Measured on
// main at 417775b9. Prose about the past is not a broken pointer, so they are pinned BY NAME —
// a new one still fails, and so does any dangling name in an executable surface.
const HISTORICAL_PROSE_REFS = new Set([
  '0067_offline_receiving.sql', '0069_global_search_result_type_gate.sql',
  '0090_alter_suppliers.sql', '0090_supplier_bank_stepup.sql',
  '0095_scope_enforcement_marker_hardening.sql', '0179_alert_rules_engine.sql',
  '0212_profile_locale.sql', '0213_catalogue_translations.sql',
  '0213_profile_locale.sql', '0214_money_carries_its_currency.sql',
]);
// Anywhere a machine reads the name, a dangling pointer is a defect regardless of history.
const EXECUTABLE = /^(supabase\/(tests|functions)|scripts|src)\//;

const existing = new Set(files);
for (const hit of referenceHits) {
  const parts = hit.split(':');
  const name = parts.at(-1);
  const lineNo = parts.at(-2);
  const where = parts.slice(0, -2).join(':');
  if (where.startsWith('supabase/migrations/')) continue; // a migration citing a sibling by name is fine
  if (existing.has(name)) continue;
  const isProse = !EXECUTABLE.test(where);
  if (isProse && HISTORICAL_PROSE_REFS.has(name)) continue;
  violations.push({
    file: where,
    lineNo,
    kind: 'dangling filename reference',
    found: name,
    text: name,
    surface: isProse ? 'prose' : 'executable',
  });
}

// ---------------------------------------------------------------- report
if (violations.length) {
  const bySort = violations.sort((a, b) => `${a.file}${a.lineNo}`.localeCompare(`${b.file}${b.lineNo}`));
  const selfRefs = bySort.filter((v) => v.kind !== 'dangling filename reference');
  const dangling = bySort.filter((v) => v.kind === 'dangling filename reference');

  let message = 'check:renumber-closure FAILED\n';
  if (selfRefs.length) {
    message += `\n  ${selfRefs.length} place(s) where a migration names a different migration as itself:\n\n`
      + selfRefs.map((v) => `    ${v.file}:${v.lineNo}\n`
        + `      the file is ${v.own}, but this ${v.kind} says ${v.found}\n`
        + `      ${v.text}`).join('\n\n');
  }
  if (dangling.length) {
    message += `\n\n  ${dangling.length} reference(s) point at a migration filename that does not exist:\n\n`
      + dangling.map((v) => `    ${v.file}:${v.lineNo} → ${v.found}`).join('\n');
  }
  message += '\n\n  Renumbering carries the number through the whole file and everything that cites it:\n'
    + '  the header, every raise-exception prefix, every dollar tag, and the references in\n'
    + '  supabase/tests, docs and supabase/functions. A rename on its own leaves a database\n'
    + '  whose error messages blame the wrong migration.';
  console.error(message);
  process.exit(1);
}

console.log(`check:renumber-closure passed: ${files.length} migrations, every self-reference matches its own`
  + ` number, ${referenceHits.length} filename reference(s) all resolve.`);

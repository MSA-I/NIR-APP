#!/usr/bin/env node
/**
 * check:renumber-closure — renumbering a migration is not renaming its file.
 *
 * WHY. Four migrations must be renumbered to land the open pull requests, and the number does
 * not only live in the filename. Measured on the branches: `0281_a_document_carries…` carries
 * its own number 39 times across a header, 23 `raise exception '0281: …'` prefixes and SEVEN
 * distinct dollar tags — `$preflight_0281$`, `$source_checks_0281$`, `$actor_checks_0281$`,
 * `$claimer_0281$`, `$packet_0281$`, `$source_fk_0281$`, `$verify_0281$`. `0279_…` carries five
 * more. Rename the file alone and a runtime failure names the WRONG migration: a false clue, in
 * the one place a person looks when something has already gone wrong.
 *
 * THE FIRST VERSION OF THIS GUARD ONLY MATCHED `$assert_NNNN$` AND WOULD HAVE PASSED ALL TWELVE.
 * A guard that names a hazard and then does not look for it is worse than no guard, because it
 * is believed. Hence two independent modes:
 *
 *   generic  — always on. Every dollar tag and every raise-exception prefix inside a migration
 *              must name that migration's OWN number, whatever the tag is called.
 *   map      — on when scripts/renumber-map.json exists. For a declared AAAA → BBBB move, the
 *              old number must appear NOWHERE: not in the file, not in tests, docs, functions
 *              or scripts. This is the mode that guards wave 4, and it does not depend on
 *              guessing which syntaxes carry a number.
 *
 * Prose is allowed to cite a migration ("supersedes 0157"). Self-referential constructs are not.
 */
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
const mapPath = path.join(repoRoot, 'scripts', 'renumber-map.json');
const inject = process.env.RENUMBER_CLOSURE_INJECT;
const SELF = 'scripts/check-renumber-closure.mjs';

const violations = [];
// The one measured cross-reference in the tree: 0187 wraps a block verifying constraints that
// 0157 created. Pinned by file AND number so a stale tag elsewhere still fails.
const ALLOWED_CROSS_TAGS = new Set(['0187_billing_provider_event_processing.sql|0157']);

let scratchRepo = null;

// ---------------------------------------------------------------- 1. self-reference inside migrations
const files = readdirSync(migrationsDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

for (const file of files) {
  const own = file.slice(0, 4);
  let body = readFileSync(path.join(migrationsDir, file), 'utf8');

  if (inject === 'prefix' && file === files.at(-1)) {
    body += "\ndo $$ begin raise exception '0001: injected by the positive control'; end $$;\n";
  }
  if (inject === 'dollartag' && file === files.at(-1)) {
    body += '\ndo $verify_0001$ begin end $verify_0001$;\n';
  }

  body.split(/\r?\n/).forEach((line, index) => {
    const lineNo = index + 1;

    // `e'0281: …'` is as valid as `'0281: …'`, and both were used in this repo.
    for (const m of line.matchAll(/raise\s+exception\s+e?'(\d{4}):/gi)) {
      if (m[1] !== own) {
        violations.push({ file, lineNo, own, found: m[1], kind: 'raise-exception prefix', text: line.trim().slice(0, 96) });
      }
    }
    // ANY dollar tag carrying a four-digit number, not only `$assert_NNNN$`.
    //
    // Measured across all 258 migrations before this rule was enforced: raise-exception prefixes
    // and headers name their own migration 100% of the time, and dollar tags do so with exactly
    // ONE deliberate exception — 0187 opens `$verify_0157_constraints$` around a block that
    // checks constraints 0157 created. That is a real cross-reference, not a stale identity, so
    // it is pinned by file and number rather than weakening the rule for everyone.
    for (const m of line.matchAll(/\$[a-z_]*?(\d{4})[a-z_]*?\$/gi)) {
      if (m[1] !== own && !ALLOWED_CROSS_TAGS.has(`${file}|${m[1]}`)) {
        violations.push({ file, lineNo, own, found: m[1], kind: 'dollar tag', text: line.trim().slice(0, 96) });
      }
    }
    if (lineNo === 1) {
      const header = line.match(/^--\s*(\d{4})\b/);
      if (header && header[1] !== own) {
        violations.push({ file, lineNo, own, found: header[1], kind: 'header', text: line.trim().slice(0, 96) });
      }
    }
  });
}

// ---------------------------------------------------------------- shared scanner
// Fails CLOSED. git grep exits 1 for "no matches" and 0 for matches; anything else is a broken
// scan, and a broken scan must not read as a clean tree.
function grepRepo(pattern, pathspecs, cwd = repoRoot) {
  try {
    const out = execFileSync('git', ['grep', '--untracked', '-nIoE', pattern, '--', ...pathspecs],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').filter(Boolean);
  } catch (error) {
    if (error.status === 1) return [];
    throw new Error(`git grep failed (exit ${error.status}): ${String(error.stderr ?? '').slice(0, 200)}`);
  }
}

const SCAN_PATHS = ['supabase', 'docs', 'scripts', 'src', 'tools', 'worker', '.github', '*.md'];

// ---------------------------------------------------------------- 2. dangling filename references
let referenceHits;
try {
  referenceHits = grepRepo('[0-9]{4}_[a-z0-9_]+\\.sql', SCAN_PATHS);
} catch (error) {
  console.error(`check:renumber-closure FAILED — the reference scan could not run: ${error.message}\n`
    + '  A scan that cannot run is not a clean tree.');
  process.exit(1);
}

// The positive control proves the SCANNER works, not that an array can hold a string: it writes a
// real dangling reference into a throwaway git repo and requires the scan to find it there.
if (inject === 'external') {
  scratchRepo = mkdtempSync(path.join(tmpdir(), 'closure-scan-'));
  execFileSync('git', ['init', '-q'], { cwd: scratchRepo });
  const dir = path.join(scratchRepo, 'supabase', 'tests');
  execFileSync('git', ['config', 'user.email', 'control@local'], { cwd: scratchRepo });
  writeFileSync(path.join(scratchRepo, 'placeholder.md'), 'x\n');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'p9_five_domains.sql'), '-- see 9999_a_migration_that_never_existed.sql\n');
  const found = grepRepo('[0-9]{4}_[a-z0-9_]+\\.sql', ['supabase'], scratchRepo);
  if (!found.length) {
    console.error('check:renumber-closure FAILED — the positive control could not make the scanner\n'
      + '  find a reference it planted. The scanner itself is broken.');
    rmSync(scratchRepo, { recursive: true, force: true });
    process.exit(1);
  }
  referenceHits.push(...found.map((h) => `supabase/tests/${h.split('/').pop()}`));
  rmSync(scratchRepo, { recursive: true, force: true });
}

// The ten dangling names measured on the clean tree, pinned by PATH AND NAME. Pinning by bare
// filename was too loose and the tree proved it: `0213_profile_locale.sql` is cited from TWO
// different planning documents, so a name-only allowlist would have excused a new stale pointer
// in a third. Every entry here is prose describing migrations as they were numbered at the time.
// Because each is pinned to an exact path, the allowlist applies on every surface — precision
// replaces the prose/executable split that used to carry it.
const HISTORICAL_DANGLING_REFS = new Set([
  '.claude/skills/new-migration/SKILL.md|0090_alter_suppliers.sql',
  '.claude/skills/new-migration/SKILL.md|0090_supplier_bank_stepup.sql',
  'docs/DEBT-REGISTER.md|0067_offline_receiving.sql',
  'docs/DEBT-REGISTER.md|0069_global_search_result_type_gate.sql',
  'docs/DEBT-REGISTER.md|0095_scope_enforcement_marker_hardening.sql',
  'docs/PLAN-english-language-20260827.md|0212_profile_locale.sql',
  'docs/PLAN-english-language-20260827.md|0213_catalogue_translations.sql',
  'docs/PLAN-multi-currency-20260828.md|0213_profile_locale.sql',
  'docs/PLAN-multi-currency-20260828.md|0214_money_carries_its_currency.sql',
  'docs/PLAN-tenant-operational-readiness-20260823.md|0179_alert_rules_engine.sql',
]);
// Still used by the renumber-map mode below, where 'live code' vs 'prose about the move' is a
// real distinction: a document may narrate 0281 → 0279; a test may not still call the old one.
const EXECUTABLE = /^(supabase\/(tests|functions)|scripts|src|tools|worker|\.github|\.claude)\//;

const existing = new Set(files);
for (const hit of referenceHits) {
  const parts = hit.split(':');
  const name = parts.at(-1);
  const lineNo = parts.at(-2);
  const where = parts.slice(0, -2).join(':');
  if (where.startsWith('supabase/migrations/')) continue;
  if (where === SELF) continue; // this file names the allowlist it enforces
  if (existing.has(name)) continue;
  if (HISTORICAL_DANGLING_REFS.has(`${where}|${name}`)) continue;
  violations.push({ file: where, lineNo, kind: 'dangling filename reference', found: name, text: name });
}

// ---------------------------------------------------------------- 3. declared renumbers must be complete
// scripts/renumber-map.json: [{ "from": "0281", "to": "0279", "why": "creates the table 0280 needs" }]
let mapEntries = [];
if (existsSync(mapPath)) {
  mapEntries = JSON.parse(readFileSync(mapPath, 'utf8'));
  for (const entry of mapEntries) {
    const stale = grepRepo(`\\b${entry.from}\\b`, SCAN_PATHS)
      .filter((hit) => !hit.startsWith(`${SELF}:`) && !hit.startsWith('scripts/renumber-map.json:'));
    // A citation of the OLD number in prose about the move is legitimate; a live one is not.
    const live = stale.filter((hit) => {
      const where = hit.split(':')[0];
      return EXECUTABLE.test(where) || where.startsWith('supabase/migrations/');
    });
    if (live.length) {
      violations.push({
        file: `renumber ${entry.from} → ${entry.to}`,
        lineNo: '—',
        kind: 'incomplete renumber',
        found: `${live.length} live occurrence(s) of ${entry.from} remain`,
        text: live.slice(0, 8).map((h) => h.split(':').slice(0, 2).join(':')).join(', '),
      });
    }
  }
}

// ---------------------------------------------------------------- report
if (violations.length) {
  const selfRefs = violations.filter((v) => v.kind !== 'dangling filename reference' && v.kind !== 'incomplete renumber');
  const dangling = violations.filter((v) => v.kind === 'dangling filename reference');
  const incomplete = violations.filter((v) => v.kind === 'incomplete renumber');

  let message = 'check:renumber-closure FAILED\n';
  if (selfRefs.length) {
    message += `\n  ${selfRefs.length} place(s) where a migration names a different migration as itself:\n\n`
      + selfRefs.map((v) => `    ${v.file}:${v.lineNo}\n      the file is ${v.own}, but this ${v.kind} says ${v.found}\n      ${v.text}`).join('\n\n');
  }
  if (dangling.length) {
    message += `\n\n  ${dangling.length} reference(s) point at a migration filename that does not exist:\n\n`
      + dangling.map((v) => `    ${v.file}:${v.lineNo} → ${v.found}`).join('\n');
  }
  if (incomplete.length) {
    message += `\n\n  ${incomplete.length} declared renumber(s) are not finished:\n\n`
      + incomplete.map((v) => `    ${v.file}\n      ${v.found}\n      ${v.text}`).join('\n\n');
  }
  message += '\n\n  Renumbering carries the number through the whole file and everything that cites it:\n'
    + '  the header, every raise-exception prefix, EVERY dollar tag whatever it is named, and the\n'
    + '  references in supabase/tests, supabase/functions, docs and scripts.';
  console.error(message);
  process.exit(1);
}

const tagCount = files.reduce((n, f) => n + (readFileSync(path.join(migrationsDir, f), 'utf8')
  .match(/\$[a-z_]*?\d{4}[a-z_]*?\$/gi)?.length ?? 0), 0);
console.log(`check:renumber-closure passed: ${files.length} migrations, ${tagCount} numbered dollar tag(s) and every`
  + ` raise-exception prefix match their own file, ${referenceHits.length} filename reference(s) resolve`
  + `${mapEntries.length ? `, ${mapEntries.length} declared renumber(s) complete` : ''}.`);

#!/usr/bin/env node
/**
 * check:baseline-drift — a guard must not be allowed to bless its own breakage.
 *
 * THE HOLE THIS CLOSES. Every guard in this set compares the tree against a pinned baseline, and
 * every one of them ships a `--write` to move the pin. That is necessary — waves legitimately add
 * suites, migrations and keys — but on its own it means the following passes end to end:
 *
 *     delete a SQL suite from check-quality-gates.ps1
 *     node scripts/check-suite-manifest.mjs --write
 *     every guard green, every control green, the suite gone from CI
 *
 * The baselines cannot see it, because after `--write` the tree and the pin agree again. Only
 * something that reads the PREVIOUS pin can tell. So this compares each baseline against its own
 * version at the merge base and enforces the direction each is allowed to move:
 *
 *   suite manifest    entries may be ADDED. A removal is a suite leaving CI.
 *   migration set     entries may be ADDED. A removal is a migration being withdrawn.
 *   key manifest      orphan names may be REMOVED (a key gained a reader — good). A new name is a
 *                     key that lost its last reader, recorded rather than fixed.
 *
 * Anything moving the wrong way needs a human to say so in the pull request, which is the point:
 * the change becomes an argument instead of a diff nobody reads.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function git(args, allowFail = false) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} failed: ${String(error.stderr ?? '').slice(0, 200)}`);
  }
}

// GitHub gives the PR's base SHA; locally the merge base with main is the same idea.
let base = process.env.BASELINE_DRIFT_BASE;
if (!base) {
  git(['fetch', 'origin', 'main', '--quiet'], true);
  base = (git(['merge-base', 'origin/main', 'HEAD'], true) ?? '').trim();
}
if (!base) {
  console.log('check:baseline-drift skipped: no merge base with origin/main to compare against.');
  process.exit(0);
}

const problems = [];

function previous(relPath) {
  const out = git(['show', `${base}:${relPath}`], true);
  return out === null ? null : JSON.parse(out);
}
function current(relPath) {
  const full = path.join(repoRoot, relPath);
  return existsSync(full) ? JSON.parse(readFileSync(full, 'utf8')) : null;
}

/** `direction` is the move that is ALLOWED; the other one is reported. */
function compare(relPath, extract, { mayLose, mayGain, loseLabel, gainLabel, why }) {
  const before = previous(relPath);
  const after = current(relPath);
  if (!before || !after) return; // new baseline in this branch — nothing to drift from
  const b = new Set(extract(before));
  const a = new Set(extract(after));
  const lost = [...b].filter((x) => !a.has(x));
  const gained = [...a].filter((x) => !b.has(x));

  if (lost.length && !mayLose) {
    problems.push(`${relPath}\n    ${lost.length} ${loseLabel}:\n`
      + lost.slice(0, 20).map((x) => `      - ${x}`).join('\n')
      + (lost.length > 20 ? `\n      … and ${lost.length - 20} more` : '')
      + `\n    ${why}`);
  }
  if (gained.length && !mayGain) {
    problems.push(`${relPath}\n    ${gained.length} ${gainLabel}:\n`
      + gained.slice(0, 20).map((x) => `      + ${x}`).join('\n')
      + (gained.length > 20 ? `\n      … and ${gained.length - 20} more` : '')
      + `\n    ${why}`);
  }
}

compare('scripts/suite-manifest.baseline.json',
  (j) => j.filter((e) => e.kind === 'suite').map((e) => e.path), {
    mayLose: false,
    mayGain: true,
    loseLabel: 'SQL suite(s) were removed from the baseline',
    why: 'A suite leaving the baseline is a suite leaving CI. If it is genuinely retired, say so in\n'
      + '    the pull request description — this guard exists so that removal cannot be silent.',
  });

compare('scripts/migration-set.baseline.json',
  (j) => j, {
    mayLose: false,
    mayGain: true,
    loseLabel: 'migration(s) were removed from the baseline',
    why: 'A migration that has been applied anywhere cannot be withdrawn by deleting its file and\n'
      + '    re-pinning: every database that already ran it stays changed.',
  });

compare('scripts/key-manifest.baseline.json',
  (j) => j.orphans ?? [], {
    mayLose: true,   // a key gaining a reader is the improvement this whole campaign is about
    mayGain: false,
    gainLabel: 'key(s) were ADDED to the orphan baseline',
    why: 'Adding a name here records a key that lost its last production call site instead of\n'
      + '    fixing it — the 7278f787 failure, written down and accepted. Wire the key, or argue\n'
      + '    for it explicitly in the pull request.',
  });

compare('scripts/key-manifest.baseline.json',
  (j) => j.specOnly ?? [], {
    mayLose: true,
    mayGain: false,
    gainLabel: 'key(s) were ADDED to the spec-only baseline',
    why: 'A key only a test still names has no screen asking for it.',
  });

if (problems.length) {
  console.error(`check:baseline-drift FAILED — compared against ${base.slice(0, 8)}\n\n  `
    + problems.join('\n\n  ')
    + '\n\n  Every guard here ships a --write. This is the check that a --write did not simply\n'
    + '  record the breakage it was run to hide.');
  process.exit(1);
}

console.log(`check:baseline-drift passed: baselines moved only in the allowed direction since ${base.slice(0, 8)}.`);

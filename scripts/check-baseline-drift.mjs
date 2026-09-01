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
  // FAILS CLOSED. "I could not find a base to compare against" is not "the baselines are fine".
  // A shallow clone or a failed fetch would otherwise turn this guard off silently, which is the
  // same class of bug as the guards it exists to police.
  console.error('check:baseline-drift FAILED — no merge base with origin/main to compare against.\n'
    + '  The workflow needs fetch-depth: 0. Set BASELINE_DRIFT_BASE explicitly to override.');
  process.exit(1);
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
  if (!before && !after) return;      // never existed — nothing to say
  if (!before) return;                 // new baseline in this branch — nothing to drift from
  if (!after) {                        // it existed at the base and is gone now
    problems.push(`${relPath}\n    the baseline file was DELETED.\n`
      + '    Every guard that reads it skips when it is missing, so removing the file turns the'
      + '\n    guard off and this is the only check that would notice.');
    return;
  }
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

// Full identity, and RELATIVE order — not absolute position. Keying on the index would report
// every entry after an insertion as "moved", which makes adding a suite in the middle look like a
// mass deletion and trains people to ignore the guard. The real rule is that the old baseline must
// still be a SUBSEQUENCE of the new one: additions anywhere are fine, survivors may not reorder.
{
  const relPath = 'scripts/suite-manifest.baseline.json';
  const before = previous(relPath);
  const after = current(relPath);
  if (before && after) {
    const id = (e) => `${e.kind}|${e.path ?? ''}|${e.label}|${e.role ?? ''}`;
    const oldIds = before.map(id);
    const newIds = after.map(id);

    // Walk the new list looking for the old one in order.
    let cursor = 0;
    const missing = [];
    for (const want of oldIds) {
      const at = newIds.indexOf(want, cursor);
      if (at === -1) missing.push(want);
      else cursor = at + 1;
    }
    if (missing.length) {
      problems.push(`${relPath}\n    ${missing.length} gate step(s) were removed, or survived but changed order:\n`
        + missing.slice(0, 20).map((x) => `      - ${x}`).join('\n')
        + (missing.length > 20 ? `\n      … and ${missing.length - 20} more` : '')
        + '\n    A suite leaving the baseline is a suite leaving CI, and the suites share one\n'
        + '    database, so reordering the survivors changes what the later ones observe.');
    }

    // A new reset or preflight is not an ordinary addition: it changes the database state every
    // following suite sees, so it has to be argued for rather than absorbed.
    const structuralBefore = before.filter((e) => e.kind !== 'suite').length;
    const structuralAfter = after.filter((e) => e.kind !== 'suite').length;
    if (structuralAfter > structuralBefore) {
      problems.push(`${relPath}\n    ${structuralAfter - structuralBefore} new reset/preflight step(s) were added.\n`
        + '    These change what every suite after them observes. Say why in the pull request.');
    }
  } else if (before && !after) {
    problems.push(`${relPath}\n    the baseline file was DELETED — every guard that reads it then skips.`);
  }
}

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


// ---------------------------------------------------------------- the renumber map may not shrink
// The map is pinned in wave 0, BEFORE the migrations it describes have landed, precisely so that
// the wave doing the work cannot quietly drop an entry or a reference and then pass its own guard.
// Wave 4 may complete targets. It may not remove a move, drop a reference, or lower a count.
{
  const relPath = 'scripts/renumber-map.json';
  const before = previous(relPath);
  const after = current(relPath);
  if (before && after) {
    const movesOf = (d) => (Array.isArray(d) ? d : (d.moves ?? []));
    const keyOfMove = (m) => `${m.fromFile} -> ${m.toFile}`;
    const beforeMoves = new Map(movesOf(before).map((m) => [keyOfMove(m), m]));
    const afterMoves = new Map(movesOf(after).map((m) => [keyOfMove(m), m]));

    for (const [key, was] of beforeMoves) {
      const now = afterMoves.get(key);
      if (!now) {
        problems.push(`${relPath}\n    a declared renumber DISAPPEARED: ${key}\n`
          + '    The map is pinned before the work so the wave cannot shrink what it is measured against.');
        continue;
      }
      const wasRefs = new Map((was.references ?? [])
        .map((r) => (typeof r === 'string' ? [r, 1] : [r.path, r.occurrences ?? 1])));
      const nowRefs = new Map((now.references ?? [])
        .map((r) => (typeof r === 'string' ? [r, 1] : [r.path, r.occurrences ?? 1])));
      for (const [refPath, count] of wasRefs) {
        if (!nowRefs.has(refPath)) {
          problems.push(`${relPath}\n    ${key}: the reference ${refPath} was REMOVED from the map.\n`
            + '    A reference dropped from the map is a file that will keep citing the old number.');
        } else if (nowRefs.get(refPath) < count) {
          problems.push(`${relPath}\n    ${key}: ${refPath} occurrence count fell from ${count} to `
            + `${nowRefs.get(refPath)}.\n    Lowering the count shrinks the work the guard will check for.`);
        }
      }
      if ((now.sourceOid ?? was.sourceOid) !== was.sourceOid) {
        problems.push(`${relPath}\n    ${key}: sourceOid changed. The move is pinned to the exact blob it was`
          + '\n    measured against; a different source is a different change.');
      }
    }
  }
}

if (problems.length) {
  console.error(`check:baseline-drift FAILED — compared against ${base.slice(0, 8)}\n\n  `
    + problems.join('\n\n  ')
    + '\n\n  Every guard here ships a --write. This is the check that a --write did not simply\n'
    + '  record the breakage it was run to hide.');
  process.exit(1);
}

console.log(`check:baseline-drift passed: baselines moved only in the allowed direction since ${base.slice(0, 8)}.`);

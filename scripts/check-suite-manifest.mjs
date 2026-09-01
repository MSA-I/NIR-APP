#!/usr/bin/env node
/**
 * check:suite-manifest — a suite that disappears in a merge must fail the build.
 *
 * WHY THIS EXISTS, AND WHY THE OLD CHECK WAS NOT ENOUGH.
 * `scripts/ci-sql-suites.mjs --list` prints "N SQL suites". A net COUNT survives the exact
 * accident this guard is for: a merge that drops one suite and adds another leaves N unchanged,
 * and CI then runs a set nobody chose. `scripts/check-quality-gates.ps1` is touched by eleven
 * open pull requests at once, and `ci-sql-suites.mjs` PARSES it at runtime — so a botched
 * conflict resolution there removes a suite from CI silently, with a green tick.
 *
 * So this compares the IDENTITY of every entry, not how many there are: kind, path, label,
 * role, and ORDINAL. Order is part of the contract because the suites share one database and
 * a reset in the wrong place changes what the later ones observe.
 *
 * Two parsers would drift, and drift is the thing being guarded against. This one re-derives
 * the sequence and then asserts its own suite list matches what `ci-sql-suites.mjs --list`
 * reports; if the two ever disagree, that disagreement is itself a failure.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
// The two overrides exist only so the positive control (check-gate-controls.mjs) can prove this
// guard fails on a mutated copy WITHOUT touching the real registry. Nothing else sets them.
const gatePath = process.env.SUITE_MANIFEST_GATE_PATH || path.join(repoRoot, 'scripts', 'check-quality-gates.ps1');
const baselinePath = process.env.SUITE_MANIFEST_BASELINE_PATH || path.join(repoRoot, 'scripts', 'suite-manifest.baseline.json');
const isControlRun = Boolean(process.env.SUITE_MANIFEST_GATE_PATH);

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------- parse the registry
// Mirrors ci-sql-suites.mjs: only the region after the mutex is taken is the actual run.
const source = readFileSync(gatePath, 'utf8');
const startIndex = source.indexOf('$qaMutex = Enter-QaMutex');
if (startIndex < 0) fail('check:suite-manifest FAILED — could not find the start of the gate run in check-quality-gates.ps1.');
const body = source.slice(startIndex);

const sequence = [];
const lineRe = /^\s*(Invoke-SqlTest|Invoke-Preflight|Reset-LocalDatabase)\b(.*)$/gm;
for (const match of body.matchAll(lineRe)) {
  const [, kind, rest] = match;
  if (kind === 'Reset-LocalDatabase') {
    sequence.push({ kind: 'reset', path: null, label: 'supabase db reset', role: null });
    continue;
  }
  if (kind === 'Invoke-Preflight') {
    sequence.push({ kind: 'preflight', path: 'supabase/tests/p1_preflight.sql', label: 'P1 preflight', role: null });
    continue;
  }
  const args = [...rest.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (args.length < 2) fail(`check:suite-manifest FAILED — unparsable Invoke-SqlTest call: ${match[0].trim()}`);
  sequence.push({
    kind: 'suite',
    path: args[0].replace(/\\/g, '/'),
    label: args[1],
    role: args[2] ?? 'postgres',
  });
}

// The runner drops trailing resets (no SQL consumer after them); mirror that so the two agree.
while (sequence.at(-1)?.kind === 'reset') sequence.pop();

if (sequence.filter((s) => s.kind === 'suite').length === 0) {
  fail('check:suite-manifest FAILED — parsed zero SQL suites. The parser and the gate have diverged.');
}

const manifest = sequence.map((entry, ordinal) => ({ ordinal, ...entry }));
const keyOf = (e) => `${e.kind} ${e.path ?? ''} ${e.label} ${e.role ?? ''}`;

// ---------------------------------------------------------------- agree with the real runner
// If this file's parser and the runner's parser diverge, the manifest describes a sequence CI
// does not run — worse than no guard, because it is believed. So this fails CLOSED in all three
// ways it can go wrong: the runner refusing to run, the runner reporting nothing, and the two
// disagreeing. And it compares identity, not just filenames: a changed role or label is a
// different suite even when the path is the same.
if (!isControlRun) {
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'ci-sql-suites.mjs'), '--list'],
      { encoding: 'utf8', cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    fail('check:suite-manifest FAILED — could not run scripts/ci-sql-suites.mjs --list to confirm this\n'
      + '  guard and the real runner agree. "Could not check" must never read as "checked".\n'
      + `  ${String(error.stderr ?? error.stdout ?? error.message).split('\n').slice(0, 3).join(' ')}`);
  }
  // `suite  <path>  <label>  [role]` — role is omitted for the default.
  const runner = [...out.matchAll(/^suite\s+(\S+)\s+(.*?)\s*(?:\[([^\]]+)\])?\s*$/gm)]
    .map((m) => `${m[1]}|${(m[2] ?? '').trim()}|${m[3] ?? 'postgres'}`);
  const mine = manifest.filter((e) => e.kind === 'suite').map((e) => `${e.path}|${e.label}|${e.role}`);
  if (runner.length === 0) {
    fail('check:suite-manifest FAILED — the runner reported zero suites. Either the gate is empty\n'
      + '  or its output format changed; either way this guard is measuring nothing.');
  }
  if (runner.join('\n') !== mine.join('\n')) {
    const at = mine.findIndex((x, i) => x !== runner[i]);
    fail('check:suite-manifest FAILED — this guard and scripts/ci-sql-suites.mjs disagree about\n'
      + '  what CI runs. One of the two parsers is wrong; fix that before trusting either.\n'
      + `  guard: ${mine.length} suites · runner: ${runner.length} suites\n`
      + (at >= 0 ? `  first difference at #${at}:\n    guard:  ${mine[at]}\n    runner: ${runner[at] ?? '(nothing)'}` : ''));
  }
}

// ---------------------------------------------------------------- write mode
if (process.argv.includes('--write')) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(baselinePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`check:suite-manifest — baseline written: ${manifest.length} entries (${manifest.filter((e) => e.kind === 'suite').length} suites).`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  fail('check:suite-manifest FAILED — no baseline. Create it once with:\n'
    + '  node scripts/check-suite-manifest.mjs --write');
}

// ---------------------------------------------------------------- compare
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

// Entries are NOT unique by identity — `Reset-LocalDatabase` appears three times with the same
// kind, path, label and role. Keying a Map by identity silently collapses those three into one
// and then reports every reset as having moved. So compare as MULTISETS, and compare order as a
// subsequence, which is what "the reset sits between these two suites" actually means.
const tally = (list) => {
  const counts = new Map();
  for (const e of list) counts.set(keyOf(e), (counts.get(keyOf(e)) ?? 0) + 1);
  return counts;
};
const baseCounts = tally(baseline);
const nowCounts = tally(manifest);

const removed = [];
for (const [key, count] of baseCounts) {
  const missing = count - (nowCounts.get(key) ?? 0);
  if (missing > 0) {
    const sample = baseline.find((e) => keyOf(e) === key);
    removed.push({ ...sample, missing, hadCount: count });
  }
}
const added = [];
for (const [key, count] of nowCounts) {
  const extra = count - (baseCounts.get(key) ?? 0);
  if (extra > 0) {
    const sample = manifest.find((e) => keyOf(e) === key);
    added.push({ ...sample, extra });
  }
}

// Order: every entry that survived must keep its relative position. Drop the newly added ones
// from the current sequence and the result must equal the baseline sequence exactly.
const addedKeyBudget = new Map(added.map((e) => [keyOf(e), e.extra]));
const survivors = [];
for (const entry of manifest) {
  const key = keyOf(entry);
  const budget = addedKeyBudget.get(key) ?? 0;
  if (budget > 0) { addedKeyBudget.set(key, budget - 1); continue; }
  survivors.push(entry);
}
const baselineOrder = baseline.map(keyOf);
const survivorOrder = survivors.map(keyOf);
const moved = [];
if (survivorOrder.join(' ') !== baselineOrder.join(' ')) {
  for (let i = 0; i < Math.max(survivorOrder.length, baselineOrder.length); i += 1) {
    if (survivorOrder[i] !== baselineOrder[i]) {
      moved.push({ at: i, was: baselineOrder[i] ?? '(nothing)', now: survivorOrder[i] ?? '(nothing)' });
      break; // the first divergence is the actionable one; the rest cascade from it
    }
  }
}

const duplicates = [];
const seen = new Set();
for (const entry of manifest) {
  if (entry.kind !== 'suite') continue;
  if (seen.has(entry.path)) duplicates.push(entry.path);
  seen.add(entry.path);
}

const describe = (e) => `${String(e.ordinal).padStart(3)}  ${e.kind.padEnd(9)} ${e.path ?? '—'}`;
const problems = [];

// A REMOVAL is never acceptable on its own. An addition is expected work, and is reported so a
// reviewer sees what the wave claimed to add — but it does not fail the build by itself.
if (removed.length) {
  problems.push(`${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} DISAPPEARED from the gate:\n`
    + removed.map((e) => `    - ${e.kind.padEnd(9)} ${e.path ?? e.label}`
      + (e.hadCount > 1 ? `  (${e.hadCount} → ${e.hadCount - e.missing})` : '')
      + `\n      ${e.label}`).join('\n'));
}
if (duplicates.length) {
  problems.push(`${duplicates.length} suite path(s) registered more than once:\n`
    + duplicates.map((p) => `    - ${p}`).join('\n'));
}
if (moved.length) {
  problems.push('order changed — the suites share one database, so a reset in a different place\n'
    + '    changes what every later suite observes:\n'
    + moved.map((m) => `    - at position ${m.at}: expected "${m.was}"\n      but found  "${m.now}"`).join('\n'));
}

// An ADDITION is not free either. Letting additions pass silently opens a two-wave hole: wave N
// adds p94 without re-baselining (the guard prints it and passes), wave N+1 deletes p94, the tree
// matches the stale baseline again, and the suite is gone with every check green. So the manifest
// must EQUAL the baseline — which forces every add and every removal to appear as a baseline diff
// in the same pull request, where a person can see it.
if (added.length) {
  problems.push(`${added.length} entr${added.length === 1 ? 'y is' : 'ies are'} in the gate but not in the baseline:\n`
    + added.map((e) => `    + ${e.kind.padEnd(9)} ${e.path ?? e.label}`).join('\n')
    + '\n    Re-baseline in this same commit so the addition is reviewable in the diff.');
}
// A new reset or preflight changes the database state every LATER suite observes, so it is named
// separately rather than folded in with an ordinary suite addition.
const structural = added.filter((e) => e.kind !== 'suite');
if (structural.length) {
  problems.push(`${structural.length} new reset/preflight entr${structural.length === 1 ? 'y' : 'ies'} — these change\n`
    + '    what every following suite sees. Argue for it explicitly:\n'
    + structural.map((e) => `    + ${e.kind} at position ${e.ordinal}`).join('\n'));
}

if (problems.length) {
  fail('check:suite-manifest FAILED\n\n  ' + problems.join('\n\n  ') + '\n\n'
    + '  If every change above is intended, re-baseline in the SAME commit that makes it:\n'
    + '    node scripts/check-suite-manifest.mjs --write\n'
    + '  Re-baselining alongside an unexplained removal is how a suite leaves CI unnoticed —\n'
    + '  so the baseline diff is the thing to read in review, not this message.');
}

const suiteCount = manifest.filter((e) => e.kind === 'suite').length;
console.log(`check:suite-manifest passed: ${manifest.length} entries, ${suiteCount} suites, identical to`
  + ' the baseline in identity and order, and in agreement with what ci-sql-suites.mjs would run.');

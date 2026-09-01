#!/usr/bin/env node
/**
 * check:key-manifest — WHICH keys lost their reader, not how many.
 *
 * WHY A SECOND GUARD NEXT TO check:orphan-keys. That one pins a COUNT (130). A count is exactly
 * what the accident it commemorates can survive. Merge `7278f787` resolved i18n conflicts by
 * keeping "main's wording", which silently deleted 439 `t()` calls across 41 files — Expenses.tsx
 * went from 59 to zero — while the screens kept rendering Hebrew beside the untouched English
 * keys. Nothing went red.
 *
 * Eight open pull requests touch he.ts and en.ts right now, and several land in the same wave.
 * Wire one orphan, strand a different key, and the total is still 130: the ratchet is satisfied
 * and a screen has gone quiet. So this pins the exact NAMES.
 *
 * IT ALSO CLOSES A BLIND SPOT. check:orphan-keys counts a spec as a call site, so a key whose
 * screen stopped asking for it but whose test still names it reads as healthy — which is
 * precisely the 7278f787 shape. Here a call site means PRODUCTION code. Measured when this was
 * written: 5,672 leaf keys, 5,216 after the dynamic namespaces and plural siblings that no
 * literal search can see, 5,086 with a production call site, 130 with none, and zero that only a
 * spec still reads. That last number is why switching to production-only cost nothing today —
 * and why it is worth fixing before it does.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const dictionary = path.join(repoRoot, 'src/lib/i18n/dictionaries/he.ts');
const baselinePath = process.env.KEY_MANIFEST_BASELINE_PATH
  || path.join(repoRoot, 'scripts', 'key-manifest.baseline.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Resolved by template — `t(`status.${row.status}`)` — so no literal search can ever find them.
// Excluded by name rather than reported as hundreds of false orphans, which is what would make
// this guard the kind people learn to ignore.
const DYNAMIC_NAMESPACES = new Set(['status', 'errors']);

const NAMESPACE = /^ {2}([A-Za-z0-9_]+): \{/;
const SUBSPACE = /^ {4}([A-Za-z0-9_]+): \{/;
const CLOSE = /^ {4}\},?$/;
const LEAF = /^\s+([A-Za-z0-9_]+):\s*['"`]/;

function leafKeys(file) {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const keys = [];
  let namespace = null;
  let sub = null;
  for (const line of source.split(/\r?\n/)) {
    let m = line.match(NAMESPACE);
    if (m) { namespace = m[1]; sub = null; continue; }
    m = line.match(SUBSPACE);
    if (m) { sub = m[1]; continue; }
    if (CLOSE.test(line)) { sub = null; continue; }
    m = line.match(LEAF);
    if (m && namespace) keys.push(sub ? `${namespace}.${sub}.${m[1]}` : `${namespace}.${m[1]}`);
  }
  return keys;
}

const isSpec = (rel) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(rel);

function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { sources(full, out); continue; }
    if (!/\.tsx?$/.test(entry)) continue;
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    if (rel.includes('/i18n/dictionaries/')) continue;
    out.push({ rel, text: readFileSync(full, 'utf8') });
  }
  return out;
}

const keys = leafKeys(dictionary);
const files = sources(path.join(repoRoot, 'src'));
let production = files.filter((f) => !isSpec(f.rel));
const specs = files.filter((f) => isSpec(f.rel));

// The injections drive check-gate-controls.mjs. They strip a real literal out of the in-memory
// source so the SCANNER has to notice, rather than poking the comparison afterwards — a control
// that edits the answer proves only that arithmetic works.
const inject = process.env.KEY_MANIFEST_INJECT;
let injectedKey = null;
if (inject === 'strand' || inject === 'offset') {
  const baselineNames = new Set(existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8')).orphans : []);
  const wired = keys.find((k) => !DYNAMIC_NAMESPACES.has(k.split('.')[0])
    && !k.endsWith('_one') && !baselineNames.has(k)
    && production.some((f) => f.text.includes(`'${k}'`)));
  if (!wired) {
    console.error('check:key-manifest FAILED — the control could not find a wired key to strand.');
    process.exit(1);
  }
  injectedKey = wired;
  production = production.map((f) => ({
    rel: f.rel,
    text: f.text.split(`'${wired}'`).join("'__stranded_by_control__'"),
  }));
}

// A drop of one call site is refactoring. Losing the LAST production call site is the defect, so
// that is the transition this measures.
const names = (list, key) => list.filter((f) => f.text.includes(`'${key}'`)
  || f.text.includes(`"${key}"`) || f.text.includes(`\`${key}\``)).map((f) => f.rel);

const considered = keys.filter((k) => !DYNAMIC_NAMESPACES.has(k.split('.')[0]) && !k.endsWith('_one'));
const orphans = [];
const specOnly = [];
for (const key of considered) {
  const prod = names(production, key);
  if (prod.length) continue;
  const spec = names(specs, key);
  if (spec.length) specOnly.push({ key, spec });
  orphans.push(key);
}
orphans.sort();

// If everything looks orphaned, the search is broken and an alarming number would be read as a
// finding rather than as a bug in this file.
if (orphans.length > considered.length / 2) {
  fail(`check:key-manifest FAILED — ${orphans.length} of ${considered.length} keys look unreachable,\n`
    + '  which means this guard is broken rather than the dictionary.');
}

if (process.argv.includes('--write')) {
  writeFileSync(baselinePath, `${JSON.stringify({
    note: 'Keys with no PRODUCTION call site. Names, not a count: four pull requests in one wave '
      + 'can wire one key and strand another while the total stands still.',
    considered: considered.length,
    orphans,
  }, null, 2)}\n`, 'utf8');
  console.log(`check:key-manifest — baseline written: ${orphans.length} orphan name(s) of ${considered.length} keys.`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  fail('check:key-manifest FAILED — no baseline. Create it once with:\n'
    + '  node scripts/check-key-manifest.mjs --write');
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const known = new Set(baseline.orphans);
if (inject === 'offset') {
  // Wire one previously-orphaned key at the same moment another is stranded. The COUNT does not
  // move, which is exactly how a count-based ratchet is defeated by four pull requests landing in
  // one wave. The names still differ, so this must fail.
  const rescuedByControl = baseline.orphans[0];
  const i = orphans.indexOf(rescuedByControl);
  if (i >= 0) orphans.splice(i, 1);
}
const nowSet = new Set(orphans);

const stranded = orphans.filter((k) => !known.has(k));
const rescued = baseline.orphans.filter((k) => !nowSet.has(k));

const problems = [];
if (stranded.length) {
  problems.push(`${stranded.length} key(s) LOST their last production call site:\n`
    + stranded.slice(0, 30).map((k) => `    - ${k}`).join('\n')
    + (stranded.length > 30 ? `\n    … and ${stranded.length - 30} more` : '')
    + '\n\n    Either a screen stopped asking for it, or it was written and never wired.\n'
    + '    This is the shape of merge 7278f787: the key is still translated, and the screen\n'
    + '    beside it has gone back to reading Hebrew.');
}
if (specOnly.length) {
  problems.push(`${specOnly.length} key(s) are read ONLY by a spec:\n`
    + specOnly.slice(0, 15).map((s) => `    - ${s.key}  (${s.spec[0]})`).join('\n')
    + '\n\n    A test still names it, so a count-based guard sees nothing wrong, but no screen\n'
    + '    asks for it any more.');
}
if (rescued.length) {
  problems.push(`${rescued.length} key(s) gained a call site and are no longer orphaned:\n`
    + rescued.slice(0, 30).map((k) => `    + ${k}`).join('\n')
    + '\n\n    Good — re-baseline in the SAME commit so the improvement is recorded and cannot\n'
    + '    silently pay for a regression elsewhere in the same wave.');
}

if (problems.length) {
  fail(`check:key-manifest FAILED\n\n  ${problems.join('\n\n  ')}\n\n`
    + '  Re-baseline deliberately, in the commit that causes the change:\n'
    + '    node scripts/check-key-manifest.mjs --write\n'
    + '  The point of naming them is that a wave cannot wire one key, strand another, and\n'
    + '  leave the total looking untouched.');
}

console.log(`check:key-manifest passed: ${considered.length} keys considered, ${orphans.length} without a`
  + ' production call site — the same names as the baseline, none newly stranded, none spec-only.');

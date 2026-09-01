#!/usr/bin/env node
/**
 * next-free-number — ask before you pick, so two pull requests cannot pick the same one.
 *
 * WHY THIS EXISTS. On 01.09.2026 a seven-wave merge produced SIX numbering collisions, and git
 * conflicted on none of them:
 *
 *   #309   chosen by THREE pull requests for three unrelated rulings (#180, #176, #197)
 *   #310   chosen twice
 *   §86 §87 §88   all three defined twice
 *   0268   two migrations
 *   0279/0280/0281   arrived in an order that made 0279 depend on a migration numbered after it
 *
 * Every one of them was caught, but only AFTER the number had been written into the code —
 * nineteen citations in one case. The guards catch collisions; this removes the reason they
 * happen. Each agent opened the file, saw the highest number, and added one. Three agents did
 * that in parallel and none could see the others.
 *
 * The answer is not a bigger guard. It is a question with one answer, asked from the live tree:
 *
 *     node scripts/next-free-number.mjs decision
 *     node scripts/next-free-number.mjs debt
 *     node scripts/next-free-number.mjs migration
 *     node scripts/next-free-number.mjs suite
 *     node scripts/next-free-number.mjs            (all four)
 *
 * It reads what is on disk AND, when a remote is reachable, what is on origin/main and on every
 * other branch — because the number you collide with is usually the one a branch you have never
 * seen has already taken. `--local` skips the branch scan when there is no network.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const localOnly = process.argv.includes('--local');

function git(args, { allowFail = true } = {}) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowFail) return '';
    throw error;
  }
}

/**
 * Refs worth scanning: `refs/remotes/origin/*` only, and only those actually AHEAD of main.
 *
 * Not every ref. A tree that has fetched pull-request heads carries hundreds of them, most long
 * merged, and they report numbers that a later edit has since renumbered or removed — noise that
 * makes the answer look wrong and the tool ignorable. What matters is live work: a branch someone
 * might still merge, holding a number main has not seen.
 */
function branches() {
  if (localOnly) return [];
  const out = git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']);
  const all = out.split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((r) => !r.endsWith('/HEAD') && !r.endsWith('/main'));
  return all.filter((r) => {
    const ahead = git(['rev-list', '--count', `origin/main..${r}`]).trim();
    return ahead !== '' && ahead !== '0';
  });
}

/** Numbers taken in one ref, or on disk when ref is null. */
function taken(kind, ref) {
  const nums = new Set();
  const add = (v) => { const n = Number(v); if (Number.isFinite(n)) nums.add(n); };

  if (kind === 'migration' || kind === 'suite') {
    const dir = kind === 'migration' ? 'supabase/migrations' : 'supabase/tests';
    const listing = ref
      ? git(['ls-tree', '-r', '--name-only', ref, dir])
      : (existsSync(path.join(repoRoot, dir)) ? readdirSync(path.join(repoRoot, dir)).join('\n') : '');
    for (const line of listing.split('\n')) {
      const base = line.split('/').pop() ?? '';
      const m = kind === 'migration' ? base.match(/^(\d{4})_/) : base.match(/^p(\d+)[_a-z]/);
      if (m) add(m[1]);
    }
    return nums;
  }

  const file = kind === 'decision' ? 'docs/OPEN-DECISIONS.md' : 'docs/DEBT-REGISTER.md';
  let text = '';
  if (ref) text = git(['show', `${ref}:${file}`]);
  else if (existsSync(path.join(repoRoot, file))) text = readFileSync(path.join(repoRoot, file), 'utf8');

  // A decision is a table row `| 331 | …`; a debt item is a heading `### §92 — …`.
  const re = kind === 'decision' ? /^\|\s*(\d{2,3})\s*\|/gm : /^###\s*§(\d+)\b/gm;
  for (const m of text.matchAll(re)) add(m[1]);
  return nums;
}

const KINDS = {
  decision:  { label: 'owner ruling',      where: 'docs/OPEN-DECISIONS.md', pad: 0, prefix: '#' },
  debt:      { label: 'debt section',      where: 'docs/DEBT-REGISTER.md',  pad: 0, prefix: '§' },
  migration: { label: 'migration',         where: 'supabase/migrations/',   pad: 4, prefix: '' },
  suite:     { label: 'SQL suite',         where: 'supabase/tests/',        pad: 0, prefix: 'p' },
};

const asked = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const kinds = asked.length ? asked : Object.keys(KINDS);
for (const k of kinds) {
  if (!KINDS[k]) {
    console.error(`unknown kind "${k}". Try: ${Object.keys(KINDS).join(', ')}`);
    process.exit(2);
  }
}

const refs = [null, ...branches()];
let anyRemote = refs.length > 1;

for (const kind of kinds) {
  const spec = KINDS[kind];
  const all = new Set();
  const perRef = new Map();
  for (const ref of refs) {
    const t = taken(kind, ref);
    if (ref) perRef.set(ref, t);
    for (const n of t) all.add(n);
  }
  if (!all.size) {
    console.log(`${kind}: nothing found — is ${spec.where} where it should be?`);
    continue;
  }
  const max = Math.max(...all);
  const next = max + 1;
  const show = (n) => spec.prefix + String(n).padStart(spec.pad, '0');

  // The number a branch has claimed but main has not seen is exactly the collision this prevents,
  // so it is named rather than merely counted.
  const onDisk = taken(kind, null);
  const claimedElsewhere = [...all].filter((n) => !onDisk.has(n)).sort((a, b) => a - b);

  console.log(`\n${spec.label} — next free: ${show(next)}`);
  console.log(`  highest anywhere: ${show(max)}   (${all.size} taken, scanned ${refs.length - 1} branch(es) + working tree)`);
  if (claimedElsewhere.length) {
    const who = claimedElsewhere.slice(0, 6).map((n) => {
      const refsWith = [...perRef.entries()].filter(([, t]) => t.has(n)).map(([r]) => r.replace('refs/remotes/', ''));
      return `${show(n)} on ${refsWith[0] ?? '?'}${refsWith.length > 1 ? ` +${refsWith.length - 1}` : ''}`;
    });
    console.log(`  CLAIMED ON A BRANCH BUT NOT IN YOUR TREE: ${who.join(', ')}${claimedElsewhere.length > 6 ? ` … and ${claimedElsewhere.length - 6} more` : ''}`);
    console.log('  Those are the ones git will merge without a conflict. Do not reuse them.');
  }
}

if (!anyRemote && !localOnly) {
  console.log('\nNOTE: no remote refs were readable, so this saw only your working tree.');
  console.log('A number another branch has already taken would not appear. Fetch, then ask again.');
}

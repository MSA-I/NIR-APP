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
 *     node scripts/next-free-number.mjs decision
 *     node scripts/next-free-number.mjs debt
 *     node scripts/next-free-number.mjs migration
 *     node scripts/next-free-number.mjs suite
 *     node scripts/next-free-number.mjs            (all four)
 *
 * WHAT IT READS, and why each one is there:
 *
 *   1. origin/main         — the numbers everyone has already agreed on. Your checkout may be
 *                            behind it; main is read from the ref, not from your tree.
 *   2. your working tree   — what you have written and not yet committed.
 *   3. local branches      — sibling worktrees on this machine. Parallel agents live there, and a
 *                            number they wrote an hour ago is not on any remote yet.
 *   4. origin/* branches   — work someone else has pushed.
 *
 * A branch counts only while it looks ALIVE: ahead of origin/main and not stale. Stale means its
 * tip is older than 14 days or it is more than 20 commits behind origin/main. Stale branches are
 * LISTED with the numbers they hold but not counted, because an abandoned draft or a superseded
 * twin is "ahead of main" forever and would inflate the answer (measured 02.09.2026: one abandoned
 * draft pushed the ruling counter from #332 to #344 and parked twelve numbers nobody would merge).
 * `--include-stale` counts them anyway.
 * ponytail: staleness is a threshold, not knowledge. If it misjudges a branch, the upgrade path is
 * `gh pr list --state open` — a branch with an open PR is alive by definition — with this as fallback.
 *
 * It FETCHES first (`git fetch --prune origin`) so origin/* is current; `--local` skips the fetch
 * and prints how old the remote refs are instead. It never guesses: a git command that fails is
 * reported by name at the end, and a missing origin/main is a hard stop (exit 2), not a quiet zero.
 *
 * Exit codes: 0 answered · 1 COLLISION (a number in your tree is also on a live branch and not on
 * main — someone must renumber before merge) · 2 usage error or origin/main unreadable.
 *
 * `--repo=<path>` points at another checkout (the spec uses it against a fixture repository).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const localOnly = flag('local');
const includeStale = flag('include-stale');
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(option('repo') ?? path.resolve(here, '..'));

const MAIN = 'refs/remotes/origin/main';
const STALE_DAYS = 14;
const STALE_BEHIND = 20;

/** Every git failure, named. Printed at the end so a silent '' can never pose as "no numbers". */
const problems = [];

function git(args, { quiet = false } = {}) {
  try {
    const out = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024, // docs/OPEN-DECISIONS.md is already 326 KB; the default 1 MiB would one day return '' and look like "nothing here"
    });
    return { ok: true, out };
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim().split('\n')[0];
    if (!quiet) problems.push(`git ${args.slice(0, 2).join(' ')}: ${stderr || error.code || error.message}`);
    return { ok: false, out: '', stderr };
  }
}

/** `git show ref:path`, where "that ref has no such file" is a normal answer, not a failure. */
function fileAt(ref, file) {
  const r = git(['show', `${ref}:${file}`], { quiet: true });
  if (r.ok) return r.out;
  if (/does not exist|exists on disk, but not in|not a tree/.test(r.stderr ?? '')) return '';
  problems.push(`git show ${ref}:${file}: ${r.stderr || 'failed'}`);
  return '';
}

function remoteRefsAge() {
  const common = git(['rev-parse', '--git-common-dir'], { quiet: true }).out.trim();
  const fetchHead = path.resolve(repoRoot, common || '.git', 'FETCH_HEAD');
  if (!existsSync(fetchHead)) return 'never fetched';
  const hours = (Date.now() - statSync(fetchHead).mtimeMs) / 36e5;
  return hours < 48 ? `${hours.toFixed(1)} h old` : `${Math.round(hours / 24)} days old`;
}

const KINDS = {
  decision: {
    label: 'owner ruling', where: 'docs/OPEN-DECISIONS.md', prefix: '#', pad: 0,
    // A decision is a table row `| 331 | …`. Same shape as check-decision-numbers.mjs:55.
    numbers: (text) => [...text.matchAll(/^\|\s*(\d{2,4})\s*\|/gm)].map((m) => m[1]),
  },
  debt: {
    label: 'debt section', where: 'docs/DEBT-REGISTER.md', prefix: '§', pad: 0,
    // A debt item is a heading `### §92 — …`; a merged pair is `### §16 / §24 — …` and both are taken.
    numbers: (text) => [...text.matchAll(/^###\s*((?:§\d+\s*(?:\/\s*)?)+)/gm)]
      .flatMap((m) => [...m[1].matchAll(/§(\d+)/g)].map((n) => n[1])),
  },
  migration: {
    label: 'migration', where: 'supabase/migrations/', prefix: '', pad: 4,
    // Same shape as check-migration-numbers.mjs:55 — a stray `0290_notes.md` is not a migration.
    numbers: (names) => names.map((n) => n.match(/^(\d{4})_[a-z0-9_]+\.sql$/i)?.[1]).filter(Boolean),
  },
  suite: {
    label: 'SQL suite', where: 'supabase/tests/', prefix: 'p', pad: 0,
    numbers: (names) => names.map((n) => n.match(/^p(\d+)[_a-z]/)?.[1]).filter(Boolean),
  },
};

/** Numbers of one kind in one ref, or in the working tree when ref is null. */
function taken(kind, ref) {
  const spec = KINDS[kind];
  const isDir = spec.where.endsWith('/');
  let source;
  if (isDir) {
    const dir = spec.where.slice(0, -1);
    const listing = ref
      ? git(['ls-tree', '-r', '--name-only', ref, dir]).out
      : (existsSync(path.join(repoRoot, dir)) ? readdirSync(path.join(repoRoot, dir)).join('\n') : '');
    source = listing.split('\n').map((l) => l.split('/').pop() ?? '').filter(Boolean);
  } else {
    source = ref
      ? fileAt(ref, spec.where)
      : (existsSync(path.join(repoRoot, spec.where)) ? readFileSync(path.join(repoRoot, spec.where), 'utf8') : '');
  }
  return new Set(spec.numbers(source).map(Number).filter(Number.isFinite));
}

/**
 * Branches worth reading: local heads and origin/* refs that are ahead of origin/main, split into
 * live and stale. A local branch whose tip is also a remote branch is read once, as the remote.
 */
function branches() {
  const r = git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', 'refs/heads', 'refs/remotes/origin']);
  const live = [];
  const stale = [];
  const seenTips = new Set();
  const rows = r.out.split('\n').filter(Boolean).map((l) => l.split('\t'))
    .map(([refname, tip, unix]) => ({ refname, tip, unix: Number(unix) }))
    .filter((b) => b.refname !== MAIN && !b.refname.endsWith('/HEAD'))
    .sort((a, b) => (a.refname.startsWith('refs/remotes/') ? -1 : 1) - (b.refname.startsWith('refs/remotes/') ? -1 : 1));
  for (const b of rows) {
    if (seenTips.has(b.tip)) continue;
    seenTips.add(b.tip);
    const counts = git(['rev-list', '--left-right', '--count', `${MAIN}...${b.refname}`]);
    if (!counts.ok) continue; // already recorded in problems
    const [behind, ahead] = counts.out.trim().split(/\s+/).map(Number);
    if (!ahead) continue; // everything it has, main has
    const ageDays = (Date.now() / 1000 - b.unix) / 86400;
    const entry = {
      ref: b.refname,
      name: b.refname.startsWith('refs/heads/') ? `${b.refname.slice('refs/heads/'.length)} (local)` : b.refname.slice('refs/remotes/'.length),
      ahead, behind, ageDays,
    };
    (ageDays > STALE_DAYS || behind > STALE_BEHIND ? stale : live).push(entry);
  }
  return { live, stale };
}

const asked = argv.filter((a) => !a.startsWith('--'));
const kinds = asked.length ? asked : Object.keys(KINDS);
for (const k of kinds) {
  if (!Object.hasOwn(KINDS, k)) {
    console.error(`unknown kind "${k}". Try: ${Object.keys(KINDS).join(', ')}`);
    process.exit(2);
  }
}

if (!git(['rev-parse', '--verify', '--quiet', MAIN], { quiet: true }).ok) {
  console.error(`${MAIN} is not readable in ${repoRoot}. This needs a remote named origin with a main branch — fetch it, then ask again.`);
  process.exit(2);
}

if (localOnly) {
  console.log(`--local: not fetching; origin/* refs are ${remoteRefsAge()}.`);
} else {
  const fetched = git(['fetch', '--quiet', '--prune', 'origin'], { quiet: true });
  console.log(fetched.ok ? 'fetched origin.' : `fetch FAILED (${fetched.stderr || 'offline?'}); origin/* refs are ${remoteRefsAge()}.`);
}

const { live, stale } = branches();
let collisions = 0;

const few = (nums, show, limit = 6) => nums.slice(0, limit).map(show).join(', ') + (nums.length > limit ? ` … and ${nums.length - limit} more` : '');

for (const kind of kinds) {
  const spec = KINDS[kind];
  const show = (n) => spec.prefix + String(n).padStart(spec.pad, '0');
  const onMain = taken(kind, MAIN);
  const inTree = taken(kind, null);
  const liveSets = live.map((b) => [b, taken(kind, b.ref)]);
  const staleSets = stale.map((b) => [b, taken(kind, b.ref)]);

  const counted = new Set([...onMain, ...inTree]);
  for (const [, s] of liveSets) for (const n of s) counted.add(n);
  if (includeStale) for (const [, s] of staleSets) for (const n of s) counted.add(n);

  if (!counted.size) {
    console.log(`\n${spec.label}: nothing found — is ${spec.where} where it should be?`);
    continue;
  }
  const max = Math.max(...counted);
  const maxOf = (s) => (s.size ? show(Math.max(...s)) : '—');
  console.log(`\n${spec.label} — next free: ${show(max + 1)}`);
  console.log(`  origin/main ${maxOf(onMain)} · your tree ${maxOf(inTree)} · ${live.length} live branch(es)${stale.length ? ` · ${stale.length} stale not counted` : ''}`);

  // A number a live branch holds that main has not seen is exactly the collision this prevents.
  const holders = (n) => liveSets.filter(([, s]) => s.has(n)).map(([b]) => b.name);
  const onLive = new Set(liveSets.flatMap(([, s]) => [...s]));
  const claimed = [...onLive].filter((n) => !onMain.has(n) && !inTree.has(n)).sort((a, b) => a - b);
  if (claimed.length) {
    console.log(`  CLAIMED ON A BRANCH BUT NOT IN YOUR TREE: ${few(claimed, (n) => `${show(n)} on ${holders(n)[0]}${holders(n).length > 1 ? ` +${holders(n).length - 1}` : ''}`)}`);
    console.log('  Those are the ones git will merge without a conflict. Do not reuse them.');
  }

  // The collision that has ALREADY happened: you wrote it, so did a live branch, and main has neither.
  const collided = [...inTree].filter((n) => !onMain.has(n) && onLive.has(n)).sort((a, b) => a - b);
  if (collided.length) {
    collisions += collided.length;
    console.log(`  COLLISION: ${few(collided, (n) => `${show(n)} is in your tree AND on ${holders(n).join(', ')}`)}`);
    console.log('  git will merge both without a conflict. One side must renumber before merge.');
  }

  for (const [b, s] of staleSets) {
    const held = [...s].filter((n) => !onMain.has(n)).sort((a, b2) => a - b2);
    if (!held.length) continue;
    console.log(`  STALE (not counted): ${b.name} holds ${few(held, show, 4)} — ${b.behind} behind main, ${Math.round(b.ageDays)} days old${includeStale ? ' (counted: --include-stale)' : '; --include-stale counts it'}`);
  }
}

if (problems.length) {
  console.log('\nWARNINGS — these git reads failed, so their numbers are missing from the answer:');
  for (const p of [...new Set(problems)]) console.log(`  ${p}`);
}

process.exit(collisions ? 1 : 0);

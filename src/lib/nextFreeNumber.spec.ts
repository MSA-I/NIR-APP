import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

/**
 * scripts/next-free-number.mjs against a fixture repository with a bare `origin`.
 *
 * The shape reproduces the failures measured on 02.09.2026: a checkout BEHIND origin/main, a
 * sibling worktree's unpushed branch, a colleague's pushed branch, and an abandoned draft that is
 * "ahead of main" forever. Every expectation names a literal number, so a wrong reader fails here.
 */
const tool = join(process.cwd(), 'scripts', 'next-free-number.mjs');
const identity = {
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity, ...env },
  }).trim();
}
function commitAll(cwd: string, message: string, date?: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message], date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {});
}
function rows(nums: number[]): string {
  return `| # | ruling |\n|---|---|\n${nums.map((n) => `| ${n} | ruling ${n} |`).join('\n')}\n`;
}
function ask(repo: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [tool, `--repo=${repo}`, ...args], { encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}
/** The tool prints rulings as `#N`; assembled here so check:decision-numbers does not read fixture numbers as citations. */
const ruling = (n: number) => `#${n}`;
const has = (text: string, needle: string) => assert.ok(text.includes(needle), `expected «${needle}» in:\n${text}`);
const lacks = (text: string, needle: string) => assert.ok(!text.includes(needle), `did not expect «${needle}» in:\n${text}`);

test('next-free-number reads main, local and live branches, lists stale ones, and names collisions', () => {
  const root = mkdtempSync(join(tmpdir(), 'next-free-'));
  try {
    const bare = join(root, 'origin.git');
    const work = join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...identity } });
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    git(work, ['remote', 'add', 'origin', bare]);

    // origin/main: rulings 330 and 331, debt §16 / §24 (a merged pair) and §23, migration 0283 plus a
    // stray non-SQL file numbered 0290, suite p103.
    mkdirSync(join(work, 'docs'));
    mkdirSync(join(work, 'supabase', 'migrations'), { recursive: true });
    mkdirSync(join(work, 'supabase', 'tests'), { recursive: true });
    writeFileSync(join(work, 'docs', 'OPEN-DECISIONS.md'), rows([330, 331]));
    writeFileSync(join(work, 'docs', 'DEBT-REGISTER.md'), '### §16 / §24 — merged pair\n\ntext\n\n### §23 — single\n\ntext (see §41 in prose, which is not a heading)\n');
    writeFileSync(join(work, 'supabase', 'migrations', '0283_profile_theme.sql'), '-- sql\n');
    writeFileSync(join(work, 'supabase', 'migrations', '0290_notes.md'), 'not a migration\n');
    writeFileSync(join(work, 'supabase', 'tests', 'p103_something.sql'), '-- sql\n');
    commitAll(work, 'main: 331');
    git(work, ['push', '-q', '-u', 'origin', 'main']);

    // An abandoned draft: ahead of main, 30 days old, holding ruling 340.
    git(work, ['checkout', '-q', '-b', 'old-draft']);
    writeFileSync(join(work, 'docs', 'OPEN-DECISIONS.md'), rows([330, 331, 340]));
    const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    commitAll(work, 'old draft: 340', monthAgo);
    git(work, ['push', '-q', 'origin', 'old-draft']);
    git(work, ['checkout', '-q', 'main']);

    // A sibling worktree's branch, never pushed: ruling 333.
    git(work, ['checkout', '-q', '-b', 'local-work']);
    writeFileSync(join(work, 'docs', 'OPEN-DECISIONS.md'), rows([330, 331, 333]));
    commitAll(work, 'local: 333');
    git(work, ['checkout', '-q', 'main']);

    // A colleague's pushed branch, not present locally: ruling 334 and migration 0284.
    git(work, ['checkout', '-q', '-b', 'remote-work']);
    writeFileSync(join(work, 'docs', 'OPEN-DECISIONS.md'), rows([330, 331, 334]));
    // Assembled, not literal: check:renumber-closure reads every `NNNN_name.sql` token in the tree as a
    // citation of a real migration, and this one is a fixture that must not exist.
    writeFileSync(join(work, 'supabase', 'migrations', ['0284', 'measured.sql'].join('_')), '-- sql\n');
    commitAll(work, 'remote: 334');
    git(work, ['push', '-q', 'origin', 'remote-work']);
    git(work, ['checkout', '-q', 'main']);
    git(work, ['branch', '-q', '-D', 'remote-work']);

    // main moves on to ruling 332 — and this checkout stays one commit behind it.
    writeFileSync(join(work, 'docs', 'OPEN-DECISIONS.md'), rows([330, 331, 332]));
    commitAll(work, 'main: 332');
    git(work, ['push', '-q', 'origin', 'main']);
    git(work, ['reset', '-q', '--hard', 'HEAD~1']);
    git(work, ['fetch', '-q', 'origin']);

    // Default mode fetches; --local says how old the refs are.
    const fetched = ask(work, 'decision');
    assert.equal(fetched.status, 0, fetched.out);
    has(fetched.out, 'fetched origin.');

    const local = ask(work, '--local', 'decision');
    assert.equal(local.status, 0, local.out);
    has(local.out, '--local: not fetching; origin/* refs are');
    // main (ruling 332) beats the tree (ruling 331); local-work (ruling 333) and origin/remote-work (ruling 334) are live;
    // old-draft (ruling 340) is stale and only listed.
    has(local.out, `owner ruling — next free: ${ruling(335)}`);
    has(local.out, `origin/main ${ruling(332)} · your tree ${ruling(331)} · 2 live branch(es) · 1 stale not counted`);
    has(local.out, `CLAIMED ON A BRANCH BUT NOT IN YOUR TREE: ${ruling(333)} on local-work (local), ${ruling(334)} on origin/remote-work`);
    has(local.out, `STALE (not counted): origin/old-draft holds ${ruling(340)} — 1 behind main, 30 days old`);
    lacks(local.out, 'COLLISION');
    lacks(local.out, 'WARNINGS');

    const withStale = ask(work, '--local', '--include-stale', 'decision');
    has(withStale.out, `owner ruling — next free: ${ruling(341)}`);

    // Debt: both halves of the merged heading count; a § in prose does not. Migration: a live branch's
    // 0284 counts, the stray 0290_notes.md does not. Suite: p103 -> p104.
    const rest = ask(work, '--local', 'debt', 'migration', 'suite');
    assert.equal(rest.status, 0, rest.out);
    has(rest.out, 'debt section — next free: §25');
    has(rest.out, 'migration — next free: 0285');
    has(rest.out, 'CLAIMED ON A BRANCH BUT NOT IN YOUR TREE: 0284 on origin/remote-work');
    has(rest.out, 'SQL suite — next free: p104');

    // The collision that already happened: the tree writes ruling 333 while local-work holds it too.
    appendFileSync(join(work, 'docs', 'OPEN-DECISIONS.md'), '| 333 | mine too |\n');
    const collided = ask(work, '--local', 'decision');
    assert.equal(collided.status, 1, collided.out);
    has(collided.out, `COLLISION: ${ruling(333)} is in your tree AND on local-work (local)`);
    has(collided.out, `owner ruling — next free: ${ruling(335)}`);

    // Usage errors are loud, and an inherited object key is not a kind.
    const unknown = ask(work, '--local', 'toString');
    assert.equal(unknown.status, 2);
    has(unknown.out, 'unknown kind "toString"');

    const lonely = join(root, 'lonely');
    mkdirSync(lonely);
    git(lonely, ['init', '-q', '-b', 'main']);
    const noMain = ask(lonely, '--local', 'decision');
    assert.equal(noMain.status, 2);
    has(noMain.out, 'refs/remotes/origin/main is not readable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

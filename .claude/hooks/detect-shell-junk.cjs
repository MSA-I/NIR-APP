#!/usr/bin/env node
/**
 * PostToolUse — remove zero-byte junk files created by broken shell quoting.
 *
 * This repo keeps growing files named `$p`, `{`, `0)`, `({uid`, `dict[str`, `100`, `0`,
 * `deliver(row`, `set[str]`. They are not typos: they are what happens when source text reaches a
 * shell. In `(c) => x` the `>` is a REDIRECT and the next word becomes a filename; so is the `>` in
 * `if total > 100` and the one in `-> dict[str, Any]`. The shell dutifully creates an empty file
 * named after a fragment of the code.
 *
 * WHY THIS NOW DELETES INSTEAD OF NAGGING
 *
 * The first version reported and told a human to clean up. Over one session on 17.08.2026 that
 * meant deleting nine files by hand, and the same nag had already been recorded across earlier
 * sessions. A warning that fires repeatedly and is always resolved the same way is not a warning,
 * it is an unautomated chore.
 *
 * WHY IT ALSO RUNS AFTER Write/Edit
 *
 * The first version only ran after Bash, on the assumption that our own inline commands were the
 * source. That assumption was tested on 17.08.2026 and is wrong: a single Write whose CONTENT
 * contained `if v > zzzprobe_beta` produced `zzzprobe_beta'` in the repo root, with no Bash call
 * anywhere near it. Something in the tool chain passes edited content through a shell.
 *
 * Ruled out as the injector, by reading them: this repo's own guard-migrations.cjs (execFileSync
 * with an argv array), the global hook-handler.cjs (pure Node, never shells out), the
 * security-guidance shim (`"$@"`, and not installed anyway), and claude-mem's chain, which passes
 * the payload on stdin at every step. The exact upstream component is still unnamed. That is
 * precisely why the cleanup lives HERE: it does not depend on which tool is at fault, and it keeps
 * working when that tool updates.
 *
 * WHAT IT WILL AND WILL NOT DELETE
 *
 * Deleted only when ALL of these hold: untracked, in the repo root, zero bytes, and a name no one
 * would type. Anything non-empty is reported and left alone — an empty file cannot be lost work,
 * a non-empty one might be.
 */
const { execFileSync } = require('node:child_process');
const { statSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * A filename no one would type: shell metacharacters, a bracket in any position, an unbalanced
 * quote, or a bare number. `[` and `]` are matched anywhere rather than only at the edges, because
 * `-> dict[str, Any]` truncates to `dict[str`, which has the bracket in the middle and slipped
 * through the first version of this check.
 */
const JUNK_NAME = /[`$={}()<>|*?"'[\]]|^\d+\)?$/;

/** Files whose names look odd but are real, checked-in tooling. */
const ALLOW = new Set(['!', '#']);

/** A runaway loop should not be able to empty a directory. */
const MAX_REMOVALS = 25;

let stdout = '';
try {
  // -uall would walk every ignored directory; the default (normal) mode stops at the root entries
  // that matter here. `--` guards against a repo path that starts with a dash.
  stdout = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
} catch {
  process.exit(0); // Not a repo, or git is busy. Never fail a tool call over housekeeping.
}

const removed = [];
const kept = [];
for (const line of stdout.split('\n')) {
  if (!line.startsWith('?? ')) continue;

  // Porcelain quotes names containing unusual bytes; the quotes are not part of the name.
  const raw = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
  if (raw.includes('/')) continue; // Root level only — that is where a redirect lands.
  if (ALLOW.has(raw)) continue;
  if (!JUNK_NAME.test(raw)) continue;

  const full = join(cwd, raw);
  let stat = null;
  try { stat = statSync(full); } catch { continue; } // vanished between the two calls
  if (!stat.isFile()) continue;

  if (stat.size !== 0) {
    kept.push(`${raw}   (${stat.size} bytes — not empty, left alone)`);
    continue;
  }
  if (removed.length >= MAX_REMOVALS) {
    kept.push(`${raw}   (0 bytes — over the ${MAX_REMOVALS}-file removal cap)`);
    continue;
  }
  try {
    unlinkSync(full);
    removed.push(raw);
  } catch (error) {
    kept.push(`${raw}   (0 bytes — could not remove: ${error.code || 'unknown'})`);
  }
}

if (removed.length === 0 && kept.length === 0) process.exit(0);

const lines = [];
if (removed.length > 0) {
  lines.push(
    `Removed ${removed.length} zero-byte shell-redirect file(s) from the repo root:`,
    ...removed.map((f) => `    ${f}`),
    '',
    'These are created when source text reaches a shell: in `-> dict[str, Any]` or `if x > 100`,',
    'the `>` is a redirect and the next word becomes a filename. Nothing was lost — they were empty.',
  );
}
if (kept.length > 0) {
  if (lines.length > 0) lines.push('');
  lines.push(
    `Left alone, needs a human ${kept.length === 1 ? 'decision' : 'decisions'}:`,
    ...kept.map((f) => `    ${f}`),
  );
}

process.stderr.write(lines.join('\n') + '\n');
// Exit 0 on a clean sweep: the problem is solved, and a non-zero code here would report a failure
// where there is none. Only an undecidable leftover is worth interrupting for.
process.exit(kept.length > 0 ? 2 : 0);

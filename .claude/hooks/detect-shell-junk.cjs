#!/usr/bin/env node
/**
 * PostToolUse(Bash) — report zero-byte junk files created by broken shell quoting.
 *
 * This repo keeps growing files named `$p`, `{`, `0)`, `({uid`, `[A-Za-z][A-Za-z`,
 * `` `${c.id} ``, `!checkScripts.includes(s))`. They are not typos: they are what happens when
 * source text containing `=>` reaches a shell. `(c) => x` splits into the word `(c)`, an `=`, and
 * a `>` REDIRECT whose target is the next word — so the shell dutifully creates an empty file
 * named after a fragment of the code. Three appeared during the session that added this hook.
 *
 * They are invisible in an editor, they survive into commits, and the global instructions already
 * carry a rule against them that nothing enforced. This enforces it: after every Bash call, list
 * untracked files whose name could not have been chosen on purpose, and say so loudly enough that
 * they get deleted in the same turn rather than committed three waves later.
 *
 * Scope is the repo root only. That is where redirect junk lands (the shell's cwd), and it keeps
 * the check to a single `git status` on a path that stays small.
 */
const { execFileSync } = require('node:child_process');
const { statSync } = require('node:fs');
const { join } = require('node:path');

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * A filename no one would type: shell metacharacters, an unbalanced bracket or quote, or a bare
 * number. Deliberately narrow — a false positive here nags on every single Bash call.
 */
const JUNK_NAME = /[`$={}()<>|*?"']|^\d+\)?$|^\[|\]$/;

/** Files whose names look odd but are real, checked-in tooling. */
const ALLOW = new Set(['!', '#']);

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
  process.exit(0); // Not a repo, or git is busy. Never fail a tool call over a nag.
}

const junk = [];
for (const line of stdout.split('\n')) {
  if (!line.startsWith('?? ')) continue;

  // Porcelain quotes names containing unusual bytes; the quotes are not part of the name.
  const raw = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
  if (raw.includes('/')) continue; // Root level only.
  if (ALLOW.has(raw)) continue;
  if (!JUNK_NAME.test(raw)) continue;

  let size = null;
  try { size = statSync(join(cwd, raw)).size; } catch { /* vanished between calls */ }
  junk.push(size === null ? raw : `${raw}   (${size} bytes)`);
}

if (junk.length === 0) process.exit(0);

process.stderr.write(
  `Shell junk in the repo root — ${junk.length} untracked file(s) with names no one would type:\n\n`
  + junk.map((f) => `    ${f}`).join('\n')
  + `\n\nThese come from source text reaching a shell: in \`(c) => x\`, the \`>\` is a redirect and\n`
  + `the next word becomes a filename. Delete them now — they are invisible in an editor and get\n`
  + `committed otherwise. On Windows use quoting that survives the name:\n`
  + `    rm -f -- '<name>'        (Git Bash)\n`
  + `    Remove-Item -LiteralPath '<name>'   (PowerShell)\n`
  + `Then fix the cause: put long or code-bearing commands in a script file instead of inline.\n`,
);
process.exit(2);

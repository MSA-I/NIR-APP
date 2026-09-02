/**
 * check:env-files — a secret env file must not be trackable, whatever it is called.
 *
 * WHY THIS EXISTS. On 01.09.2026 an agent snapshotted `supabase/functions/.env` as
 * `supabase/functions/.env.before-assistant-capture` before editing it, and `git add -A` staged the
 * copy: `.gitignore` matched the exact names `.env` and `supabase/functions/.env` and nothing else.
 * The commit was undone 35 seconds later and never pushed, but the blob with a live OpenAI key,
 * the OCR worker token and the cron secret still sits in `.git/objects`, and a repository copy
 * carried it to an external scanner. The rule that lets that happen is a rule that matches names
 * instead of the family, and this guard measures the family.
 *
 * THREE ASSERTIONS, all against git itself rather than against a regex of our own:
 *   1. no tracked path has a basename in the `.env*` family, except the two committed templates;
 *   2. representative sibling names — a backup, a `.production`, a snapshot under
 *      `supabase/functions/` — are IGNORED by the current `.gitignore`;
 *   3. the two templates are NOT ignored, so the negations that keep them visible are still there.
 * `--no-index` makes check-ignore evaluate the patterns alone, so a tracked file cannot mask a gap.
 *
 * Run: node scripts/check-env-files.mjs
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const TEMPLATES = new Set(['.env.example', '.env.qa.example']);
const MUST_BE_IGNORED = [
  '.env.production',
  '.env.backup',
  '.env.before-anything',
  'supabase/functions/.env.backup',
  'supabase/functions/.env.before-assistant-capture',
  'supabase/functions/.env.prod',
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
/** true when the current .gitignore patterns ignore `relativePath`, tracked or not. */
function ignored(relativePath) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', relativePath], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

const failures = [];

const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
for (const file of tracked) {
  const base = path.posix.basename(file);
  if (/^\.env(\..*)?$/.test(base) && !TEMPLATES.has(base)) {
    failures.push(`tracked: ${file} — an env file is in git; only ${[...TEMPLATES].join(' and ')} may be`);
  }
}
for (const probe of MUST_BE_IGNORED) {
  if (!ignored(probe)) failures.push(`not ignored: ${probe} — .gitignore must cover the whole .env* family, not exact names`);
}
for (const template of TEMPLATES) {
  if (ignored(template)) failures.push(`ignored: ${template} — the committed template must stay visible (missing "!${template}")`);
}

if (failures.length > 0) {
  console.error('env-file guard FAILED:');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nSecret env files belong on the machine and in Edge Function secrets, never in git,');
  console.error('under any name. Fix .gitignore with `.env*` / `supabase/functions/.env*` plus `!<template>`.');
  process.exit(1);
}
console.log(`env-file guard: no env file is tracked; ${MUST_BE_IGNORED.length} sibling names are ignored; ${TEMPLATES.size} templates stay visible.`);

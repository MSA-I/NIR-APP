#!/usr/bin/env node
/**
 * PreToolUse(Write|Edit) — refuse to edit a migration that has already run.
 *
 * supabase/migrations/ holds 88 numbered files, and they are applied to the REMOTE project via
 * scripts/db-query.ps1 (Management API). Once a file has run there, editing it changes only the
 * local text: the remote schema keeps whatever the old version did. Nothing in the gate catches
 * that — `npm run quality` rebuilds a fresh local database from the edited files, so it passes
 * while local and remote quietly diverge. The next person to reset a database gets a schema the
 * production project has never had.
 *
 * "Already ran" is read as "committed to git". A migration still untracked is being authored and
 * is free to change; a tracked one has been through a commit, which in this repo means it went to
 * the remote. The heuristic is deliberately blunt — the fix for a shipped migration is a NEW
 * numbered file, which is what the block pushes you toward.
 *
 * ponytail: git-tracked is a proxy for applied. If a migration is ever committed before it runs,
 * override with SUPPLYFLOW_ALLOW_MIGRATION_EDIT=1 and say why in the commit message.
 */
const { execFileSync } = require('node:child_process');

let payload = '';
process.stdin.on('data', (chunk) => { payload += chunk; });
process.stdin.on('end', () => {
  if (process.env.SUPPLYFLOW_ALLOW_MIGRATION_EDIT === '1') process.exit(0);

  let filePath;
  try {
    filePath = JSON.parse(payload)?.tool_input?.file_path;
  } catch {
    process.exit(0); // Unparseable payload is the harness's problem, not a reason to block work.
  }
  if (typeof filePath !== 'string') process.exit(0);

  const normalised = filePath.replace(/\\/g, '/');
  // (^|\/) and not a bare \/: a relative path like `supabase/migrations/x.sql` has no leading
  // slash and would silently bypass the guard.
  if (!/(^|\/)supabase\/migrations\/[^/]+\.sql$/.test(normalised)) process.exit(0);

  const name = normalised.slice(normalised.lastIndexOf('/') + 1);

  let tracked = false;
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', `supabase/migrations/${name}`], {
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      stdio: 'ignore',
    });
    tracked = true;
  } catch {
    tracked = false; // Untracked: a migration being written right now.
  }

  if (!tracked) process.exit(0);

  process.stderr.write(
    `Blocked: ${name} is a committed migration, which in this repo means it has already run `
    + `against the remote project.\n\n`
    + `Editing it changes only the local text. The remote schema keeps what the original version `
    + `did, and the gate will not notice: \`npm run quality\` rebuilds a fresh database from the `
    + `edited files, so it passes while local and remote diverge.\n\n`
    + `Write a NEW numbered migration that alters what this one created. That is the only change `
    + `both databases will ever see.\n\n`
    + `If this migration genuinely has not run yet, re-run with SUPPLYFLOW_ALLOW_MIGRATION_EDIT=1 `
    + `and record why in the commit message.\n`,
  );
  process.exit(2);
});

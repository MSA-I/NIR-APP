#!/usr/bin/env node
/**
 * check:workflow-triggers — a pull request is checked because it is a pull request.
 *
 * THE FAILURE THIS CLOSES, AND WHY IT IS THE WORST KIND. Both workflows used to be declared as
 * `pull_request: branches: [main]`. That reads like "run on pull requests", and it is not: it
 * runs on pull requests WHOSE BASE IS `main`. A PR stacked on another branch — the ordinary shape
 * when one package builds on another — matched no trigger at all, so GitHub started no run, listed
 * no checks, and showed the PR with nothing red on it.
 *
 * Nothing red is not the same as nothing wrong, but on that screen they are the same picture. The
 * branch protection everyone trusts is satisfied vacuously: there are no required checks failing
 * because there are no checks. A reviewer looking for a red mark finds none and merges.
 *
 * `push: branches: [main]` is a DIFFERENT statement and stays. That one really does mean "when
 * main moves", and narrowing a push trigger to the trunk is correct — it stops every branch push
 * from spending a runner. Only the pull_request side is a lie about coverage, so only that side is
 * checked here.
 *
 * WHY A GUARD RATHER THAN JUST THE FIX. The filter is one short line and it looks like tidy
 * scoping — the kind of line that gets added back by someone reducing CI minutes, with a
 * reasonable-sounding commit message, and nothing goes red to argue with them. The cost of being
 * wrong is invisible, so the only thing that can hold the line is something that fails.
 *
 * `INJECT=branches` re-adds the filter to a copy in memory, which is how check:gate-controls
 * proves this guard actually bites.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const inject = process.env.WORKFLOW_TRIGGERS_INJECT;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
if (files.length === 0) {
  fail('check:workflow-triggers FAILED — parsed zero workflow files. The layout changed and this\n'
    + '  guard is measuring nothing.');
}

/**
 * Read the `on:` block only. A `branches:` key deeper in the file — inside a job, a step, or a
 * path filter — is unrelated, and failing on it would train people to ignore this guard.
 */
function triggerBlock(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (start === -1) return null;
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // The block ends at the next top-level key. Blank and comment lines belong to it.
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

const offenders = [];
let checked = 0;

for (const file of files) {
  let text = readFileSync(path.join(workflowsDir, file), 'utf8');
  if (inject === 'branches' && file === 'build.yml') {
    text = text.replace(/^( *)pull_request:\s*$/m, '$1pull_request:\n$1  branches: [main]');
  }

  const block = triggerBlock(text);
  if (block === null) {
    fail(`check:workflow-triggers FAILED — ${file} has no top-level \`on:\` block, so this guard\n`
      + '  cannot tell what it triggers on. Either the file is malformed or the shape changed.');
  }

  const prIndex = block.findIndex((l) => /^\s{2}pull_request(_target)?:\s*$/.test(l));
  if (prIndex === -1) continue;   // no pull_request trigger at all — nothing to claim about it
  checked += 1;

  // Everything indented deeper than the trigger key, until the next key at the same depth.
  for (let i = prIndex + 1; i < block.length; i += 1) {
    const line = block[i];
    if (/^\s{2}\S/.test(line)) break;
    if (/^\s{4}branches(-ignore)?:/.test(line)) {
      offenders.push(`    ${file}: ${line.trim()}`);
      break;
    }
  }
}

if (checked === 0) {
  fail('check:workflow-triggers FAILED — no workflow declares a `pull_request:` trigger. Either\n'
    + '  pull requests stopped being checked entirely, or this guard can no longer find the\n'
    + '  trigger it exists to read.');
}

if (offenders.length) {
  fail('check:workflow-triggers FAILED — a pull_request trigger is filtered by base branch:\n\n'
    + `${offenders.join('\n')}\n\n`
    + '  A PR whose base is not listed matches no trigger, so GitHub starts no run and reports\n'
    + '  "no checks" — which on the PR page is indistinguishable from success, and satisfies\n'
    + '  branch protection vacuously. Stacked PRs are exactly the case this hides.\n\n'
    + '  Remove the filter. To spend fewer runner minutes, narrow the JOBS by changed path — the\n'
    + '  workflows already classify paths and skip the jobs that cannot be affected.');
}

console.log(`check:workflow-triggers passed: ${checked} pull_request trigger(s) across `
  + `${files.length} workflow file(s), none filtered by base branch.`);

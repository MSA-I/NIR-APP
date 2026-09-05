// PR 38 — records the guards that can run without the shared Supabase stack, on the fixed tree.
// Written as a script rather than a shell one-liner: the repository lives under a Hebrew path with
// a space in it, and a long quoted pipeline there is the shape that produces garbage-named files.
import { execSync } from 'node:child_process';

const GUARDS = [
  'check:money', 'check:currency', 'check:i18n', 'check:plurals', 'check:orphan-keys',
  'check:key-manifest', 'check:supplier-columns', 'check:typography', 'check:jsx-space',
  'check:tokens', 'check:baseline-drift', 'check:decision-numbers', 'check:debt-numbers',
  'check:plan-labels',
];

const run = (command) => {
  try {
    return { ok: true, out: execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

console.log('PR38 — guards run on the fixed tree, 04.09.2026, worktree-agent-a183f8959614045c8.');
console.log('The heavy gate, every SQL suite and `npm run verify` in full are NOT run here: another');
console.log('agent holds the local Supabase stack for this wave.\n');

let failed = 0;
const typecheck = run('npx tsc --noEmit');
console.log(`--- npx tsc --noEmit\n${typecheck.ok ? 'clean' : typecheck.out}`);
if (!typecheck.ok) failed += 1;

for (const guard of GUARDS) {
  const result = run(`npm run --silent ${guard}`);
  const tail = result.out.trim().split('\n').slice(-4).join('\n');
  console.log(`\n--- npm run ${guard}\n${tail}`);
  if (!result.ok) failed += 1;
}

console.log(`\n${failed === 0 ? 'ALL GREEN' : `${failed} FAILED`}`);
process.exitCode = failed === 0 ? 0 : 1;

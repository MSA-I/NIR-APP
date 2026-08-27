import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..', '..', '..');
const git = (...args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', windowsHide: true }).trim();
const gitRaw = (...args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', windowsHide: true });

for (const source of ['docs/OPEN-DECISIONS.md', 'docs/DEBT-REGISTER.md']) {
  assert.equal(git('diff', '--', source), '', `${source} was changed`);
}

const allowed = [
  'PLAN.md',
  'START-OWNER-DECISIONS.cmd',
  'package.json',
  'scripts/owner-decisions-server.mjs',
  'tools/owner-decisions/',
];
const changed = gitRaw('status', '--short', '--untracked-files=all').split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replaceAll('\\', '/'));
for (const file of changed) {
  assert.ok(allowed.some((prefix) => prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix), `out-of-scope change: ${file}`);
}
assert.match(git('branch', '--show-current'), /^codex\/owner-decisions-console$/);
console.log('owner-decisions scope verified');

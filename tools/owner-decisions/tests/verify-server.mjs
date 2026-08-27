import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..', '..', '..');
const files = [
  'tools/owner-decisions/tests/state.test.mjs',
  'tools/owner-decisions/tests/server.test.mjs',
  'tools/owner-decisions/tests/paths.test.mjs',
];
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: rootDir, encoding: 'utf8', windowsHide: true });
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /pass 10/u);
console.log('owner-decisions server verified');

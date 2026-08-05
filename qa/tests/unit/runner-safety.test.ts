import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseWindowsMutexStatus, QA_WINDOWS_MUTEX_NAME } from '../../runner/lock.ts';
import { canonicalQaStatePath } from '../../runner/setup.ts';

test('QA state has one canonical repository path', () => {
  const repoRoot = path.join(process.cwd(), 'nested', '..');
  assert.equal(
    canonicalQaStatePath(repoRoot),
    path.join(path.resolve(repoRoot), '.qa-state', 'current.json'),
  );
});

test('Windows mutex handshake accepts exact lines and prioritizes BLOCKED', () => {
  assert.equal(parseWindowsMutexStatus('BLOCKED\r\n'), 'BLOCKED');
  assert.equal(parseWindowsMutexStatus('LOCKED\r\n'), 'LOCKED');
  assert.equal(parseWindowsMutexStatus('BLOCKED\nLOCKED\n'), 'BLOCKED');
  assert.equal(parseWindowsMutexStatus('prefix LOCKED suffix\n'), undefined);
});

test('destructive PowerShell gates use the same abandoned-safe mutex as QA', async () => {
  const scripts = await Promise.all([
    readFile(path.join(process.cwd(), 'scripts', 'check-quality-gates.ps1'), 'utf8'),
    readFile(path.join(process.cwd(), 'scripts', 'check-p0-security.ps1'), 'utf8'),
  ]);
  for (const source of scripts) {
    assert.match(source, new RegExp(QA_WINDOWS_MUTEX_NAME.replaceAll('\\', '\\\\')));
    assert.match(source, /\.WaitOne\(0\)/);
    assert.match(source, /AbandonedMutexException/);
  }
  assert.match(scripts[0]!, /-QaMutexAlreadyHeld/);
});

test('deterministic children have bounded Windows process-tree cleanup', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'qa', 'runner', 'deterministic-runner.ts'),
    'utf8',
  );
  assert.match(source, /taskkill\.exe/);
  assert.match(source, /\['\/PID', String\(child\.pid\), '\/T', '\/F'\]/);
  assert.match(source, /holdMutexUntilProcessTreeExit/);
  assert.match(source, /the shared QA mutex remains held/);
  assert.doesNotMatch(source, /terminated: false/);
  assert.match(source, /timeoutMs: 900_000/);
});

test('cross-tenant fixture bounds every request and rechecks lock ownership', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'qa', 'fixtures', 'cross-tenant-invoice-context.ts'),
    'utf8',
  );
  assert.equal(source.match(/\.abortSignal\(fixtureSignal\(\)\)/g)?.length, 8);
  assert.equal(source.match(/await assertQaLockOwned\(options\.lock\)/g)?.length, 8);
});

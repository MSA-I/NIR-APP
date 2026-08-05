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

test('deterministic Windows children use a suspended kill-on-close Job Object', async () => {
  const [runner, launcher, helper, lock] = await Promise.all([
    readFile(path.join(process.cwd(), 'qa', 'runner', 'deterministic-runner.ts'), 'utf8'),
    readFile(path.join(process.cwd(), 'qa', 'runner', 'windows-job.ts'), 'utf8'),
    readFile(path.join(process.cwd(), 'qa', 'runner', 'windows-job.ps1'), 'utf8'),
    readFile(path.join(process.cwd(), 'qa', 'runner', 'lock.ts'), 'utf8'),
  ]);
  assert.match(runner, /runWindowsJobCommand/);
  assert.match(runner, /timeoutMs: 900_000/);
  assert.doesNotMatch(runner, /taskkill\.exe|captureWindowsProcessTree|WindowsProcessIdentity/);
  assert.match(helper, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(helper, /CREATE_SUSPENDED/);
  assert.ok(helper.indexOf('if (!CreateProcess(') < helper.indexOf('if (!AssignProcessToJobObject(job, process.hProcess))'));
  assert.ok(helper.indexOf('if (!AssignProcessToJobObject(job, process.hProcess))') < helper.indexOf('if (ResumeThread(process.hThread)'));
  assert.match(helper, /TerminateJobObject/);
  assert.match(helper, /QueryInformationJobObject/);
  assert.match(helper, /OpenProcess\(SYNCHRONIZE, false, \(uint\)parentPid\)/);
  assert.match(helper, /startup\.hStdOutput = standardOutput/);
  assert.match(helper, /startup\.hStdError = standardError/);
  assert.match(helper, /CREATE_UNICODE_ENVIRONMENT/);
  assert.match(helper, /environmentBlock,\s*cwd,\s*ref startup/);
  assert.match(launcher, /helper\.stdin\.end\(JSON\.stringify\(specification\), 'utf8'\)/);
  assert.doesNotMatch(launcher, /\['[^\]]*executable/);
  assert.doesNotMatch(lock, /WindowsProcessIdentity|captureWindowsProcessTree|CreationDate/);
});

test('cross-tenant fixture bounds every request and rechecks lock ownership', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'qa', 'fixtures', 'cross-tenant-invoice-context.ts'),
    'utf8',
  );
  assert.equal(source.match(/\.abortSignal\(fixtureSignal\(\)\)/g)?.length, 8);
  assert.equal(source.match(/await assertQaLockOwned\(options\.lock\)/g)?.length, 8);
});

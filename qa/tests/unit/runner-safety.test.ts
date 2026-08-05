import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { QA_WINDOWS_MUTEX_NAME } from '../../runner/lock.ts';

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

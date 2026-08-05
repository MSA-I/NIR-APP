import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runWindowsJobCommand } from '../../runner/windows-job.ts';

const windowsOnly = { skip: process.platform !== 'win32' } as const;

test('Windows Job preserves cwd, environment and primary exit code', windowsOnly, async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'supplyflow-job-semantics-'));
  const observedPath = path.join(temporaryRoot, 'observed.json');
  try {
    const script = [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.QA_JOB_OBSERVED, JSON.stringify({ cwd: process.cwd(), value: process.env.QA_JOB_VALUE }));",
      'process.exit(7);',
    ].join(' ');
    const result = await runWindowsJobCommand(process.execPath, ['-e', script], {
      cwd: temporaryRoot,
      env: { ...process.env, QA_JOB_OBSERVED: observedPath, QA_JOB_VALUE: 'עברית with spaces' },
      timeoutMs: 5_000,
      descendantGraceMs: 1_000,
      cleanupTimeoutMs: 2_000,
    });
    assert.deepEqual(result, { status: 'EXITED', exitCode: 7 });
    assert.deepEqual(JSON.parse(await readFile(observedPath, 'utf8')), {
      cwd: temporaryRoot,
      value: 'עברית with spaces',
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('Windows Job timeout prevents a detached descendant from escaping', windowsOnly, async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'supplyflow-job-timeout-'));
  const markerPath = path.join(temporaryRoot, 'escaped.txt');
  const spawnedPath = path.join(temporaryRoot, 'spawned.txt');
  try {
    const descendant = [
      "const fs = require('node:fs');",
      "setTimeout(() => fs.writeFileSync(process.env.QA_JOB_MARKER, 'escaped'), 2_000);",
      'setInterval(() => undefined, 1_000);',
    ].join(' ');
    const root = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "spawn(process.execPath, ['-e', process.env.QA_JOB_DESCENDANT], { detached: true, stdio: 'ignore', env: process.env }).unref();",
      "fs.writeFileSync(process.env.QA_JOB_SPAWNED, 'spawned');",
      'setInterval(() => undefined, 1_000);',
    ].join(' ');
    const result = await runWindowsJobCommand(process.execPath, ['-e', root], {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        QA_JOB_DESCENDANT: descendant,
        QA_JOB_MARKER: markerPath,
        QA_JOB_SPAWNED: spawnedPath,
      },
      timeoutMs: 1_000,
      descendantGraceMs: 250,
      cleanupTimeoutMs: 2_000,
    });
    assert.deepEqual(result, { status: 'TIMED_OUT', exitCode: null });
    await access(spawnedPath);
    await new Promise<void>((resolve) => setTimeout(resolve, 2_250));
    await assert.rejects(access(markerPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('Windows Job blocks and terminates descendants that outlive a successful primary', windowsOnly, async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'supplyflow-job-descendant-'));
  const markerPath = path.join(temporaryRoot, 'escaped.txt');
  const spawnedPath = path.join(temporaryRoot, 'spawned.txt');
  try {
    const descendant = [
      "const fs = require('node:fs');",
      "setTimeout(() => fs.writeFileSync(process.env.QA_JOB_MARKER, 'escaped'), 1_000);",
      'setInterval(() => undefined, 1_000);',
    ].join(' ');
    const root = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "spawn(process.execPath, ['-e', process.env.QA_JOB_DESCENDANT], { detached: true, stdio: 'ignore', env: process.env }).unref();",
      "fs.writeFileSync(process.env.QA_JOB_SPAWNED, 'spawned');",
    ].join(' ');
    const result = await runWindowsJobCommand(process.execPath, ['-e', root], {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        QA_JOB_DESCENDANT: descendant,
        QA_JOB_MARKER: markerPath,
        QA_JOB_SPAWNED: spawnedPath,
      },
      timeoutMs: 5_000,
      descendantGraceMs: 250,
      cleanupTimeoutMs: 2_000,
    });
    assert.equal(result.status, 'BLOCKED');
    await access(spawnedPath);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_250));
    await assert.rejects(access(markerPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

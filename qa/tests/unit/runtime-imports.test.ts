import test from 'node:test';
import assert from 'node:assert/strict';

test('QA runners import under Node native TypeScript execution without side effects', async () => {
  const modules = await Promise.all([
    import('../../runner/setup.ts'),
    import('../../runner/deterministic-runner.ts'),
    import('../../runner/agent-runner.ts'),
    import('../../runner/report-runner.ts'),
    import('../../runner/clean.ts'),
    import('../../runner/full-runner.ts'),
  ]);
  assert.equal(modules.length, 6);
});

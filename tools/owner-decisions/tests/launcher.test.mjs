import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchesExistingServer } from '../src/launcher.mjs';

const expected = { sourceCommit: 'abc123', instanceId: 'instance-a' };

test('existing server is reused only when SHA and local instance identity match', () => {
  assert.equal(matchesExistingServer({ ok: true, sourceCommit: 'abc123', instanceId: 'instance-a' }, expected), true);
  assert.equal(matchesExistingServer({ ok: true, sourceCommit: 'old-sha', instanceId: 'instance-a' }, expected), false);
  assert.equal(matchesExistingServer({ ok: true, sourceCommit: 'abc123', instanceId: 'other-results-dir' }, expected), false);
  assert.equal(matchesExistingServer({ ok: true }, expected), false);
});

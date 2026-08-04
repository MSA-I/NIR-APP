import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCENARIOS,
  assertScenarioRegistry,
  getBlockedScenarios,
  getRunnableScenarios,
  getScenario,
} from './index.ts';

test('scenario registry has exactly nine ordered and valid scenarios', () => {
  assert.doesNotThrow(() => assertScenarioRegistry());
  assert.equal(SCENARIOS.length, 9);
  assert.deepEqual(SCENARIOS.map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(getRunnableScenarios().length, 8);
  assert.deepEqual(getBlockedScenarios().map(({ id }) => id), ['platform-admin']);
});

test('platform fixture is fail-closed and accountant payment requests are denied by route contract', () => {
  const platform = getScenario('platform-admin');
  assert.equal(platform.status, 'BLOCKED');
  assert.match(platform.blockedReason ?? '', /fixture/i);

  const authorization = getScenario('authorization-matrix');
  const accountant = authorization.routeExpectations.find(({ role }) => role === 'accountant');
  assert.ok(accountant);
  assert.ok(accountant.forbidden.includes('/payment-requests'));
  assert.ok(!accountant.allowed.includes('/payment-requests'));
});

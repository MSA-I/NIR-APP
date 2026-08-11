import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCENARIOS,
  assertScenarioRegistry,
  getBlockedScenarios,
  getRunnableScenarios,
  getScenario,
} from './index.ts';
import { createSyntheticQaData } from '../fixtures/data-factory.ts';

test('scenario registry has exactly nine ordered and valid scenarios', () => {
  assert.doesNotThrow(() => assertScenarioRegistry());
  assert.equal(SCENARIOS.length, 9);
  assert.deepEqual(SCENARIOS.map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(getRunnableScenarios().length, 5);
  assert.deepEqual(getBlockedScenarios().map(({ id }) => id), [
    'supplier-price-list',
    'kitchen-receiving',
    'payer-transfer-execution',
    'platform-admin',
  ]);
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

test('retired product personas remain historical scenarios and cannot be scheduled', () => {
  for (const id of ['supplier-price-list', 'kitchen-receiving', 'payer-transfer-execution'] as const) {
    const scenario = getScenario(id);
    assert.equal(scenario.status, 'BLOCKED');
    assert.match(scenario.blockedReason ?? '', /Historical/);
  }
});

test('kitchen and accountant use the same valid demo-seed supplier chain', () => {
  const receiving = getScenario('kitchen-receiving').steps.find(({ id }) => id === 'record-partial-receipt');
  const attachment = getScenario('kitchen-receiving').steps.find(({ id }) => id === 'attach-receipt-document');
  const matching = getScenario('accountant-reconciliation').steps.find(({ id }) => id === 'match-bank-payment');
  assert.ok(receiving);
  assert.ok(attachment);
  assert.ok(matching);
  assert.match(receiving.action, /בשר והבן שיווק בשרים/);
  assert.match(receiving.action, /strictly below/);
  assert.match(attachment.action, /type="upload"/);
  assert.match(attachment.action, /fixtureName="receipt-jpg"/);
  assert.match(matching.action, /בשר והבן שיווק בשרים/);
});

test('the live agent chain preserves the synthetic payment and bank contract', () => {
  const synthetic = createSyntheticQaData('qa-registry-contract');
  const invoice = getScenario('office-invoice-review').steps.find(({ id }) => id === 'create-invoice');
  const payer = getScenario('payer-transfer-execution').steps.find(({ id }) => id === 'open-approved-queue');
  const matching = getScenario('accountant-reconciliation').steps.find(({ id }) => id === 'match-bank-payment');
  assert.ok(invoice);
  assert.ok(payer);
  assert.ok(matching);
  assert.match(invoice.action, new RegExp(synthetic.bankTransaction.amount.toFixed(2)));
  assert.match(payer.action, /trusted id filter/);
  assert.match(matching.action, /automatic proposal/);
});

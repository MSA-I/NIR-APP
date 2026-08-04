import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCriticalWorkflowCoverage } from '../../runner/deterministic-runner.ts';

const ids = [
  'supplier-price-list',
  'kitchen-receiving',
  'office-invoice-review',
  'owner-payment-approval',
  'payer-transfer-execution',
  'accountant-reconciliation',
] as const;

function report(statuses: Partial<Record<(typeof ids)[number], string>>) {
  return {
    suites: [{
      specs: ids.flatMap((id) => statuses[id] ? [{
        title: `[critical:${id}] workflow`,
        tests: [{ projectName: 'critical-workflows', results: [{ status: statuses[id] }] }],
      }] : []),
    }],
  };
}

test('critical workflow coverage fails closed for missing, skipped, or failed evidence', () => {
  assert.equal(evaluateCriticalWorkflowCoverage(report(Object.fromEntries(ids.map((id) => [id, 'passed'])))).status, 'PASSED');
  assert.equal(evaluateCriticalWorkflowCoverage(report(Object.fromEntries(ids.slice(1).map((id) => [id, 'passed'])))).status, 'BLOCKED');
  assert.equal(evaluateCriticalWorkflowCoverage(report(Object.fromEntries(ids.map((id) => [id, id === ids[0] ? 'skipped' : 'passed'])))).status, 'BLOCKED');
  assert.equal(evaluateCriticalWorkflowCoverage(report(Object.fromEntries(ids.map((id) => [id, id === ids[0] ? 'failed' : 'passed'])))).status, 'FAILED');
});

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { assertQaEnvironment, QA_SUPABASE_URL } from '../../config/environments.ts';
import { QA_ROLES, isRouteAllowed } from '../../config/roles.ts';
import { getBlockedScenarios, getScenario } from '../../scenarios/index.ts';
import { assertIsolatedLocalTarget } from '../../runner/lock.ts';
import { combineVerificationStatus } from '../../verification/types.ts';

const repoRoot = process.cwd();
const validEnvironment = {
  QA_BASE_URL: 'http://127.0.0.1:4173',
  QA_SUPABASE_URL,
  QA_SUPABASE_ANON_KEY: 'public-local-anon-value',
  QA_CREDENTIALS_MANIFEST: path.resolve(repoRoot, '..', 'qa-credentials.json'),
};

describe('environment safety', () => {
  test('accepts only the isolated local project and rejects remote targets', async () => {
    const environment = assertQaEnvironment(validEnvironment, repoRoot);
    assert.equal(environment.projectId, 'supplyflow-p0');
    assert.equal(environment.supabaseUrl, QA_SUPABASE_URL);
    assert.throws(() => assertQaEnvironment({
      ...validEnvironment,
      QA_BASE_URL: 'https://example.com',
    }, repoRoot), /loopback|127\.0\.0\.1/i);
    assert.throws(() => assertQaEnvironment({
      ...validEnvironment,
      QA_SUPABASE_URL: 'https://project.supabase.co',
    }, repoRoot), /Refusing/);
    await assert.doesNotReject(assertIsolatedLocalTarget(repoRoot));
    await assert.rejects(assertIsolatedLocalTarget(repoRoot, 'https://project.supabase.co'));
  });
});

describe('role and scenario contracts', () => {
  test('defines positive and negative routes for every tenant role', () => {
    for (const role of QA_ROLES) {
      assert.equal(isRouteAllowed(role, '/dashboard'), true, role);
    }
    assert.equal(isRouteAllowed('supplier', '/my-prices'), true);
    assert.equal(isRouteAllowed('supplier', '/bank'), false);
    assert.equal(isRouteAllowed('kitchen', '/payment-requests'), false);
    assert.equal(isRouteAllowed('office', '/pay'), false);
    assert.equal(isRouteAllowed('payer', '/pay'), true);
    assert.equal(isRouteAllowed('accountant', '/suppliers'), false);
  });

  test('keeps platform administration blocked without a fixture', () => {
    const platform = getScenario('platform-admin');
    assert.equal(platform.status, 'BLOCKED');
    assert.match(platform.blockedReason ?? '', /fixture/i);
    assert.deepEqual(getBlockedScenarios().map(({ id }) => id), ['platform-admin']);
  });

  test('aggregates verifier status without hiding failures or blockers', () => {
    assert.equal(combineVerificationStatus([{ id: 'a', status: 'PASS', summary: 'ok' }]), 'PASS');
    assert.equal(combineVerificationStatus([
      { id: 'a', status: 'PASS', summary: 'ok' },
      { id: 'b', status: 'BLOCKED', summary: 'missing fixture' },
    ]), 'BLOCKED');
    assert.equal(combineVerificationStatus([
      { id: 'a', status: 'BLOCKED', summary: 'missing fixture' },
      { id: 'b', status: 'FAIL', summary: 'wrong row' },
    ]), 'FAIL');
  });
});

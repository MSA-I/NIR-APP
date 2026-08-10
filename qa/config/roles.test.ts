import assert from 'node:assert/strict';
import test from 'node:test';
import { QA_ROLES, ROLE_CONTRACTS, isRouteAllowed } from './roles.ts';

test('every canonical role contract has valid positive and negative route expectations', () => {
  assert.equal(new Set(QA_ROLES).size, 6);
  for (const role of QA_ROLES) {
    const contract = ROLE_CONTRACTS[role];
    assert.equal(contract.role, role);
    assert.equal(isRouteAllowed(role, contract.coreRoute.path), true);
    for (const route of contract.representativeAllowedRoutes) {
      assert.equal(isRouteAllowed(role, route.path), true);
    }
    for (const route of contract.deniedRoutes) {
      assert.equal(isRouteAllowed(role, route.path), false);
    }
  }
});

test('route precedence preserves the sensitive App.tsx authorization distinctions', () => {
  assert.equal(isRouteAllowed('accountant', '/invoices/example-id'), true);
  assert.equal(isRouteAllowed('accountant', '/invoices/new'), false);
  assert.equal(isRouteAllowed('supplier', '/documents/example-id/review'), true);
  assert.equal(isRouteAllowed('accountant', '/finance/suppliers/example-id'), true);
  assert.equal(isRouteAllowed('office', '/finance/suppliers/example-id'), false);
  assert.equal(isRouteAllowed('accountant', '/analytics'), false);
  assert.equal(isRouteAllowed('supplier', '/documents'), false);
  assert.equal(isRouteAllowed('owner', '/pay/emergency'), true);
  assert.equal(isRouteAllowed('owner', '/pay'), false);
  for (const role of ['owner', 'office', 'kitchen'] as const) {
    assert.equal(isRouteAllowed(role, '/receipts/example-id'), true);
  }
  for (const role of ['payer', 'accountant', 'supplier'] as const) {
    assert.equal(isRouteAllowed(role, '/receipts/example-id'), false);
  }
  assert.equal(isRouteAllowed('owner', '/admin'), false);
  assert.equal(isRouteAllowed('owner', 'https://example.com/settings'), false);
  for (const role of QA_ROLES) assert.equal(isRouteAllowed(role, '/dashboard'), true);
});

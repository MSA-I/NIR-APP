import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

const root = process.cwd();
const migration = readFileSync(path.join(root, 'supabase', 'migrations', '0073_payment_credit_override.sql'), 'utf8');
const sqlRegression = readFileSync(path.join(root, 'supabase', 'tests', 'payment_credit_override.sql'), 'utf8');
const approvalUi = readFileSync(path.join(root, 'src', 'pages', 'PaymentRequests.tsx'), 'utf8');
const payerUi = readFileSync(path.join(root, 'src', 'pages', 'PayerQueue.tsx'), 'utf8');
const checks = readFileSync(path.join(root, 'src', 'lib', 'checks.ts'), 'utf8');

describe('legal-entity-scoped open supplier credit approval contract', () => {
  test('payment requests gain scope while credit requests remain derived', () => {
    assert.match(migration, /alter table public\.payment_requests[\s\S]*add column unit_id uuid/);
    assert.match(migration, /payment_requests_unit_fk[\s\S]*foreign key \(org_id, unit_id\)/);
    assert.match(migration, /create policy scope_rider_payment_requests/);
    assert.match(migration, /private\.credit_request_legal_entity/);
    assert.match(migration, /receipt_item_id[\s\S]*goods_receipts[\s\S]*unit_type = 'legal_entity'/);
    assert.doesNotMatch(migration, /alter table public\.credit_requests[\s\S]*add column unit_id/i);
    assert.match(migration, /0073_open_credit_scope_unresolved/);
  });

  test('trusted commands bind authorization, tenant, supplier, state and replay', () => {
    assert.match(migration, /approve_payment_request_with_credit_override/);
    assert.match(migration, /v_role not in \('owner', 'office'\)/);
    assert.match(migration, /perform public\.assert_unit_in_scope\(v_request\.unit_id\)/);
    assert.match(migration, /where id = p_payment_request_id and org_id = v_org/);
    assert.match(migration, /p_expected_supplier_id is distinct from v_request\.supplier_id/);
    assert.match(migration, /payment_request_credit_override_replay_mismatch/);
    assert.match(migration, /payment_request_credit_total_changed/);
    assert.match(migration, /nullif\(btrim\(p_override_reason\), ''\)/);
    assert.doesNotMatch(migration, /evaluate_approval_policy\s*\(/);
  });

  test('one audited transition preserves the override facts without mutating credits', () => {
    assert.match(migration, /'payment_request_transitioned'/);
    assert.match(migration, /'open_credit_override', true/);
    for (const key of [
      'approving_user_id', 'organization_id', 'unit_id', 'supplier_id',
      'payment_request_id', 'open_credit_total', 'payment_request_amount',
      'override_reason', 'approved_at',
    ]) assert.match(migration, new RegExp(`'${key}'`));
    assert.doesNotMatch(migration, /update\s+public\.credit_requests/i);
    assert.doesNotMatch(migration, /insert\s+into\s+public\.payment_allocations/i);
    assert.match(sqlRegression, /replay must not duplicate audit or event records/);
  });

  test('approval UI uses the server-scoped total and requires explicit acknowledgement', () => {
    assert.match(checks, /open_credit_total: number/);
    assert.match(checks, /amount: financial\.open_credit_total/);
    assert.doesNotMatch(
      checks.slice(checks.indexOf('export async function runPaymentRequestChecks')),
      /from\('credit_requests'\)/,
    );
    assert.match(approvalUi, /לספק קיימים זיכויים פתוחים שטרם קוזזו\. אישור זה אינו מקזז את הזיכויים ואינו משנה את סכום הדרישה\./);
    assert.match(approvalUi, /אישור חריג ללא קיזוז הזיכוי/);
    assert.match(approvalUi, /סיבת אישור החריגה/);
    assert.match(approvalUi, /p_expected_open_credit_total: freshOpenCreditTotal/);
    assert.match(approvalUi, /!creditOverrideAcknowledged/);
  });

  test('payer sees the recorded decision as read-only context', () => {
    assert.match(payerUi, /pr\.open_credit_override_total != null/);
    assert.match(payerUi, /סיבת אישור החריגה: \{pr\.open_credit_override_reason\}/);
    assert.doesNotMatch(payerUi, /open_credit_override_reason\s*:/);
    assert.match(sqlRegression, /payer-visible override context must remain read-only browser data/);
  });

  test('SQL regression enumerates scope, tenant, role, stale and fail-closed cases', () => {
    for (const marker of [
      'normal approval must continue to work',
      'payment_request_credit_override_required',
      'payment_request_credit_override_invalid',
      'payment_request_credit_supplier_mismatch',
      'payment_request_credit_total_changed',
      'payment_request_transition_invalid',
      'unit_out_of_scope',
      'not_authorized',
      'payment_request_unknown',
      'payment_request_credit_scope_unresolved',
      'mixed entity request',
    ]) assert.match(sqlRegression, new RegExp(marker));
  });
});

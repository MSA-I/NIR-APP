import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

const root = process.cwd();
const migration = readFileSync(path.join(root, 'supabase', 'migrations', '0053_payment_credit_override.sql'), 'utf8');
const approvalUi = readFileSync(path.join(root, 'src', 'pages', 'PaymentRequests.tsx'), 'utf8');
const payerUi = readFileSync(path.join(root, 'src', 'pages', 'PayerQueue.tsx'), 'utf8');
const browserTools = readFileSync(path.join(root, 'qa', 'browser', 'browser-tools.ts'), 'utf8');

describe('open supplier credit approval contract', () => {
  test('ordinary approval is server-blocked and the explicit RPC binds fresh context', () => {
    assert.match(migration, /payment_request_credit_override_required/);
    assert.match(migration, /approve_payment_request_with_credit_override/);
    assert.match(migration, /p_expected_supplier_id is distinct from v_request\.supplier_id/);
    assert.match(migration, /round\(v_open_credit_total, 2\) <> round\(p_expected_open_credit_total, 2\)/);
    assert.match(migration, /v_role not in \('owner', 'office'\)/);
    assert.match(browserTools, /'open_credit_override'/);
  });

  test('override audit preserves all required decision values without changing credits', () => {
    assert.match(migration, /'payment_request_transitioned'/);
    assert.match(migration, /'open_credit_override', true/);
    for (const key of [
      'approving_user_id', 'organization_id', 'supplier_id', 'payment_request_id',
      'open_credit_total', 'payment_request_amount', 'override_reason', 'approved_at',
    ]) assert.match(migration, new RegExp(`'${key}'`));
    assert.doesNotMatch(migration, /update\s+public\.credit_requests/i);
    assert.doesNotMatch(migration, /insert\s+into\s+public\.payment_allocations/i);
  });

  test('approval UI requires the explicit acknowledgement and reason', () => {
    assert.match(approvalUi, /לספק קיימים זיכויים פתוחים שטרם קוזזו\. אישור זה אינו מקזז את הזיכויים ואינו משנה את סכום הדרישה\./);
    assert.match(approvalUi, /אישור חריג ללא קיזוז הזיכוי/);
    assert.match(approvalUi, /סיבת אישור החריגה/);
    assert.match(approvalUi, /p_expected_open_credit_total: openCreditTotal/);
    assert.match(approvalUi, /disabled=\{busy \|\| !checksReady \|\| !creditOverrideAcknowledged\}/);
  });

  test('payer receives a read-only explanation of the recorded override', () => {
    assert.match(payerUi, /pr\.open_credit_override_total != null/);
    assert.match(payerUi, /סיבת אישור החריגה: \{pr\.open_credit_override_reason\}/);
    assert.doesNotMatch(payerUi, /open_credit_override_reason\s*:/);
  });
});

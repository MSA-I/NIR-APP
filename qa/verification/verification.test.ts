import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSyntheticQaData, generateSyntheticFixtureFiles } from '../fixtures/index.ts';
import { verifyAuthorizationObservations } from './authorization-verifier.ts';
import { verifyExportFiles, type ExportExpectation } from './export-verifier.ts';
import { createVerificationResult, sanitizeEvidence } from './types.ts';

test('verification evidence redacts secret keys and bearer/JWT-like values', () => {
  const sanitized = sanitizeEvidence({
    password: 'never-publish',
    nested: { authorization: 'Bearer abcdefghijklmnop', safe: 'visible' },
    line: 'Bearer abcdefghijklmnop',
  });
  assert.equal(sanitized.password, '[REDACTED]');
  assert.deepEqual(sanitized.nested, { authorization: '[REDACTED]', safe: 'visible' });
  assert.equal(sanitized.line, 'Bearer [REDACTED]');
});

test('verification status fails before blocked/observation', () => {
  const result = createVerificationResult('self-check', 'precedence', [
    { id: 'observation', status: 'OBSERVATION', summary: 'observed' },
    { id: 'blocked', status: 'BLOCKED', summary: 'blocked' },
    { id: 'failed', status: 'FAIL', summary: 'failed' },
  ]);
  assert.equal(result.status, 'FAIL');
});

test('authorization denial requires no content and no database or audit mutation', () => {
  const pass = verifyAuthorizationObservations([{
    id: 'payer-bank-denied',
    role: 'payer',
    route: '/bank',
    operation: 'read bank transactions',
    expected: 'DENY',
    requestAttempted: true,
    responseStatus: 403,
    renderedAuthorizedContent: false,
    databaseChanged: false,
    auditChanged: false,
  }]);
  assert.equal(pass.status, 'PASS');

  const fail = verifyAuthorizationObservations([{
    id: 'payer-bank-leaked',
    role: 'payer',
    route: '/bank',
    operation: 'read bank transactions',
    expected: 'DENY',
    requestAttempted: true,
    responseStatus: 403,
    renderedAuthorizedContent: true,
    databaseChanged: false,
    auditChanged: false,
  }]);
  assert.equal(fail.status, 'FAIL');

  const hiddenOnly = verifyAuthorizationObservations([{
    id: 'payer-bank-hidden-only',
    role: 'payer',
    route: '/bank',
    operation: 'read bank transactions',
    expected: 'DENY',
    requestAttempted: false,
    redirectedTo: '/dashboard',
    renderedAuthorizedContent: false,
    databaseChanged: false,
    auditChanged: false,
  }]);
  assert.equal(hiddenOnly.status, 'FAIL', 'A hidden control alone is not authorization evidence.');
});

test('export verifier parses generated CSV, XLSX, PDF, and JPG inside artifact root', async () => {
  const managedRoot = path.join(tmpdir(), 'supplyflow-qa-verifier-tests');
  await mkdir(managedRoot, { recursive: true });
  const directory = await mkdtemp(path.join(managedRoot, 'run-'));
  const runId = 'qa-export-self-check-001';
  try {
    const data = createSyntheticQaData(runId);
    const manifest = await generateSyntheticFixtureFiles({ runId, directory });
    const byKind = new Map(manifest.files.map((file) => [file.kind, file.path]));
    const expectations: ExportExpectation[] = [
      {
        id: 'csv',
        kind: 'csv',
        filePath: byKind.get('bank-csv')!,
        expectedHeaders: ['date', 'description', 'amount', 'reference', 'qa_run_id'],
        expectedRowSubsets: [{
          description: data.bankTransaction.description,
          amount: data.bankTransaction.amount,
          reference: data.bankTransaction.reference,
        }],
        exactRowCount: 1,
        total: { column: 'amount', expected: data.bankTransaction.amount },
      },
      {
        id: 'xlsx',
        kind: 'xlsx',
        filePath: byKind.get('price-list-xlsx')!,
        expectedHeaders: ['product_id', 'product_name', 'price', 'qa_run_id'],
        expectedRowSubsets: [{
          product_id: data.products[0]!.id,
          product_name: data.products[0]!.name,
          price: data.products[0]!.price,
        }],
        exactRowCount: 3,
        forbidFormulas: true,
        total: { column: 'price', expected: data.products.reduce((sum, product) => sum + product.price, 0) },
      },
      {
        id: 'pdf',
        kind: 'pdf',
        filePath: byKind.get('invoice-pdf')!,
        expectedText: [runId, data.invoice.number],
      },
      { id: 'jpg', kind: 'jpg', filePath: byKind.get('receipt-jpg')! },
    ];
    const result = await verifyExportFiles(expectations, directory);
    assert.equal(result.status, 'PASS');
    assert.ok(result.checks.every(({ status }) => status === 'PASS'));

    const wrongBusinessRow = await verifyExportFiles([{
      id: 'wrong-business-row',
      kind: 'xlsx',
      filePath: byKind.get('price-list-xlsx')!,
      expectedRowSubsets: [{ product_id: data.products[0]!.id, price: data.products[0]!.price + 1 }],
    }], directory);
    assert.equal(wrongBusinessRow.status, 'FAIL');
    assert.equal(wrongBusinessRow.checks[0]?.evidence?.expectedRowSubsetsPresent, false);
  } finally {
    const relative = path.relative(managedRoot, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { redactText, redactUrl, safeArtifactName } from './redaction.ts';

test('browser evidence redaction removes common identity, financial and credential values', () => {
  const source = [
    'person@example.test',
    '052-6331122',
    'חשבון 445512',
    'IL123456789012345678901',
    'Bearer synthetic-secret-token',
  ].join(' | ');
  const safe = redactText(source);
  for (const secret of ['person@example.test', '052-6331122', '445512', 'IL123456789012345678901', 'synthetic-secret-token']) {
    assert.equal(safe.includes(secret), false);
  }
});

test('sensitive URL values and artifact labels are redacted before persistence', () => {
  const safeUrl = redactUrl('http://127.0.0.1:55431/rest/v1/items?token=synthetic-token&email=person@example.test');
  assert.equal(safeUrl.includes('synthetic-token'), false);
  assert.equal(safeUrl.includes('person%40example.test'), false);
  assert.equal(safeArtifactName(redactText('person@example.test'), 'artifact').includes('person'), false);
});

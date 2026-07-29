import assert from 'node:assert/strict';
import {
  jsonByteLength,
  RequestValidationError,
  validateActionRequest,
  validateExtraction,
} from './contract.ts';

const jobId = '11111111-1111-4111-8111-111111111111';
const payload = {
  schema_version: '1',
  document: { page_count: 1, detected_languages: ['he'], plain_text: 'בדיקה', partial: false },
  blocks: [{
    id: 'b1', page: 1, type: 'text', bbox: [0, 0, 1, 1], text: 'בדיקה', confidence: 0.9,
  }],
  tables: [],
  marks: [],
};

assert.equal(validateExtraction(payload), true);
assert.equal(validateExtraction({ ...payload, document: { ...payload.document, page_count: 0 } }), false);
assert.equal(validateExtraction({
  ...payload,
  blocks: [{ ...payload.blocks[0], bbox: [0.8, 0, 0.2, 1] }],
}), false);

const claim = validateActionRequest({ action: 'claim', lease_owner: ' worker-1 ' });
assert.deepEqual(claim, { action: 'claim', lease_owner: 'worker-1', lease_seconds: 120 });

const complete = validateActionRequest({
  action: 'complete',
  job_id: jobId,
  lease_owner: 'worker-1',
  engine: 'native',
  model: 'parser',
  model_version: '1',
  input_checksum: 'etag:0123456789abcdef',
  contract_version: '1',
  payload,
});
assert.equal(complete.action, 'complete');
assert.equal(jsonByteLength(complete.resource_metadata), 2);

assert.throws(
  () => validateActionRequest({ action: 'claim', lease_owner: 'worker-1', org_id: jobId }),
  (error) => error instanceof RequestValidationError && error.code === 'invalid_request',
);
assert.throws(
  () => validateActionRequest({ ...complete, payload: { ...payload, schema_version: '2' } }),
  (error) => error instanceof RequestValidationError && error.code === 'invalid_extraction',
);

console.log('document_processing_contract_self_check_passed');

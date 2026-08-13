import assert from "node:assert/strict";
import {
  MAX_SCAN_OUTPUT_BYTES,
  SCAN_GATEWAY_CONTRACT_HEADER,
  SCAN_GATEWAY_CONTRACT_VERSION,
  scanGatewayContractMatches,
  ScanRequestValidationError,
  validateScanActionRequest,
  validateScanMetadata,
} from "./contract.ts";

const jobId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const leaseToken = "44444444-4444-4444-8444-444444444444";
const metadata = {
  schema_version: "1" as const,
  output_sha256: "a".repeat(64),
  output_bytes: 1024,
  width: 1200,
  height: 1800,
  corners: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
  rotation_degrees: 0.4,
  output_mode: "black_and_white",
  corners_source: "automatic",
  metrics: { shadow: 0.2 },
};

Deno.test("document scan action contract is strict", () => {
  assert.equal(validateScanMetadata(metadata), true);
  assert.equal(validateScanMetadata({ ...metadata, width: 32 }), false);
  assert.equal(validateScanMetadata({
    ...metadata,
    corners: [[0.1, 0.1], [0.9, 0.9], [0.9, 0.1], [0.1, 0.9]],
  }), false);
  assert.deepEqual(validateScanActionRequest({
    action: "claim",
    lease_owner: " scanner-1 ",
  }), { action: "claim", lease_owner: "scanner-1", lease_seconds: 120 });
  assert.equal(validateScanActionRequest({
    action: "complete",
    job_id: jobId,
    processing_attempt_id: attemptId,
    lease_owner: "scanner-1",
    download_lease_id: leaseId,
    download_lease_token: leaseToken,
    input_checksum: "etag:0123456789abcdef",
    output_base64: "iVBORw==",
    metadata,
  }).action, "complete");
  assert.throws(() => validateScanActionRequest({
    action: "complete",
    job_id: jobId,
    processing_attempt_id: attemptId,
    lease_owner: "scanner-1",
    download_lease_id: leaseId,
    download_lease_token: leaseToken,
    input_checksum: "etag:0123456789abcdef",
    output_base64: "a".repeat(Math.ceil(MAX_SCAN_OUTPUT_BYTES / 3) * 4 + 8),
    metadata,
  }), ScanRequestValidationError);
  assert.equal(validateScanActionRequest({
    action: "ack_download",
    job_id: jobId,
    lease_owner: "scanner-1",
    download_lease_id: leaseId,
    download_lease_token: leaseToken,
  }).action, "ack_download");
  assert.equal(validateScanActionRequest({
    action: "heartbeat",
    job_id: jobId,
    lease_owner: "scanner-1",
    download_lease_id: leaseId,
    download_lease_token: leaseToken,
    lease_seconds: 180,
  }).action, "heartbeat");
  assert.equal(validateScanActionRequest({
    action: "fail",
    job_id: jobId,
    processing_attempt_id: attemptId,
    lease_owner: "scanner-1",
    download_lease_id: leaseId,
    download_lease_token: leaseToken,
    error_code: "document_not_detected",
    error_message: null,
    retryable: false,
  }).action, "fail");
  assert.throws(() => validateScanActionRequest({
    action: "heartbeat",
    job_id: jobId,
    lease_owner: "scanner-1",
    download_lease_id: leaseId,
    download_lease_token: leaseToken,
    processing_attempt_id: attemptId,
  }), ScanRequestValidationError);
  assert.throws(() => validateScanActionRequest({
    action: "fail",
    job_id: jobId,
    processing_attempt_id: attemptId,
    lease_owner: "scanner-1",
    download_lease_id: leaseId,
    download_lease_token: leaseToken,
    error_code: "Document Not Detected",
  }), ScanRequestValidationError);
  assert.throws(() => validateScanActionRequest({
    action: "claim",
    lease_owner: "scanner-1",
    org_id: jobId,
  }), ScanRequestValidationError);
});

Deno.test("document scan gateway handshake is exact", () => {
  assert.equal(SCAN_GATEWAY_CONTRACT_VERSION, "2");
  assert.equal(scanGatewayContractMatches(new Headers({
    [SCAN_GATEWAY_CONTRACT_HEADER]: SCAN_GATEWAY_CONTRACT_VERSION,
  })), true);
  assert.equal(scanGatewayContractMatches(new Headers()), false);
});

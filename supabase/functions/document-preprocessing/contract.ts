export const SCAN_GATEWAY_CONTRACT_HEADER =
  "x-document-scan-gateway-contract-version";
export const SCAN_GATEWAY_CONTRACT_VERSION = "2";
export const MAX_SCAN_REQUEST_BYTES = 15 * 1024 * 1024;
export const MAX_SCAN_SMALL_REQUEST_BYTES = 16 * 1024;
export const MAX_SCAN_OUTPUT_BYTES = 10 * 1024 * 1024;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM = /^etag:[0-9a-f]{16,128}(?:-[0-9]+)?$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^[a-z0-9_]{1,100}$/;

export type ScanClaimRequest = {
  action: "claim";
  lease_owner: string;
  lease_seconds: number;
};
export type ScanHeartbeatRequest = {
  action: "heartbeat";
  job_id: string;
  lease_owner: string;
  download_lease_id: string;
  download_lease_token: string;
  lease_seconds: number;
};
export type ScanAcknowledgeDownloadRequest = {
  action: "ack_download";
  job_id: string;
  lease_owner: string;
  download_lease_id: string;
  download_lease_token: string;
  lease_seconds: number;
};
export type ScanCompleteRequest = {
  action: "complete";
  job_id: string;
  processing_attempt_id: string;
  lease_owner: string;
  download_lease_id: string;
  download_lease_token: string;
  input_checksum: string;
  output_base64: string;
  metadata: ScanMetadata;
};
export type ScanFailRequest = {
  action: "fail";
  job_id: string;
  processing_attempt_id: string;
  lease_owner: string;
  download_lease_id: string;
  download_lease_token: string;
  error_code: string;
  error_message: string | null;
  retryable: boolean;
};
export type ScanActionRequest =
  | ScanClaimRequest
  | ScanAcknowledgeDownloadRequest
  | ScanHeartbeatRequest
  | ScanCompleteRequest
  | ScanFailRequest;

export type ScanMetadata = {
  schema_version: "1";
  output_sha256: string;
  output_bytes: number;
  width: number;
  height: number;
  corners: [[number, number], [number, number], [number, number], [number, number]];
  rotation_degrees: number;
  output_mode: "grayscale" | "black_and_white";
  corners_source: "automatic" | "manual";
  metrics: Record<string, number>;
};

export class ScanRequestValidationError extends Error {
  readonly code = "invalid_request";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exact(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function trimmed(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result && result.length <= maximum ? result : null;
}

function leaseSeconds(value: unknown): number | null {
  const seconds = value === undefined ? 120 : value;
  return Number.isInteger(seconds) && Number(seconds) >= 30 &&
      Number(seconds) <= 900
    ? Number(seconds)
    : null;
}

function validCorners(value: unknown): value is ScanMetadata["corners"] {
  if (!Array.isArray(value) || value.length !== 4) return false;
  if (!value.every((point) =>
    Array.isArray(point) && point.length === 2 && point.every((coordinate) =>
      typeof coordinate === "number" && Number.isFinite(coordinate) &&
      coordinate >= 0 && coordinate <= 1
    )
  )) return false;
  const points = value as ScanMetadata["corners"];
  const area = Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[1] - point[1] * next[0];
  }, 0)) / 2;
  const crosses = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const after = points[(index + 2) % points.length];
    return (next[0] - point[0]) * (after[1] - next[1]) -
      (next[1] - point[1]) * (after[0] - next[0]);
  });
  return area >= 0.08 &&
    (crosses.every((cross) => cross > 0) || crosses.every((cross) => cross < 0));
}

export function validateScanMetadata(value: unknown): value is ScanMetadata {
  if (!exact(value, [
    "schema_version",
    "output_sha256",
    "output_bytes",
    "width",
    "height",
    "corners",
    "rotation_degrees",
    "output_mode",
    "corners_source",
    "metrics",
  ])) return false;
  return value.schema_version === "1" &&
    typeof value.output_sha256 === "string" &&
    SHA256.test(value.output_sha256) &&
    Number.isInteger(value.output_bytes) && Number(value.output_bytes) >= 1 &&
    Number(value.output_bytes) <= MAX_SCAN_OUTPUT_BYTES &&
    Number.isInteger(value.width) && Number(value.width) >= 64 &&
    Number(value.width) <= 4096 &&
    Number.isInteger(value.height) && Number(value.height) >= 64 &&
    Number(value.height) <= 4096 &&
    validCorners(value.corners) &&
    typeof value.rotation_degrees === "number" &&
    Number.isFinite(value.rotation_degrees) &&
    value.rotation_degrees >= -7 && value.rotation_degrees <= 7 &&
    ["grayscale", "black_and_white"].includes(String(value.output_mode)) &&
    ["automatic", "manual"].includes(String(value.corners_source)) &&
    isRecord(value.metrics) && Object.keys(value.metrics).length <= 20 &&
    Object.values(value.metrics).every((metric) =>
      typeof metric === "number" && Number.isFinite(metric)
    );
}

export function scanGatewayContractMatches(headers: Headers): boolean {
  return headers.get(SCAN_GATEWAY_CONTRACT_HEADER) ===
    SCAN_GATEWAY_CONTRACT_VERSION;
}

export function validateScanActionRequest(value: unknown): ScanActionRequest {
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new ScanRequestValidationError();
  }
  const leaseOwner = trimmed(value.lease_owner, 200);
  const seconds = leaseSeconds(value.lease_seconds);
  if (value.action === "claim") {
    if (!exact(value, ["action", "lease_owner"], ["lease_seconds"]) ||
      !leaseOwner || !seconds) throw new ScanRequestValidationError();
    return { action: "claim", lease_owner: leaseOwner, lease_seconds: seconds };
  }
  const jobId = typeof value.job_id === "string" && UUID.test(value.job_id)
    ? value.job_id
    : null;
  const downloadLeaseId = typeof value.download_lease_id === "string" &&
      UUID.test(value.download_lease_id) ? value.download_lease_id : null;
  const downloadLeaseToken = typeof value.download_lease_token === "string" &&
      UUID.test(value.download_lease_token) ? value.download_lease_token : null;
  if (value.action === "heartbeat" || value.action === "ack_download") {
    if (!exact(value, [
      "action", "job_id", "lease_owner", "download_lease_id", "download_lease_token",
    ], ["lease_seconds"]) || !jobId || !leaseOwner || !seconds ||
      !downloadLeaseId || !downloadLeaseToken) throw new ScanRequestValidationError();
    return {
      action: value.action,
      job_id: jobId,
      lease_owner: leaseOwner,
      download_lease_id: downloadLeaseId,
      download_lease_token: downloadLeaseToken,
      lease_seconds: seconds,
    };
  }
  if (value.action === "complete") {
    if (!exact(value, [
      "action",
      "job_id",
      "processing_attempt_id",
      "lease_owner",
      "download_lease_id",
      "download_lease_token",
      "input_checksum",
      "output_base64",
      "metadata",
    ]) || !jobId || !leaseOwner ||
      typeof value.processing_attempt_id !== "string" || !UUID.test(value.processing_attempt_id) ||
      !downloadLeaseId || !downloadLeaseToken || typeof value.input_checksum !== "string" ||
      !CHECKSUM.test(value.input_checksum) ||
      typeof value.output_base64 !== "string" ||
      value.output_base64.length > Math.ceil(MAX_SCAN_OUTPUT_BYTES / 3) * 4 + 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.output_base64) ||
      !validateScanMetadata(value.metadata)) {
      throw new ScanRequestValidationError();
    }
    return {
      action: "complete",
      job_id: jobId,
      processing_attempt_id: value.processing_attempt_id,
      lease_owner: leaseOwner,
      download_lease_id: downloadLeaseId,
      download_lease_token: downloadLeaseToken,
      input_checksum: value.input_checksum,
      output_base64: value.output_base64,
      metadata: value.metadata,
    };
  }
  if (value.action === "fail") {
    const errorCode = trimmed(value.error_code, 100);
    const errorMessage = value.error_message === undefined || value.error_message === null
      ? null
      : trimmed(value.error_message, 1000);
    const retryable = value.retryable === undefined ? false : value.retryable;
    if (!exact(value, [
      "action", "job_id", "processing_attempt_id", "lease_owner",
      "download_lease_id", "download_lease_token", "error_code",
    ], [
      "error_message",
      "retryable",
    ]) || !jobId || !leaseOwner ||
      typeof value.processing_attempt_id !== "string" || !UUID.test(value.processing_attempt_id) ||
      !downloadLeaseId || !downloadLeaseToken || !errorCode || !ERROR_CODE.test(errorCode) ||
      typeof retryable !== "boolean" ||
      (value.error_message !== undefined && value.error_message !== null && !errorMessage)) {
      throw new ScanRequestValidationError();
    }
    return {
      action: "fail",
      job_id: jobId,
      processing_attempt_id: value.processing_attempt_id,
      lease_owner: leaseOwner,
      download_lease_id: downloadLeaseId,
      download_lease_token: downloadLeaseToken,
      error_code: errorCode,
      error_message: errorMessage,
      retryable,
    };
  }
  throw new ScanRequestValidationError();
}

export const SCAN_GATEWAY_CONTRACT_HEADER =
  "x-document-scan-gateway-contract-version";
export const SCAN_GATEWAY_CONTRACT_VERSION = "3";
export const MAX_SCAN_REQUEST_BYTES = 15 * 1024 * 1024;
export const MAX_SCAN_SMALL_REQUEST_BYTES = 16 * 1024;
export const MAX_SCAN_OUTPUT_BYTES = 10 * 1024 * 1024;
export const MAX_SCAN_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_SCAN_SOURCE_PIXELS = 40_000_000;
export const MAX_SCAN_DECODED_BYTES = 100 * 1024 * 1024;

/**
 * Every value the worker may report as the source container, and nothing else.
 *
 * This is a closed set on three layers (worker, here, `0179`), so it can only stay closed if the
 * worker never reports anything outside it — which is why `worker/ocr/src/scanning.py` maps any
 * label it does not recognise, and the case where Pillow names no format at all, onto `UNKNOWN`
 * rather than passing the raw string through.
 *
 * `MPO` is the case that forced this. Pillow reports `MPO` for a multi-picture JPEG — ordinary
 * iPhone and Android HDR/Live captures — whose mime type is `image/jpeg`, which upload already
 * accepts (`0136:11-13`). A closed list without it turns a legal photograph into
 * `invalid_request` 400 and fails the scan job on an image nothing else in the system objects
 * to. The format label is provenance, not a gate: the real safety bounds are the byte, pixel and
 * decoded-memory limits above, and those are unaffected by what the container is called.
 */
export const SCAN_SOURCE_FORMATS = [
  "JPEG",
  "JPEG2000",
  "MPO",
  "PNG",
  "WEBP",
  "HEIF",
  "HEIC",
  "AVIF",
  "GIF",
  "BMP",
  "TIFF",
  "PPM",
  "UNKNOWN",
] as const;

/** The formats `pillow-heif` opens; every other source format must have been read by Pillow. */
export const SCAN_HEIF_SOURCE_FORMATS = ["HEIF", "HEIC", "AVIF"] as const;

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
  corners_source: "automatic" | "manual" | "full_frame_fallback";
  metrics: Record<string, number>;
  provenance: ScanProvenance;
};

export type ScanProvenance = {
  schema_version: "1";
  source_sha256: string;
  source_bytes: number;
  source_width: number;
  source_height: number;
  source_format: string;
  decoder: "pillow" | "pillow-heif";
  decoder_version: string;
  decoded_bytes: number;
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
    "provenance",
  ])) return false;
  const provenance = value.provenance;
  const provenanceValid = exact(provenance, [
    "schema_version", "source_sha256", "source_bytes", "source_width", "source_height",
    "source_format", "decoder", "decoder_version", "decoded_bytes",
  ]) && provenance.schema_version === "1" &&
    typeof provenance.source_sha256 === "string" && SHA256.test(provenance.source_sha256) &&
    Number.isInteger(provenance.source_bytes) && Number(provenance.source_bytes) >= 1 &&
    Number(provenance.source_bytes) <= MAX_SCAN_SOURCE_BYTES &&
    Number.isInteger(provenance.source_width) && Number(provenance.source_width) >= 32 &&
    Number(provenance.source_width) <= 65_535 &&
    Number.isInteger(provenance.source_height) && Number(provenance.source_height) >= 32 &&
    Number(provenance.source_height) <= 65_535 &&
    Number(provenance.source_width) * Number(provenance.source_height) <= MAX_SCAN_SOURCE_PIXELS &&
    typeof provenance.source_format === "string" &&
    (SCAN_SOURCE_FORMATS as readonly string[]).includes(provenance.source_format) &&
    ["pillow", "pillow-heif"].includes(String(provenance.decoder)) &&
    ((SCAN_HEIF_SOURCE_FORMATS as readonly string[]).includes(provenance.source_format)
      ? provenance.decoder === "pillow-heif"
      : provenance.decoder === "pillow") &&
    typeof provenance.decoder_version === "string" &&
    /^[0-9A-Za-z][0-9A-Za-z._+-]{0,99}$/.test(provenance.decoder_version) &&
    Number.isInteger(provenance.decoded_bytes) &&
    Number(provenance.decoded_bytes) ===
      Number(provenance.source_width) * Number(provenance.source_height) * 3 &&
    Number(provenance.decoded_bytes) <= MAX_SCAN_DECODED_BYTES;
  const fullFrame = JSON.stringify(value.corners) === JSON.stringify(
    [[0, 0], [1, 0], [1, 1], [0, 1]],
  );
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
    ["automatic", "manual", "full_frame_fallback"].includes(String(value.corners_source)) &&
    (value.corners_source !== "full_frame_fallback" || fullFrame) &&
    isRecord(value.metrics) && Object.keys(value.metrics).length <= 20 &&
    Object.values(value.metrics).every((metric) =>
      typeof metric === "number" && Number.isFinite(metric)
    ) && provenanceValid;
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

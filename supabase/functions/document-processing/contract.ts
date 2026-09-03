export const MAX_REQUEST_BYTES = 26 * 1024 * 1024;
export const MAX_EXTRACTION_BYTES = 25 * 1024 * 1024;
export const MAX_SMALL_REQUEST_BYTES = 16 * 1024;
export const MAX_RESOURCE_METADATA_BYTES = 64 * 1024;
export const DEFAULT_LEASE_SECONDS = 120;
export const GATEWAY_CONTRACT_HEADER = "x-ocr-gateway-contract-version";
// 2 -> 3 (#20): the extraction payload gained a REQUIRED `normalizations` array, so a worker
// built before it can no longer produce a payload this gateway accepts. The number moves on BOTH
// sides in the same commit -- `worker/ocr/src/gateway.py` -- because moving it on one side leaves
// a pool that reports `Up`, claims every job and fails `gateway_contract_mismatch` on every poll
// while the screen says "waiting in queue". That is a3603c0: five days, zero documents processed.
export const GATEWAY_CONTRACT_VERSION = "4";

type JsonObject = Record<string, unknown>;

export type ClaimRequest = {
  action: "claim";
  lease_owner: string;
  lease_seconds: number;
};

export type HeartbeatRequest = {
  action: "heartbeat";
  job_id: string;
  lease_owner: string;
  download_lease_id: string;
  download_lease_token: string;
  lease_seconds: number;
  /**
   * Pages transcribed so far in this attempt, or null when the worker has nothing to report.
   *
   * Optional on the wire and additive on purpose: a worker built before this field exists keeps
   * heartbeating exactly as it did, so the gateway contract version does not move and the pool
   * does not have to be replaced in lockstep with the function.
   */
  progress_done: number | null;
  progress_total: number | null;
};

export type AcknowledgeDownloadRequest = {
  action: "ack_download";
  job_id: string;
  lease_owner: string;
  download_lease_id: string;
  download_lease_token: string;
  lease_seconds: number;
};

export type CompleteRequest = {
  action: "complete";
  job_id: string;
  processing_attempt_id: string;
  lease_owner: string;
  download_lease_id: string;
  download_lease_token: string;
  engine: string;
  model: string;
  model_version: string;
  input_checksum: string;
  contract_version: "1";
  payload: JsonObject;
  duration_ms: number | null;
  resource_metadata: JsonObject;
};

export type FailRequest = {
  action: "fail";
  job_id: string;
  lease_owner: string;
  download_lease_id: string;
  download_lease_token: string;
  error_code: string;
  error_message: string | null;
  retryable: boolean;
};

export type ActionRequest =
  | ClaimRequest
  | HeartbeatRequest
  | AcknowledgeDownloadRequest
  | CompleteRequest
  | FailRequest;

export class RequestValidationError extends Error {
  readonly code: "invalid_request" | "invalid_extraction";

  constructor(code: "invalid_request" | "invalid_extraction") {
    super(code);
    this.code = code;
  }
}

export function gatewayContractMatches(headers: Headers): boolean {
  return headers.get(GATEWAY_CONTRACT_HEADER) === GATEWAY_CONTRACT_VERSION;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKSUM = /^etag:[0-9a-f]{16,128}(?:-[0-9]+)?$/i;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,99}$/;
const BLOCK_TYPES = new Set([
  "text",
  "heading",
  "table",
  "image",
  "handwriting",
]);
const MARK_KINDS = new Set([
  "circle",
  "check",
  "cross",
  "underline",
  "star",
  "custom",
  "unknown",
]);

// #20. One entry per text correction the worker's parser EVALUATED, whether or not it changed
// anything. `applied: false` with a null original says "evaluated, the stored text IS what the
// document said"; `applied: true` carries the exact string the detector judged, before a
// character moved. An empty array says no corrector ran on that parser path at all -- true for a
// spreadsheet, never true for a PDF.
//
// REQUIRED here, and that is the whole reason GATEWAY_CONTRACT_VERSION moved to "3". A worker
// that omits it is a worker that cannot say whether it rewrote the text, and the gateway is the
// last place that can refuse such a payload before it becomes immutable evidence.
//
// The id set is closed and mirrors `worker/ocr/src/contract.py`. Adding a corrector is a contract
// change on both sides of this wire, deliberately.
// "4": a second corrector, `hebrew_line_order`. A worker still on "3" cannot emit it, and a
// worker on "4" emits two entries where a "3" validator allowed one -- so the number moves
// on both sides in the same commit and the VPS is redeployed WITH it, never after it.
const NORMALIZATION_IDS = new Set(["hebrew_visual_order", "hebrew_line_order"]);
const MAX_NORMALIZATION_MEASUREMENTS = 16;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasExactKeys(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is JsonObject {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function trimmedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

function leaseSeconds(value: unknown): number | null {
  if (value === undefined) return DEFAULT_LEASE_SECONDS;
  return Number.isInteger(value) && Number(value) >= 30 && Number(value) <= 900
    ? Number(value)
    : null;
}

/**
 * Either both counters or neither, and always inside the extraction page limit.
 *
 * `undefined` means "not reported" and is the healthy case for an older worker. Anything else that
 * does not parse is rejected rather than dropped: a heartbeat carrying `done: 130, total: 27` is a
 * worker whose page accounting is wrong, and silently discarding half of it would hide that while
 * the screen went on showing a number.
 */
function pageProgress(
  value: JsonObject,
): { progress_done: number | null; progress_total: number | null } | null {
  if (value.progress_done === undefined && value.progress_total === undefined) {
    return { progress_done: null, progress_total: null };
  }
  const done = value.progress_done;
  const total = value.progress_total;
  if (
    !Number.isInteger(done) || !Number.isInteger(total) ||
    Number(total) < 1 || Number(total) > 100 ||
    Number(done) < 0 || Number(done) > Number(total)
  ) {
    return null;
  }
  return { progress_done: Number(done), progress_total: Number(total) };
}

function downloadLeaseReceipt(value: JsonObject): {
  download_lease_id: string;
  download_lease_token: string;
} | null {
  const leaseId = typeof value.download_lease_id === "string" &&
      UUID.test(value.download_lease_id)
    ? value.download_lease_id
    : null;
  const leaseToken = typeof value.download_lease_token === "string" &&
      UUID.test(value.download_lease_token)
    ? value.download_lease_token
    : null;
  return leaseId && leaseToken
    ? { download_lease_id: leaseId, download_lease_token: leaseToken }
    : null;
}

function codePointLengthAtMost(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    if (++count > maximum) return false;
  }
  return true;
}

function validPage(value: unknown, pageCount: number): value is number {
  return Number.isInteger(value) && Number(value) >= 1 &&
    Number(value) <= pageCount;
}

function validBox(value: unknown): boolean {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((coordinate) =>
      typeof coordinate === "number" &&
      Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1
    ) &&
    value[2] >= value[0] &&
    value[3] >= value[1];
}

function validConfidence(value: unknown): boolean {
  return value === null ||
    (typeof value === "number" && Number.isFinite(value) &&
      value >= 0 && value <= 1);
}

function validNormalizations(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > NORMALIZATION_IDS.size) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !hasExactKeys(entry, ["id", "applied", "original_text", "measurements"]) ||
      typeof entry.id !== "string" || !NORMALIZATION_IDS.has(entry.id) ||
      seen.has(entry.id) ||
      typeof entry.applied !== "boolean"
    ) {
      return false;
    }
    seen.add(entry.id);
    // The pairing, enforced rather than described. A correction that changed the text must carry
    // what the text was; one that changed nothing must not carry a second copy of what it left
    // alone, because storing one would be a claim that something happened.
    if (entry.applied) {
      if (
        typeof entry.original_text !== "string" ||
        !codePointLengthAtMost(entry.original_text, 2_000_000)
      ) {
        return false;
      }
    } else if (entry.original_text !== null) {
      return false;
    }
    if (
      !Array.isArray(entry.measurements) ||
      entry.measurements.length > MAX_NORMALIZATION_MEASUREMENTS
    ) {
      return false;
    }
    const names = new Set<string>();
    for (const measurement of entry.measurements) {
      if (
        !hasExactKeys(measurement, ["name", "value"]) ||
        typeof measurement.name !== "string" ||
        measurement.name.length === 0 || measurement.name.length > 100 ||
        names.has(measurement.name) ||
        typeof measurement.value !== "number" ||
        !Number.isFinite(measurement.value)
      ) {
        return false;
      }
      names.add(measurement.name);
    }
  }
  return true;
}

export function validateExtraction(value: unknown): value is JsonObject {
  if (
    !hasExactKeys(value, [
      "schema_version",
      "document",
      "blocks",
      "tables",
      "marks",
      "normalizations",
    ]) ||
    !validNormalizations(value.normalizations) ||
    value.schema_version !== "1" ||
    !hasExactKeys(value.document, [
      "page_count",
      "detected_languages",
      "plain_text",
      "partial",
    ]) ||
    !Number.isInteger(value.document.page_count) ||
    Number(value.document.page_count) < 1 ||
    Number(value.document.page_count) > 100 ||
    !Array.isArray(value.document.detected_languages) ||
    !value.document.detected_languages.every((language) =>
      typeof language === "string"
    ) ||
    typeof value.document.plain_text !== "string" ||
    !codePointLengthAtMost(value.document.plain_text, 2_000_000) ||
    typeof value.document.partial !== "boolean" ||
    !Array.isArray(value.blocks) ||
    !Array.isArray(value.tables) ||
    !Array.isArray(value.marks)
  ) {
    return false;
  }

  const pageCount = value.document.page_count as number;
  for (const block of value.blocks) {
    if (
      !hasExactKeys(block, [
        "id",
        "page",
        "type",
        "bbox",
        "text",
        "confidence",
      ]) ||
      typeof block.id !== "string" || block.id.length === 0 ||
      !validPage(block.page, pageCount) ||
      typeof block.type !== "string" || !BLOCK_TYPES.has(block.type) ||
      !validBox(block.bbox) ||
      typeof block.text !== "string" ||
      !validConfidence(block.confidence)
    ) {
      return false;
    }
  }

  let totalRows = 0;
  for (const table of value.tables) {
    if (
      !hasExactKeys(table, ["id", "page", "bbox", "rows"]) ||
      typeof table.id !== "string" || table.id.length === 0 ||
      !validPage(table.page, pageCount) ||
      !validBox(table.bbox) ||
      !Array.isArray(table.rows) ||
      (totalRows += table.rows.length) > 5000
    ) {
      return false;
    }
    for (const row of table.rows) {
      if (!Array.isArray(row)) return false;
      for (const cell of row) {
        if (
          !hasExactKeys(cell, ["text", "bbox"]) ||
          typeof cell.text !== "string" ||
          !(cell.bbox === null || validBox(cell.bbox))
        ) {
          return false;
        }
      }
    }
  }

  for (const mark of value.marks) {
    if (
      !hasExactKeys(mark, [
        "id",
        "page",
        "kind",
        "bbox",
        "nearby_block_ids",
        "confidence",
        "fingerprint",
      ]) ||
      typeof mark.id !== "string" || mark.id.length === 0 ||
      !validPage(mark.page, pageCount) ||
      typeof mark.kind !== "string" || !MARK_KINDS.has(mark.kind) ||
      !validBox(mark.bbox) ||
      !Array.isArray(mark.nearby_block_ids) ||
      !mark.nearby_block_ids.every((id) => typeof id === "string") ||
      !validConfidence(mark.confidence) ||
      !(typeof mark.fingerprint === "string" || mark.fingerprint === null)
    ) {
      return false;
    }
  }

  return true;
}

export function validateActionRequest(value: unknown): ActionRequest {
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new RequestValidationError("invalid_request");
  }

  const leaseOwner = trimmedString(value.lease_owner, 200);
  if (value.action === "claim") {
    const seconds = leaseSeconds(value.lease_seconds);
    if (
      !hasExactKeys(value, ["action", "lease_owner"], ["lease_seconds"]) ||
      !leaseOwner || !seconds
    ) {
      throw new RequestValidationError("invalid_request");
    }
    return { action: "claim", lease_owner: leaseOwner, lease_seconds: seconds };
  }

  const jobId = typeof value.job_id === "string" && UUID.test(value.job_id)
    ? value.job_id
    : null;
  if (value.action === "heartbeat") {
    const seconds = leaseSeconds(value.lease_seconds);
    const receipt = downloadLeaseReceipt(value);
    const progress = isRecord(value) ? pageProgress(value) : null;
    if (
      !hasExactKeys(value, [
        "action",
        "job_id",
        "lease_owner",
        "download_lease_id",
        "download_lease_token",
      ], ["lease_seconds", "progress_done", "progress_total"]) || !jobId ||
      !leaseOwner || !seconds || !receipt || !progress
    ) {
      throw new RequestValidationError("invalid_request");
    }
    return {
      action: "heartbeat",
      job_id: jobId,
      lease_owner: leaseOwner,
      ...receipt,
      lease_seconds: seconds,
      ...progress,
    };
  }

  if (value.action === "ack_download") {
    const receipt = downloadLeaseReceipt(value);
    const seconds = leaseSeconds(value.lease_seconds);
    if (
      !hasExactKeys(value, [
        "action",
        "job_id",
        "lease_owner",
        "download_lease_id",
        "download_lease_token",
      ], ["lease_seconds"]) || !jobId || !leaseOwner || !receipt || !seconds
    ) {
      throw new RequestValidationError("invalid_request");
    }
    return {
      action: "ack_download",
      job_id: jobId,
      lease_owner: leaseOwner,
      ...receipt,
      lease_seconds: seconds,
    };
  }

  if (value.action === "complete") {
    const receipt = downloadLeaseReceipt(value);
    const processingAttemptId =
      typeof value.processing_attempt_id === "string" &&
        UUID.test(value.processing_attempt_id)
        ? value.processing_attempt_id
        : null;
    if (
      !hasExactKeys(value, [
        "action",
        "job_id",
        "processing_attempt_id",
        "lease_owner",
        "download_lease_id",
        "download_lease_token",
        "engine",
        "model",
        "model_version",
        "input_checksum",
        "contract_version",
        "payload",
      ], ["duration_ms", "resource_metadata"]) || !jobId ||
      !processingAttemptId || !leaseOwner || !receipt
    ) {
      throw new RequestValidationError("invalid_request");
    }
    const engine = trimmedString(value.engine, 100);
    const model = trimmedString(value.model, 200);
    const modelVersion = trimmedString(value.model_version, 200);
    const duration = value.duration_ms === undefined ? null : value.duration_ms;
    const metadata = value.resource_metadata === undefined
      ? {}
      : value.resource_metadata;
    if (
      !engine || !model || !modelVersion ||
      typeof value.input_checksum !== "string" ||
      !CHECKSUM.test(value.input_checksum) ||
      value.contract_version !== "1" ||
      !(duration === null ||
        (Number.isInteger(duration) && Number(duration) >= 0 &&
          Number(duration) <= 2_147_483_647)) ||
      !isRecord(metadata)
    ) {
      throw new RequestValidationError("invalid_request");
    }
    if (!validateExtraction(value.payload)) {
      throw new RequestValidationError("invalid_extraction");
    }
    return {
      action: "complete",
      job_id: jobId,
      processing_attempt_id: processingAttemptId,
      lease_owner: leaseOwner,
      ...receipt,
      engine,
      model,
      model_version: modelVersion,
      input_checksum: value.input_checksum,
      contract_version: "1",
      payload: value.payload,
      duration_ms: duration as number | null,
      resource_metadata: metadata,
    };
  }

  if (value.action === "fail") {
    const receipt = downloadLeaseReceipt(value);
    if (
      !hasExactKeys(value, [
        "action",
        "job_id",
        "lease_owner",
        "download_lease_id",
        "download_lease_token",
        "error_code",
      ], ["error_message", "retryable"]) || !jobId || !leaseOwner || !receipt
    ) {
      throw new RequestValidationError("invalid_request");
    }
    const errorCode = trimmedString(value.error_code, 100);
    const errorMessage =
      value.error_message === undefined || value.error_message === null
        ? null
        : trimmedString(value.error_message, 1000);
    const retryable = value.retryable === undefined ? false : value.retryable;
    if (
      !errorCode || !ERROR_CODE.test(errorCode) ||
      typeof retryable !== "boolean" ||
      (value.error_message !== undefined && value.error_message !== null &&
        !errorMessage)
    ) {
      throw new RequestValidationError("invalid_request");
    }
    return {
      action: "fail",
      job_id: jobId,
      lease_owner: leaseOwner,
      ...receipt,
      error_code: errorCode,
      error_message: errorMessage,
      retryable,
    };
  }

  throw new RequestValidationError("invalid_request");
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

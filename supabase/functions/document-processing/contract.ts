export const MAX_REQUEST_BYTES = 26 * 1024 * 1024;
export const MAX_EXTRACTION_BYTES = 25 * 1024 * 1024;
export const MAX_SMALL_REQUEST_BYTES = 16 * 1024;
export const MAX_RESOURCE_METADATA_BYTES = 64 * 1024;
export const DEFAULT_LEASE_SECONDS = 120;

type JsonObject = Record<string, unknown>;

export type ClaimRequest = {
  action: 'claim';
  lease_owner: string;
  lease_seconds: number;
};

export type HeartbeatRequest = {
  action: 'heartbeat';
  job_id: string;
  lease_owner: string;
  lease_seconds: number;
};

export type CompleteRequest = {
  action: 'complete';
  job_id: string;
  lease_owner: string;
  engine: string;
  model: string;
  model_version: string;
  input_checksum: string;
  contract_version: '1';
  payload: JsonObject;
  duration_ms: number | null;
  resource_metadata: JsonObject;
};

export type FailRequest = {
  action: 'fail';
  job_id: string;
  lease_owner: string;
  error_code: string;
  error_message: string | null;
};

export type ActionRequest = ClaimRequest | HeartbeatRequest | CompleteRequest | FailRequest;

export class RequestValidationError extends Error {
  readonly code: 'invalid_request' | 'invalid_extraction';

  constructor(code: 'invalid_request' | 'invalid_extraction') {
    super(code);
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKSUM = /^etag:[0-9a-f]{16,128}(?:-[0-9]+)?$/i;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,99}$/;
const BLOCK_TYPES = new Set(['text', 'heading', 'table', 'image', 'handwriting']);
const MARK_KINDS = new Set(['circle', 'check', 'cross', 'underline', 'star', 'custom', 'unknown']);

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(value: unknown, required: string[], optional: string[] = []): value is JsonObject {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function trimmedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

function leaseSeconds(value: unknown): number | null {
  if (value === undefined) return DEFAULT_LEASE_SECONDS;
  return Number.isInteger(value) && Number(value) >= 30 && Number(value) <= 900
    ? Number(value)
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
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= pageCount;
}

function validBox(value: unknown): boolean {
  return Array.isArray(value)
    && value.length === 4
    && value.every((coordinate) => typeof coordinate === 'number'
      && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)
    && value[2] >= value[0]
    && value[3] >= value[1];
}

function validConfidence(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= 1);
}

export function validateExtraction(value: unknown): value is JsonObject {
  if (!hasExactKeys(value, ['schema_version', 'document', 'blocks', 'tables', 'marks'])
      || value.schema_version !== '1'
      || !hasExactKeys(value.document, ['page_count', 'detected_languages', 'plain_text', 'partial'])
      || !Number.isInteger(value.document.page_count)
      || Number(value.document.page_count) < 1
      || Number(value.document.page_count) > 100
      || !Array.isArray(value.document.detected_languages)
      || !value.document.detected_languages.every((language) => typeof language === 'string')
      || typeof value.document.plain_text !== 'string'
      || !codePointLengthAtMost(value.document.plain_text, 2_000_000)
      || typeof value.document.partial !== 'boolean'
      || !Array.isArray(value.blocks)
      || !Array.isArray(value.tables)
      || !Array.isArray(value.marks)) {
    return false;
  }

  const pageCount = value.document.page_count as number;
  for (const block of value.blocks) {
    if (!hasExactKeys(block, ['id', 'page', 'type', 'bbox', 'text', 'confidence'])
        || typeof block.id !== 'string' || block.id.length === 0
        || !validPage(block.page, pageCount)
        || typeof block.type !== 'string' || !BLOCK_TYPES.has(block.type)
        || !validBox(block.bbox)
        || typeof block.text !== 'string'
        || !validConfidence(block.confidence)) {
      return false;
    }
  }

  let totalRows = 0;
  for (const table of value.tables) {
    if (!hasExactKeys(table, ['id', 'page', 'bbox', 'rows'])
        || typeof table.id !== 'string' || table.id.length === 0
        || !validPage(table.page, pageCount)
        || !validBox(table.bbox)
        || !Array.isArray(table.rows)
        || (totalRows += table.rows.length) > 5000) {
      return false;
    }
    for (const row of table.rows) {
      if (!Array.isArray(row)) return false;
      for (const cell of row) {
        if (!hasExactKeys(cell, ['text', 'bbox'])
            || typeof cell.text !== 'string'
            || !(cell.bbox === null || validBox(cell.bbox))) {
          return false;
        }
      }
    }
  }

  for (const mark of value.marks) {
    if (!hasExactKeys(mark, [
      'id', 'page', 'kind', 'bbox', 'nearby_block_ids', 'confidence', 'fingerprint',
    ])
        || typeof mark.id !== 'string' || mark.id.length === 0
        || !validPage(mark.page, pageCount)
        || typeof mark.kind !== 'string' || !MARK_KINDS.has(mark.kind)
        || !validBox(mark.bbox)
        || !Array.isArray(mark.nearby_block_ids)
        || !mark.nearby_block_ids.every((id) => typeof id === 'string')
        || !validConfidence(mark.confidence)
        || !(typeof mark.fingerprint === 'string' || mark.fingerprint === null)) {
      return false;
    }
  }

  return true;
}

export function validateActionRequest(value: unknown): ActionRequest {
  if (!isRecord(value) || typeof value.action !== 'string') {
    throw new RequestValidationError('invalid_request');
  }

  const leaseOwner = trimmedString(value.lease_owner, 200);
  if (value.action === 'claim') {
    const seconds = leaseSeconds(value.lease_seconds);
    if (!hasExactKeys(value, ['action', 'lease_owner'], ['lease_seconds']) || !leaseOwner || !seconds) {
      throw new RequestValidationError('invalid_request');
    }
    return { action: 'claim', lease_owner: leaseOwner, lease_seconds: seconds };
  }

  const jobId = typeof value.job_id === 'string' && UUID.test(value.job_id) ? value.job_id : null;
  if (value.action === 'heartbeat') {
    const seconds = leaseSeconds(value.lease_seconds);
    if (!hasExactKeys(value, ['action', 'job_id', 'lease_owner'], ['lease_seconds'])
        || !jobId || !leaseOwner || !seconds) {
      throw new RequestValidationError('invalid_request');
    }
    return { action: 'heartbeat', job_id: jobId, lease_owner: leaseOwner, lease_seconds: seconds };
  }

  if (value.action === 'complete') {
    if (!hasExactKeys(value, [
      'action', 'job_id', 'lease_owner', 'engine', 'model', 'model_version',
      'input_checksum', 'contract_version', 'payload',
    ], ['duration_ms', 'resource_metadata']) || !jobId || !leaseOwner) {
      throw new RequestValidationError('invalid_request');
    }
    const engine = trimmedString(value.engine, 100);
    const model = trimmedString(value.model, 200);
    const modelVersion = trimmedString(value.model_version, 200);
    const duration = value.duration_ms === undefined ? null : value.duration_ms;
    const metadata = value.resource_metadata === undefined ? {} : value.resource_metadata;
    if (!engine || !model || !modelVersion
        || typeof value.input_checksum !== 'string' || !CHECKSUM.test(value.input_checksum)
        || value.contract_version !== '1'
        || !(duration === null || (Number.isInteger(duration) && Number(duration) >= 0
          && Number(duration) <= 2_147_483_647))
        || !isRecord(metadata)) {
      throw new RequestValidationError('invalid_request');
    }
    if (!validateExtraction(value.payload)) throw new RequestValidationError('invalid_extraction');
    return {
      action: 'complete',
      job_id: jobId,
      lease_owner: leaseOwner,
      engine,
      model,
      model_version: modelVersion,
      input_checksum: value.input_checksum,
      contract_version: '1',
      payload: value.payload,
      duration_ms: duration as number | null,
      resource_metadata: metadata,
    };
  }

  if (value.action === 'fail') {
    if (!hasExactKeys(value, ['action', 'job_id', 'lease_owner', 'error_code'], ['error_message'])
        || !jobId || !leaseOwner) {
      throw new RequestValidationError('invalid_request');
    }
    const errorCode = trimmedString(value.error_code, 100);
    const errorMessage = value.error_message === undefined || value.error_message === null
      ? null
      : trimmedString(value.error_message, 1000);
    if (!errorCode || !ERROR_CODE.test(errorCode)
        || (value.error_message !== undefined && value.error_message !== null && !errorMessage)) {
      throw new RequestValidationError('invalid_request');
    }
    return {
      action: 'fail',
      job_id: jobId,
      lease_owner: leaseOwner,
      error_code: errorCode,
      error_message: errorMessage,
    };
  }

  throw new RequestValidationError('invalid_request');
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

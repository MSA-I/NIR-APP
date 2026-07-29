// document-processing — narrow private-worker gateway.
//
// Serve/deploy with `--no-verify-jwt`: the private worker has only SUPABASE_URL and
// OCR_WORKER_TOKEN. This handler validates that narrow token; service_role remains here.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';
import {
  jsonByteLength,
  MAX_EXTRACTION_BYTES,
  MAX_REQUEST_BYTES,
  MAX_RESOURCE_METADATA_BYTES,
  MAX_SMALL_REQUEST_BYTES,
  RequestValidationError,
  validateActionRequest,
  type ClaimRequest,
  type CompleteRequest,
  type FailRequest,
  type HeartbeatRequest,
} from './contract.ts';

const TOKEN_HEADER = 'x-ocr-worker-token';
const DOCUMENT_BUCKET = 'documents';
const DOWNLOAD_URL_TTL_SECONDS = 120;

type ErrorCode =
  | 'invalid_worker_token'
  | 'method_not_allowed'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'invalid_json'
  | 'invalid_request'
  | 'invalid_extraction'
  | 'job_not_found'
  | 'lease_lost'
  | 'source_changed'
  | 'source_unavailable'
  | 'org_unavailable'
  | 'download_unavailable'
  | 'service_unavailable';

const MESSAGE: Record<ErrorCode, string> = {
  invalid_worker_token: 'Worker authentication failed.',
  method_not_allowed: 'POST is required.',
  unsupported_media_type: 'Content-Type must be application/json.',
  payload_too_large: 'Request payload is too large.',
  invalid_json: 'Request body is not valid UTF-8 JSON.',
  invalid_request: 'Request does not match the action contract.',
  invalid_extraction: 'Extraction does not match contract version 1.',
  job_not_found: 'Processing job was not found.',
  lease_lost: 'Processing lease is no longer active.',
  source_changed: 'Source document changed during processing.',
  source_unavailable: 'Source document is no longer available.',
  org_unavailable: 'Organization is not available for processing.',
  download_unavailable: 'A download URL could not be created.',
  service_unavailable: 'Document processing service is unavailable.',
};

class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, status: number) {
    super(MESSAGE[code]);
    this.code = code;
    this.status = status;
  }
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function ok(data: unknown): Response {
  return json({ ok: true, data }, 200);
}

function fail(error: GatewayError): Response {
  const headers: Record<string, string> = error.code === 'method_not_allowed' ? { Allow: 'POST' } : {};
  return json({ ok: false, error: { code: error.code, message: error.message } }, error.status, headers);
}

async function constantTimeTokenMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [presentedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const left = new Uint8Array(presentedHash);
  const right = new Uint8Array(expectedHash);
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

async function readJsonBody(req: Request): Promise<{ value: unknown; byteLength: number }> {
  const declaredLength = req.headers.get('content-length');
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new GatewayError('invalid_request', 400);
    if (parsed > MAX_REQUEST_BYTES) throw new GatewayError('payload_too_large', 413);
  }

  if (!req.body) throw new GatewayError('invalid_json', 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new GatewayError('payload_too_large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { value: JSON.parse(text), byteLength };
  } catch {
    throw new GatewayError('invalid_json', 400);
  }
}

function rpcError(message: string): GatewayError {
  if (message.includes('document_processing_job_unknown')) return new GatewayError('job_not_found', 404);
  if (message.includes('document_processing_lease_lost')) return new GatewayError('lease_lost', 409);
  if (message.includes('document_processing_source_changed')) return new GatewayError('source_changed', 409);
  if (message.includes('document_extraction_invalid')) return new GatewayError('invalid_extraction', 400);
  if (message.includes('document_unknown') || message.includes('document_source_checksum_unavailable')) {
    return new GatewayError('source_unavailable', 409);
  }
  if (message.includes('org_suspended')) return new GatewayError('org_unavailable', 409);
  return new GatewayError('service_unavailable', 503);
}

type ClaimRow = {
  job_id: string;
  org_id: string;
  document_id: string;
  storage_path: string;
  mime_type: string;
  file_name: string;
  input_checksum: string;
  contract_version: string;
  lease_until: string;
  attempt_count: number;
};

function claimRow(value: unknown): value is ClaimRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ['job_id', 'org_id', 'document_id', 'storage_path', 'mime_type', 'file_name',
    'input_checksum', 'contract_version', 'lease_until'].every((key) => typeof row[key] === 'string')
    && Number.isInteger(row.attempt_count) && Number(row.attempt_count) >= 1;
}

async function claim(admin: SupabaseClient, request: ClaimRequest): Promise<Response> {
  const result = await admin.rpc('claim_document_processing_job', {
    p_lease_owner: request.lease_owner,
    p_lease_seconds: request.lease_seconds,
  });
  if (result.error) throw rpcError(result.error.message);
  if (result.data === null) return ok(null);
  if (!claimRow(result.data)
      || !result.data.storage_path.startsWith(`${result.data.org_id}/`)
      || result.data.contract_version !== '1') {
    throw new GatewayError('service_unavailable', 503);
  }

  const downloadExpiresIn = Math.min(DOWNLOAD_URL_TTL_SECONDS, request.lease_seconds);
  const signed = await admin.storage.from(DOCUMENT_BUCKET)
    .createSignedUrl(result.data.storage_path, downloadExpiresIn);
  if (signed.error || !signed.data?.signedUrl) throw new GatewayError('download_unavailable', 503);

  return ok({
    job_id: result.data.job_id,
    document_id: result.data.document_id,
    mime_type: result.data.mime_type,
    file_name: result.data.file_name,
    input_checksum: result.data.input_checksum,
    contract_version: result.data.contract_version,
    lease_until: result.data.lease_until,
    attempt_count: result.data.attempt_count,
    download_url: signed.data.signedUrl,
    download_expires_in: downloadExpiresIn,
  });
}

async function heartbeat(admin: SupabaseClient, request: HeartbeatRequest): Promise<Response> {
  const result = await admin.rpc('heartbeat_document_processing_job', {
    p_job_id: request.job_id,
    p_lease_owner: request.lease_owner,
    p_lease_seconds: request.lease_seconds,
  });
  if (result.error) throw rpcError(result.error.message);
  if (typeof result.data !== 'string') throw new GatewayError('service_unavailable', 503);
  return ok({ lease_until: result.data });
}

async function complete(admin: SupabaseClient, request: CompleteRequest): Promise<Response> {
  const result = await admin.rpc('complete_document_processing_job', {
    p_job_id: request.job_id,
    p_lease_owner: request.lease_owner,
    p_engine: request.engine,
    p_model: request.model,
    p_model_version: request.model_version,
    p_input_checksum: request.input_checksum,
    p_contract_version: request.contract_version,
    p_payload: request.payload,
    p_duration_ms: request.duration_ms,
    p_resource_metadata: request.resource_metadata,
  });
  if (result.error) throw rpcError(result.error.message);
  if (typeof result.data !== 'string') throw new GatewayError('service_unavailable', 503);
  return ok({ extraction_id: result.data });
}

async function markFailed(admin: SupabaseClient, request: FailRequest): Promise<Response> {
  const result = await admin.rpc('fail_document_processing_job', {
    p_job_id: request.job_id,
    p_lease_owner: request.lease_owner,
    p_error_code: request.error_code,
    p_error_message: request.error_message,
  });
  if (result.error) throw rpcError(result.error.message);
  if (typeof result.data !== 'string') throw new GatewayError('service_unavailable', 503);
  return ok({ job_id: result.data });
}

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    if (req.method !== 'POST') throw new GatewayError('method_not_allowed', 405);
    const contentType = req.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw new GatewayError('unsupported_media_type', 415);

    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const expectedToken = Deno.env.get('OCR_WORKER_TOKEN');
    if (!url || !serviceKey || !expectedToken || expectedToken.length < 32) {
      throw new GatewayError('service_unavailable', 503);
    }
    if (!await constantTimeTokenMatch(req.headers.get(TOKEN_HEADER) ?? '', expectedToken)) {
      throw new GatewayError('invalid_worker_token', 401);
    }

    const body = await readJsonBody(req);
    let request;
    try {
      request = validateActionRequest(body.value);
    } catch (error) {
      if (error instanceof RequestValidationError) throw new GatewayError(error.code, 400);
      throw error;
    }
    if (request.action !== 'complete' && body.byteLength > MAX_SMALL_REQUEST_BYTES) {
      throw new GatewayError('payload_too_large', 413);
    }
    if (request.action === 'complete') {
      if (jsonByteLength(request.payload) > MAX_EXTRACTION_BYTES
          || jsonByteLength(request.resource_metadata) > MAX_RESOURCE_METADATA_BYTES) {
        throw new GatewayError('payload_too_large', 413);
      }
    }

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    if (request.action === 'claim') return await claim(admin, request);
    if (request.action === 'heartbeat') return await heartbeat(admin, request);
    if (request.action === 'complete') return await complete(admin, request);
    return await markFailed(admin, request);
  } catch (error) {
    const safe = error instanceof GatewayError
      ? error
      : new GatewayError('service_unavailable', 503);
    console.error('document-processing failed:', safe.code);
    return fail(safe);
  }
});

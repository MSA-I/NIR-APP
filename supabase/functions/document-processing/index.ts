// document-processing — narrow private-worker gateway.
//
// Serve/deploy with `--no-verify-jwt`: the private worker has only SUPABASE_URL and
// OCR_WORKER_TOKEN. This handler validates that narrow token; service_role remains here.

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.91.1";
import {
  type AcknowledgeDownloadRequest,
  type ClaimRequest,
  type CompleteRequest,
  type FailRequest,
  GATEWAY_CONTRACT_HEADER,
  GATEWAY_CONTRACT_VERSION,
  gatewayContractMatches,
  type HeartbeatRequest,
  jsonByteLength,
  MAX_EXTRACTION_BYTES,
  MAX_REQUEST_BYTES,
  MAX_RESOURCE_METADATA_BYTES,
  MAX_SMALL_REQUEST_BYTES,
  RequestValidationError,
  validateActionRequest,
} from "./contract.ts";
import {
  releaseOrganizationEgress,
  reserveOrganizationEgress,
  type ServiceRpc,
  type ServiceRpcResult,
} from "../_shared/organization-egress.ts";

const TOKEN_HEADER = "x-ocr-worker-token";
const DOWNLOAD_URL_TTL_SECONDS = 120;
const STORAGE_CONTROL_TIMEOUT_MS = 10_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ErrorCode =
  | "invalid_worker_token"
  | "gateway_contract_mismatch"
  | "method_not_allowed"
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_request"
  | "invalid_extraction"
  | "job_not_found"
  | "lease_lost"
  | "source_changed"
  | "source_unavailable"
  | "org_unavailable"
  | "download_unavailable"
  | "service_unavailable";

const MESSAGE: Record<ErrorCode, string> = {
  invalid_worker_token: "Worker authentication failed.",
  gateway_contract_mismatch: "Worker and gateway contracts do not match.",
  method_not_allowed: "POST is required.",
  unsupported_media_type: "Content-Type must be application/json.",
  payload_too_large: "Request payload is too large.",
  invalid_json: "Request body is not valid UTF-8 JSON.",
  invalid_request: "Request does not match the action contract.",
  invalid_extraction: "Extraction does not match contract version 1.",
  job_not_found: "Processing job was not found.",
  lease_lost: "Processing lease is no longer active.",
  source_changed: "Source document changed during processing.",
  source_unavailable: "Source document is no longer available.",
  org_unavailable: "Organization is not available for processing.",
  download_unavailable: "A download URL could not be created.",
  service_unavailable: "Document processing service is unavailable.",
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

function json(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      [GATEWAY_CONTRACT_HEADER]: GATEWAY_CONTRACT_VERSION,
      ...extraHeaders,
    },
  });
}

function ok(data: unknown): Response {
  return json({ ok: true, data }, 200);
}

function fail(error: GatewayError): Response {
  const headers: Record<string, string> = error.code === "method_not_allowed"
    ? { Allow: "POST" }
    : {};
  return json(
    { ok: false, error: { code: error.code, message: error.message } },
    error.status,
    headers,
  );
}

async function constantTimeTokenMatch(
  presented: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [presentedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(presentedHash);
  const right = new Uint8Array(expectedHash);
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

async function readJsonBody(
  req: Request,
): Promise<{ value: unknown; byteLength: number }> {
  const declaredLength = req.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new GatewayError("invalid_request", 400);
    }
    if (parsed > MAX_REQUEST_BYTES) {
      throw new GatewayError("payload_too_large", 413);
    }
  }

  if (!req.body) throw new GatewayError("invalid_json", 400);
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
        throw new GatewayError("payload_too_large", 413);
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
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { value: JSON.parse(text), byteLength };
  } catch {
    throw new GatewayError("invalid_json", 400);
  }
}

function rpcError(message: string): GatewayError {
  if (message.includes("document_processing_job_unknown")) {
    return new GatewayError("job_not_found", 404);
  }
  if (
    message.includes("document_processing_lease_lost") ||
    message.includes("document_processing_egress_lease_lost") ||
    message.includes("document_processing_download_not_acknowledged") ||
    message.includes("document_extraction_recovery_attempt_invalid")
  ) {
    return new GatewayError("lease_lost", 409);
  }
  if (message.includes("document_processing_source_changed")) {
    return new GatewayError("source_changed", 409);
  }
  if (
    message.includes("document_extraction_invalid") ||
    message.includes("document_ocr_evidence_invalid")
  ) {
    return new GatewayError("invalid_extraction", 400);
  }
  if (
    message.includes("document_unknown") ||
    message.includes("document_source_checksum_unavailable")
  ) {
    return new GatewayError("source_unavailable", 409);
  }
  if (
    message.includes("org_suspended") ||
    message.includes("organization_read_only")
  ) {
    return new GatewayError("org_unavailable", 409);
  }
  return new GatewayError("service_unavailable", 503);
}

function serviceRpc(admin: SupabaseClient): ServiceRpc {
  return (name, args) =>
    admin.rpc(name, args) as unknown as PromiseLike<ServiceRpcResult>;
}

type ClaimRow = {
  job_id: string;
  processing_attempt_id: string;
  processing_attempt_started_at: string;
  org_id: string;
  document_id: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  file_name: string;
  input_checksum: string;
  contract_version: string;
  lease_until: string;
  attempt_count: number;
};

function claimRow(value: unknown): value is ClaimRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return [
    "job_id",
    "org_id",
    "document_id",
    "storage_bucket",
    "storage_path",
    "mime_type",
    "file_name",
    "input_checksum",
    "contract_version",
    "lease_until",
    "processing_attempt_id",
    "processing_attempt_started_at",
  ].every((key) => typeof row[key] === "string") &&
    UUID.test(String(row.processing_attempt_id)) &&
    !Number.isNaN(Date.parse(String(row.processing_attempt_started_at))) &&
    Number.isInteger(row.attempt_count) && Number(row.attempt_count) >= 1;
}

function exactRecord(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

async function claim(
  admin: SupabaseClient,
  storageAdmin: SupabaseClient,
  request: ClaimRequest,
): Promise<Response> {
  const result = await admin.rpc("claim_document_processing_job_input", {
    p_lease_owner: request.lease_owner,
    p_lease_seconds: request.lease_seconds,
  });
  if (result.error) throw rpcError(result.error.message);
  if (result.data === null) return ok(null);
  if (
    !claimRow(result.data) ||
    !["documents", "document-scans"].includes(result.data.storage_bucket) ||
    !result.data.storage_path.startsWith(`${result.data.org_id}/`) ||
    result.data.contract_version !== "1"
  ) {
    throw new GatewayError("service_unavailable", 503);
  }

  const rpc = serviceRpc(admin);
  const downloadExpiresIn = Math.min(
    DOWNLOAD_URL_TTL_SECONDS,
    request.lease_seconds,
  );
  const reservation = await reserveOrganizationEgress(rpc, {
    orgId: result.data.org_id,
    kind: "document_signed_url",
    // Every claimed processing attempt has its own database identity. An expired or ambiguous
    // bearer URL can never be re-armed, while an explicitly failed retryable attempt can settle
    // and return the job to the queue under a fresh processing_attempt_id.
    correlationId: result.data.processing_attempt_id,
    ttlSeconds: downloadExpiresIn,
  });
  if (!reservation.lease) throw new GatewayError("org_unavailable", 409);
  if (reservation.lease.idempotent) {
    throw new GatewayError("download_unavailable", 409);
  }
  const downloadLease = reservation.lease;
  const signed = await storageAdmin.storage.from(result.data.storage_bucket)
    .createSignedUrl(result.data.storage_path, downloadExpiresIn);
  if (signed.error || !signed.data?.signedUrl) {
    await releaseOrganizationEgress(rpc, downloadLease, {
      outcome: "failed",
      evidenceCode: "signed_url_failed",
      evidence: { job_id: result.data.job_id },
    });
    throw new GatewayError("download_unavailable", 503);
  }

  return ok({
    job_id: result.data.job_id,
    processing_attempt_id: result.data.processing_attempt_id,
    processing_attempt_started_at: result.data.processing_attempt_started_at,
    document_id: result.data.document_id,
    mime_type: result.data.mime_type,
    file_name: result.data.file_name,
    input_checksum: result.data.input_checksum,
    contract_version: result.data.contract_version,
    lease_until: result.data.lease_until,
    attempt_count: result.data.attempt_count,
    download_url: signed.data.signedUrl,
    download_expires_in: downloadExpiresIn,
    download_lease_id: downloadLease.lease_id,
    download_lease_token: downloadLease.lease_token,
  });
}

async function acknowledgeDownload(
  admin: SupabaseClient,
  request: AcknowledgeDownloadRequest,
): Promise<Response> {
  const result = await admin.rpc(
    "service_acknowledge_document_processing_download",
    {
      p_job_id: request.job_id,
      p_lease_owner: request.lease_owner,
      p_egress_lease_id: request.download_lease_id,
      p_egress_lease_token: request.download_lease_token,
      p_lease_seconds: request.lease_seconds,
    },
  );
  if (result.error) throw rpcError(result.error.message);
  const keys = [
    "job_id",
    "org_id",
    "processing_attempt_id",
    "egress_lease_id",
    "acknowledged_at",
    "job_lease_until",
    "egress_expires_at",
    "idempotent",
  ];
  if (
    !exactRecord(result.data, keys) ||
    result.data.job_id !== request.job_id ||
    result.data.egress_lease_id !== request.download_lease_id ||
    !UUID.test(String(result.data.org_id)) ||
    !UUID.test(String(result.data.processing_attempt_id)) ||
    ![
      result.data.acknowledged_at,
      result.data.job_lease_until,
      result.data.egress_expires_at,
    ]
      .every((value) =>
        typeof value === "string" && !Number.isNaN(Date.parse(value))
      ) ||
    typeof result.data.idempotent !== "boolean"
  ) {
    throw new GatewayError("service_unavailable", 503);
  }
  return ok(result.data);
}

async function heartbeat(
  admin: SupabaseClient,
  request: HeartbeatRequest,
): Promise<Response> {
  const result = await admin.rpc("heartbeat_document_processing_job", {
    p_job_id: request.job_id,
    p_lease_owner: request.lease_owner,
    p_egress_lease_id: request.download_lease_id,
    p_egress_lease_token: request.download_lease_token,
    p_lease_seconds: request.lease_seconds,
  });
  if (result.error) throw rpcError(result.error.message);
  const keys = [
    "job_id",
    "processing_attempt_id",
    "egress_lease_id",
    "acknowledged_at",
    "job_lease_until",
    "egress_expires_at",
  ];
  if (
    !exactRecord(result.data, keys) ||
    result.data.job_id !== request.job_id ||
    result.data.egress_lease_id !== request.download_lease_id ||
    !UUID.test(String(result.data.processing_attempt_id)) ||
    ![
      result.data.acknowledged_at,
      result.data.job_lease_until,
      result.data.egress_expires_at,
    ]
      .every((value) =>
        typeof value === "string" && !Number.isNaN(Date.parse(value))
      )
  ) {
    throw new GatewayError("service_unavailable", 503);
  }
  // Page progress rides the heartbeat the worker already sends rather than a second call, and the
  // attempt it belongs to comes from the heartbeat's own answer -- the worker never has to name it,
  // so it cannot name the wrong one. Deliberately after the lease renewal and deliberately unable
  // to fail it: the lease keeps a document alive, progress only describes it, and losing a status
  // line must never cost a job that is working.
  if (request.progress_done !== null && request.progress_total !== null) {
    const progress = await admin.rpc(
      "service_record_document_processing_progress",
      {
        p_job_id: request.job_id,
        p_lease_owner: request.lease_owner,
        p_processing_attempt_id: result.data.processing_attempt_id,
        p_done: request.progress_done,
        p_total: request.progress_total,
      },
    );
    if (progress.error) {
      console.error(
        JSON.stringify({
          event: "document_processing_progress_rejected",
          job_id: request.job_id,
        }),
      );
    }
  }
  return ok(result.data);
}

async function complete(
  admin: SupabaseClient,
  request: CompleteRequest,
): Promise<Response> {
  // The provider result crosses the immutable evidence boundary in its own transaction. A crash,
  // timeout or lifecycle flip after this RPC can delay business persistence, but can never erase
  // the OCR result or authorize a second provider run for the same processing attempt.
  const recorded = await admin.rpc("service_record_document_ocr_evidence", {
    p_job_id: request.job_id,
    p_processing_attempt_id: request.processing_attempt_id,
    p_lease_owner: request.lease_owner,
    p_egress_lease_id: request.download_lease_id,
    p_egress_lease_token: request.download_lease_token,
    p_engine: request.engine,
    p_model: request.model,
    p_model_version: request.model_version,
    p_input_checksum: request.input_checksum,
    p_contract_version: request.contract_version,
    p_payload: request.payload,
    p_duration_ms: request.duration_ms,
    p_resource_metadata: request.resource_metadata,
  });
  if (recorded.error) throw rpcError(recorded.error.message);
  const recordedKeys = [
    "job_id",
    "org_id",
    "processing_attempt_id",
    "egress_lease_id",
    "evidence_sha256",
    "payload_sha256",
    "lease_outcome",
    "idempotent",
  ];
  if (
    !exactRecord(recorded.data, recordedKeys) ||
    recorded.data.job_id !== request.job_id ||
    recorded.data.processing_attempt_id !== request.processing_attempt_id ||
    recorded.data.egress_lease_id !== request.download_lease_id ||
    !UUID.test(String(recorded.data.org_id)) ||
    typeof recorded.data.evidence_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(recorded.data.evidence_sha256) ||
    typeof recorded.data.payload_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(recorded.data.payload_sha256) ||
    recorded.data.lease_outcome !== "delivered" ||
    typeof recorded.data.idempotent !== "boolean"
  ) {
    throw new GatewayError("service_unavailable", 503);
  }

  const result = await admin.rpc("complete_document_processing_job", {
    p_job_id: request.job_id,
    p_processing_attempt_id: request.processing_attempt_id,
    p_lease_owner: request.lease_owner,
    p_egress_lease_id: request.download_lease_id,
    p_egress_lease_token: request.download_lease_token,
    p_evidence_sha256: recorded.data.evidence_sha256,
  });
  if (result.error) throw rpcError(result.error.message);
  const keys = [
    "job_id",
    "processing_attempt_id",
    "egress_lease_id",
    "extraction_id",
    "evidence_sha256",
    "payload_sha256",
    "business_applied",
    "access_mode",
    "idempotent",
  ];
  if (
    !exactRecord(result.data, keys) ||
    result.data.job_id !== request.job_id ||
    result.data.processing_attempt_id !== request.processing_attempt_id ||
    result.data.egress_lease_id !== request.download_lease_id ||
    !UUID.test(String(result.data.processing_attempt_id)) ||
    !(result.data.extraction_id === null ||
      UUID.test(String(result.data.extraction_id))) ||
    typeof result.data.evidence_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(result.data.evidence_sha256) ||
    result.data.evidence_sha256 !== recorded.data.evidence_sha256 ||
    typeof result.data.payload_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(result.data.payload_sha256) ||
    result.data.payload_sha256 !== recorded.data.payload_sha256 ||
    typeof result.data.business_applied !== "boolean" ||
    typeof result.data.access_mode !== "string" ||
    typeof result.data.idempotent !== "boolean" ||
    (result.data.business_applied && result.data.extraction_id === null) ||
    (!result.data.business_applied && result.data.extraction_id !== null)
  ) {
    throw new GatewayError("service_unavailable", 503);
  }
  if (
    !result.data.business_applied &&
    String(result.data.access_mode) === "active"
  ) {
    const recovered = await admin.rpc(
      "service_recover_document_extraction_from_egress",
      {
        p_job_id: request.job_id,
        p_processing_attempt_id: request.processing_attempt_id,
        p_evidence_lease_id: request.download_lease_id,
        p_evidence_sha256: recorded.data.evidence_sha256,
      },
    );
    if (recovered.error) throw rpcError(recovered.error.message);
    const recoveryKeys = [
      "job_id",
      "processing_attempt_id",
      "evidence_lease_id",
      "extraction_id",
      "evidence_sha256",
      "payload_sha256",
      "access_mode",
      "idempotent",
      "recovered_from_failed",
    ];
    if (
      !exactRecord(recovered.data, recoveryKeys) ||
      recovered.data.job_id !== request.job_id ||
      recovered.data.processing_attempt_id !== request.processing_attempt_id ||
      recovered.data.evidence_lease_id !== request.download_lease_id ||
      !UUID.test(String(recovered.data.extraction_id)) ||
      recovered.data.evidence_sha256 !== recorded.data.evidence_sha256 ||
      recovered.data.payload_sha256 !== recorded.data.payload_sha256 ||
      typeof recovered.data.access_mode !== "string" ||
      typeof recovered.data.idempotent !== "boolean" ||
      typeof recovered.data.recovered_from_failed !== "boolean"
    ) {
      throw new GatewayError("service_unavailable", 503);
    }
    return ok({
      job_id: recovered.data.job_id,
      processing_attempt_id: recovered.data.processing_attempt_id,
      egress_lease_id: recovered.data.evidence_lease_id,
      extraction_id: recovered.data.extraction_id,
      evidence_sha256: recovered.data.evidence_sha256,
      payload_sha256: recovered.data.payload_sha256,
      business_applied: true,
      access_mode: recovered.data.access_mode,
      idempotent: recovered.data.idempotent,
    });
  }
  return ok(result.data);
}

async function markFailed(
  admin: SupabaseClient,
  request: FailRequest,
): Promise<Response> {
  const result = await admin.rpc("fail_document_processing_job", {
    p_job_id: request.job_id,
    p_lease_owner: request.lease_owner,
    p_egress_lease_id: request.download_lease_id,
    p_egress_lease_token: request.download_lease_token,
    p_error_code: request.error_code,
    p_error_message: request.error_message,
    p_retryable: request.retryable,
  });
  if (result.error) throw rpcError(result.error.message);
  const keys = [
    "job_id",
    "processing_attempt_id",
    "egress_lease_id",
    "evidence_sha256",
    "job_status",
    "retryable",
    "business_applied",
    "access_mode",
    "idempotent",
  ];
  if (
    !exactRecord(result.data, keys) ||
    result.data.job_id !== request.job_id ||
    result.data.egress_lease_id !== request.download_lease_id ||
    !UUID.test(String(result.data.processing_attempt_id)) ||
    typeof result.data.evidence_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(result.data.evidence_sha256) ||
    typeof result.data.job_status !== "string" ||
    result.data.retryable !== request.retryable ||
    typeof result.data.business_applied !== "boolean" ||
    typeof result.data.access_mode !== "string" ||
    typeof result.data.idempotent !== "boolean"
  ) {
    throw new GatewayError("service_unavailable", 503);
  }
  return ok(result.data);
}

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    if (req.method !== "POST") {
      throw new GatewayError("method_not_allowed", 405);
    }
    const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new GatewayError("unsupported_media_type", 415);
    }

    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const expectedToken = Deno.env.get("OCR_WORKER_TOKEN");
    if (!url || !serviceKey || !expectedToken || expectedToken.length < 32) {
      throw new GatewayError("service_unavailable", 503);
    }
    if (
      !await constantTimeTokenMatch(
        req.headers.get(TOKEN_HEADER) ?? "",
        expectedToken,
      )
    ) {
      throw new GatewayError("invalid_worker_token", 401);
    }
    // This check deliberately precedes body parsing, client construction and every RPC. A stale
    // worker is rejected without claiming a job or incrementing its authoritative attempt count.
    // The worker shipped first: the previous Edge version ignored this additive request header.
    if (!gatewayContractMatches(req.headers)) {
      throw new GatewayError("gateway_contract_mismatch", 409);
    }

    const body = await readJsonBody(req);
    let request;
    try {
      request = validateActionRequest(body.value);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        throw new GatewayError(error.code, 400);
      }
      throw error;
    }
    if (
      request.action !== "complete" && body.byteLength > MAX_SMALL_REQUEST_BYTES
    ) {
      throw new GatewayError("payload_too_large", 413);
    }
    if (request.action === "complete") {
      if (
        jsonByteLength(request.payload) > MAX_EXTRACTION_BYTES ||
        jsonByteLength(request.resource_metadata) > MAX_RESOURCE_METADATA_BYTES
      ) {
        throw new GatewayError("payload_too_large", 413);
      }
    }

    const admin = createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    const storageAdmin = createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.timeout(STORAGE_CONTROL_TIMEOUT_MS),
          }),
      },
    });
    if (request.action === "claim") {
      return await claim(admin, storageAdmin, request);
    }
    if (request.action === "heartbeat") return await heartbeat(admin, request);
    if (request.action === "ack_download") {
      return await acknowledgeDownload(admin, request);
    }
    if (request.action === "complete") return await complete(admin, request);
    return await markFailed(admin, request);
  } catch (error) {
    const safe = error instanceof GatewayError
      ? error
      : new GatewayError("service_unavailable", 503);
    console.error("document-processing failed:", safe.code);
    return fail(safe);
  }
});

// document-preprocessing — private image-scanner gateway. Browser clients never receive
// service_role access and the scanner receives only SUPABASE_URL plus OCR_WORKER_TOKEN.

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.91.1";
import {
  MAX_SCAN_REQUEST_BYTES,
  MAX_SCAN_SMALL_REQUEST_BYTES,
  SCAN_GATEWAY_CONTRACT_HEADER,
  SCAN_GATEWAY_CONTRACT_VERSION,
  scanGatewayContractMatches,
  type ScanAcknowledgeDownloadRequest,
  type ScanActionRequest,
  type ScanClaimRequest,
  type ScanCompleteRequest,
  type ScanFailRequest,
  type ScanHeartbeatRequest,
  ScanRequestValidationError,
  validateScanActionRequest,
} from "./contract.ts";
import {
  releaseOrganizationEgress,
  reserveOrganizationEgress,
  type ServiceRpc,
  type ServiceRpcResult,
} from "../_shared/organization-egress.ts";

const TOKEN_HEADER = "x-ocr-worker-token";
const SOURCE_BUCKET = "documents";
const OUTPUT_BUCKET = "document-scans";
const DOWNLOAD_TTL_SECONDS = 120;
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
  | "job_not_found"
  | "lease_lost"
  | "source_changed"
  | "source_unavailable"
  | "org_unavailable"
  | "download_unavailable"
  | "output_invalid"
  | "output_unavailable"
  | "service_unavailable";

const MESSAGE: Record<ErrorCode, string> = {
  invalid_worker_token: "Worker authentication failed.",
  gateway_contract_mismatch: "Worker and scan gateway contracts do not match.",
  method_not_allowed: "POST is required.",
  unsupported_media_type: "Content-Type must be application/json.",
  payload_too_large: "Request payload is too large.",
  invalid_json: "Request body is not valid UTF-8 JSON.",
  invalid_request: "Request does not match the scan action contract.",
  job_not_found: "Document scan job was not found.",
  lease_lost: "Document scan lease is no longer active.",
  source_changed: "Source document changed during scanning.",
  source_unavailable: "Source document is no longer available.",
  org_unavailable: "Organization is not available for scanning.",
  download_unavailable: "A scan source URL could not be created.",
  output_invalid: "Scanned output failed integrity validation.",
  output_unavailable: "Scanned output could not be stored.",
  service_unavailable: "Document scanning service is unavailable.",
};

class GatewayError extends Error {
  constructor(readonly code: ErrorCode, readonly status: number) {
    super(MESSAGE[code]);
  }
}

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      [SCAN_GATEWAY_CONTRACT_HEADER]: SCAN_GATEWAY_CONTRACT_VERSION,
    },
  });
}

function ok(data: unknown): Response {
  return response({ ok: true, data }, 200);
}

function fail(error: GatewayError): Response {
  return response({
    ok: false,
    error: { code: error.code, message: error.message },
  }, error.status);
}

async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftBuffer, rightBuffer] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(leftBuffer);
  const right = new Uint8Array(rightBuffer);
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

async function readBody(req: Request): Promise<{ value: unknown; bytes: number }> {
  const declared = req.headers.get("content-length");
  if (declared !== null &&
    (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 ||
      Number(declared) > MAX_SCAN_REQUEST_BYTES)) {
    throw new GatewayError("payload_too_large", 413);
  }
  if (!req.body) throw new GatewayError("invalid_json", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_SCAN_REQUEST_BYTES) {
        await reader.cancel();
        throw new GatewayError("payload_too_large", 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)),
      bytes,
    };
  } catch {
    throw new GatewayError("invalid_json", 400);
  }
}

function rpcError(message: string): GatewayError {
  if (message.includes("document_scan_job_unknown")) return new GatewayError("job_not_found", 404);
  if (message.includes("document_scan_lease_lost") ||
    message.includes("document_scan_egress_lease_lost") ||
    message.includes("document_scan_attempt_lost")) return new GatewayError("lease_lost", 409);
  if (message.includes("document_scan_source_changed")) return new GatewayError("source_changed", 409);
  if (message.includes("document_unknown")) return new GatewayError("source_unavailable", 409);
  if (message.includes("org_suspended") || message.includes("organization_read_only") ||
    message.includes("organization_external_egress_not_allowed")) {
    return new GatewayError("org_unavailable", 409);
  }
  if (message.includes("document_scan_output_invalid") ||
    message.includes("document_scan_object_invalid") ||
    message.includes("document_scan_output_conflict")) {
    return new GatewayError("output_invalid", 409);
  }
  return new GatewayError("service_unavailable", 503);
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function serviceRpc(admin: SupabaseClient): ServiceRpc {
  return (name, args) =>
    admin.rpc(name, args) as unknown as PromiseLike<ServiceRpcResult>;
}

async function claim(
  admin: SupabaseClient,
  storage: SupabaseClient,
  request: ScanClaimRequest,
): Promise<Response> {
  const result = await admin.rpc("claim_document_scan_job", {
    p_lease_owner: request.lease_owner,
    p_lease_seconds: request.lease_seconds,
  });
  if (result.error) throw rpcError(result.error.message);
  if (result.data === null) return ok(null);
  const keys = [
    "job_id", "document_id", "org_id", "storage_path", "mime_type", "file_name",
    "input_checksum", "requested_mode", "manual_corners", "lease_until", "attempt_count",
    "processing_attempt_id", "processing_attempt_started_at",
  ];
  if (!exact(result.data, keys) || !UUID.test(String(result.data.job_id)) ||
    !UUID.test(String(result.data.document_id)) || !UUID.test(String(result.data.org_id)) ||
    typeof result.data.storage_path !== "string" ||
    !result.data.storage_path.startsWith(`${result.data.org_id}/`) ||
    !String(result.data.mime_type).startsWith("image/") ||
    !UUID.test(String(result.data.processing_attempt_id)) ||
    !Number.isFinite(Date.parse(String(result.data.processing_attempt_started_at))) ||
    !["auto", "grayscale", "black_and_white"].includes(String(result.data.requested_mode)) ||
    !Number.isInteger(result.data.attempt_count)) {
    throw new GatewayError("service_unavailable", 503);
  }
  const ttl = Math.min(DOWNLOAD_TTL_SECONDS, request.lease_seconds);
  const rpc = serviceRpc(admin);
  const reservation = await reserveOrganizationEgress(rpc, {
    orgId: String(result.data.org_id),
    kind: "document_signed_url",
    correlationId: String(result.data.processing_attempt_id),
    ttlSeconds: ttl,
  });
  if (!reservation.lease) throw new GatewayError("org_unavailable", 409);
  if (reservation.lease.idempotent) throw new GatewayError("download_unavailable", 409);
  const downloadLease = reservation.lease;
  const signed = await storage.storage.from(SOURCE_BUCKET)
    .createSignedUrl(String(result.data.storage_path), ttl);
  if (signed.error || !signed.data?.signedUrl) {
    await releaseOrganizationEgress(rpc, downloadLease, {
      outcome: "failed",
      evidenceCode: "scan_signed_url_failed",
      evidence: { job_id: result.data.job_id },
    });
    throw new GatewayError("download_unavailable", 503);
  }
  return ok({
    ...result.data,
    download_url: signed.data.signedUrl,
    download_expires_in: ttl,
    download_lease_id: downloadLease.lease_id,
    download_lease_token: downloadLease.lease_token,
  });
}

async function acknowledgeDownload(
  admin: SupabaseClient,
  request: ScanAcknowledgeDownloadRequest,
): Promise<Response> {
  const result = await admin.rpc("service_acknowledge_document_scan_download", {
    p_job_id: request.job_id,
    p_lease_owner: request.lease_owner,
    p_egress_lease_id: request.download_lease_id,
    p_egress_lease_token: request.download_lease_token,
    p_lease_seconds: request.lease_seconds,
  });
  if (result.error) throw rpcError(result.error.message);
  const keys = [
    "job_id", "org_id", "processing_attempt_id", "egress_lease_id",
    "acknowledged_at", "job_lease_until", "egress_expires_at", "idempotent",
  ];
  if (!exact(result.data, keys) || result.data.job_id !== request.job_id ||
    result.data.egress_lease_id !== request.download_lease_id ||
    typeof result.data.acknowledged_at !== "string" ||
    typeof result.data.job_lease_until !== "string" ||
    typeof result.data.egress_expires_at !== "string" ||
    typeof result.data.idempotent !== "boolean") {
    throw new GatewayError("service_unavailable", 503);
  }
  return ok(result.data);
}

async function heartbeat(admin: SupabaseClient, request: ScanHeartbeatRequest): Promise<Response> {
  const result = await admin.rpc("heartbeat_document_scan_job", {
    p_job_id: request.job_id,
    p_lease_owner: request.lease_owner,
    p_egress_lease_id: request.download_lease_id,
    p_egress_lease_token: request.download_lease_token,
    p_lease_seconds: request.lease_seconds,
  });
  if (result.error) throw rpcError(result.error.message);
  const keys = [
    "job_id", "processing_attempt_id", "egress_lease_id", "acknowledged_at",
    "job_lease_until", "egress_expires_at",
  ];
  if (!exact(result.data, keys) || result.data.job_id !== request.job_id ||
    result.data.egress_lease_id !== request.download_lease_id ||
    typeof result.data.acknowledged_at !== "string" ||
    typeof result.data.job_lease_until !== "string" ||
    typeof result.data.egress_expires_at !== "string") {
    throw new GatewayError("service_unavailable", 503);
  }
  return ok(result.data);
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new GatewayError("output_invalid", 400);
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = Uint8Array.from(bytes).buffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function complete(
  admin: SupabaseClient,
  storage: SupabaseClient,
  request: ScanCompleteRequest,
): Promise<Response> {
  const bytes = decodeBase64(request.output_base64);
  if (bytes.byteLength !== request.metadata.output_bytes ||
    await sha256(bytes) !== request.metadata.output_sha256 ||
    bytes.byteLength < 8 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    throw new GatewayError("output_invalid", 400);
  }
  const job = await admin.from("document_scan_jobs")
    .select("org_id,document_id")
    .eq("id", request.job_id)
    .maybeSingle();
  if (job.error || !job.data) throw new GatewayError("job_not_found", 404);
  const path = `${job.data.org_id}/${job.data.document_id}/${request.job_id}/scan.png`;
  let created = false;
  const upload = await storage.storage.from(OUTPUT_BUCKET).upload(path, bytes, {
    contentType: "image/png",
    cacheControl: "31536000",
    upsert: false,
  });
  if (!upload.error) {
    created = true;
  } else {
    const existing = await storage.storage.from(OUTPUT_BUCKET).download(path);
    if (existing.error || await sha256(new Uint8Array(await existing.data.arrayBuffer())) !==
      request.metadata.output_sha256) throw new GatewayError("output_unavailable", 503);
  }
  const result = await admin.rpc("service_complete_document_scan_job_v2", {
    p_job_id: request.job_id,
    p_processing_attempt_id: request.processing_attempt_id,
    p_lease_owner: request.lease_owner,
    p_egress_lease_id: request.download_lease_id,
    p_egress_lease_token: request.download_lease_token,
    p_input_checksum: request.input_checksum,
    p_storage_path: path,
    p_sha256: request.metadata.output_sha256,
    p_byte_size: request.metadata.output_bytes,
    p_width: request.metadata.width,
    p_height: request.metadata.height,
    p_output_mode: request.metadata.output_mode,
    p_corners: request.metadata.corners,
    p_corners_source: request.metadata.corners_source,
    p_rotation_degrees: request.metadata.rotation_degrees,
    p_metrics: request.metadata.metrics,
    p_provenance: request.metadata.provenance,
  });
  if (result.error) {
    if (created) await storage.storage.from(OUTPUT_BUCKET).remove([path]);
    throw rpcError(result.error.message);
  }
  const resultKeys = [
    "job_id", "output_id", "processing_attempt_id", "egress_lease_id",
    "evidence_sha256", "status", "idempotent",
  ];
  if (!exact(result.data, resultKeys) ||
    result.data.job_id !== request.job_id || !UUID.test(String(result.data.output_id)) ||
    result.data.processing_attempt_id !== request.processing_attempt_id ||
    result.data.egress_lease_id !== request.download_lease_id ||
    !/^[0-9a-f]{64}$/.test(String(result.data.evidence_sha256)) ||
    !["ready", "accepted"].includes(String(result.data.status)) ||
    typeof result.data.idempotent !== "boolean") {
    throw new GatewayError("service_unavailable", 503);
  }
  return ok(result.data);
}

async function markFailed(admin: SupabaseClient, request: ScanFailRequest): Promise<Response> {
  const result = await admin.rpc("fail_document_scan_job", {
    p_job_id: request.job_id,
    p_processing_attempt_id: request.processing_attempt_id,
    p_lease_owner: request.lease_owner,
    p_egress_lease_id: request.download_lease_id,
    p_egress_lease_token: request.download_lease_token,
    p_error_code: request.error_code,
    p_error_message: request.error_message,
    p_retryable: request.retryable,
  });
  if (result.error) throw rpcError(result.error.message);
  const resultKeys = [
    "job_id", "processing_attempt_id", "egress_lease_id", "evidence_sha256",
    "status", "retryable", "idempotent",
  ];
  if (!exact(result.data, resultKeys) ||
    result.data.job_id !== request.job_id || typeof result.data.status !== "string" ||
    result.data.processing_attempt_id !== request.processing_attempt_id ||
    result.data.egress_lease_id !== request.download_lease_id ||
    !/^[0-9a-f]{64}$/.test(String(result.data.evidence_sha256)) ||
    typeof result.data.retryable !== "boolean" || typeof result.data.idempotent !== "boolean") {
    throw new GatewayError("service_unavailable", 503);
  }
  return ok(result.data);
}

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    if (req.method !== "POST") throw new GatewayError("method_not_allowed", 405);
    if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json") throw new GatewayError("unsupported_media_type", 415);
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const expectedToken = Deno.env.get("OCR_WORKER_TOKEN");
    if (!url || !serviceKey || !expectedToken || expectedToken.length < 32) {
      throw new GatewayError("service_unavailable", 503);
    }
    if (!await tokenMatches(req.headers.get(TOKEN_HEADER) ?? "", expectedToken)) {
      throw new GatewayError("invalid_worker_token", 401);
    }
    if (!scanGatewayContractMatches(req.headers)) {
      throw new GatewayError("gateway_contract_mismatch", 409);
    }
    const body = await readBody(req);
    let request: ScanActionRequest;
    try {
      request = validateScanActionRequest(body.value);
    } catch (error) {
      if (error instanceof ScanRequestValidationError) throw new GatewayError("invalid_request", 400);
      throw error;
    }
    if (request.action !== "complete" && body.bytes > MAX_SCAN_SMALL_REQUEST_BYTES) {
      throw new GatewayError("payload_too_large", 413);
    }
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const storage = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) },
    });
    if (request.action === "claim") return await claim(admin, storage, request);
    if (request.action === "heartbeat") return await heartbeat(admin, request);
    if (request.action === "ack_download") return await acknowledgeDownload(admin, request);
    if (request.action === "complete") return await complete(admin, storage, request);
    return await markFailed(admin, request);
  } catch (error) {
    const safe = error instanceof GatewayError
      ? error
      : new GatewayError("service_unavailable", 503);
    console.error("document-preprocessing failed:", safe.code);
    return fail(safe);
  }
});

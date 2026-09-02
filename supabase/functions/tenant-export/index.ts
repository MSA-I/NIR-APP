import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import {
  assertExportManifest,
  assertExportManifestPage,
  csvCell,
  csvRow,
  type ExportManifest,
  type ExportManifestPage,
  htmlEscape,
  type ManifestArtifact,
  type ManifestPageSummary,
  safeArchivePath,
} from "./core.ts";
import { withAllowedOrigin } from "../_shared/cors.ts";

const CORS_HEADERS: Record<string, string> = {
  // Filled per request by withAllowedOrigin (../_shared/cors.ts): the caller's Origin when it
  // is on ALLOWED_ORIGINS/APP_BASE_URL, and the first allowed origin otherwise. Never "*".
  "Access-Control-Allow-Origin": "",
  Vary: "Origin",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-correlation-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const EXPORT_BUCKET = "tenant-exports";
const LINK_SECONDS = 7 * 24 * 60 * 60;
const STORAGE_REDIRECT_SECONDS = 60;
const SNAPSHOT_BATCHES_PER_INVOCATION = 8;
const SNAPSHOT_ROWS_PER_BATCH = 50;
const SNAPSHOT_BYTES_PER_BATCH = 1024 * 1024;
const PARTS_PER_INVOCATION = 8;
const MAX_BATCH_MS = 85_000;
const encoder = new TextEncoder();

type PublicAction = "build" | "download";
type InternalAction = "continue";

interface ExportRequestBody {
  action?: PublicAction | InternalAction;
  request_id?: string;
  generation?: string;
  worker_token?: string;
}

interface MainClaim {
  build_required: boolean;
  resumed?: boolean;
  part_count?: number;
  request: {
    id: string;
    org_id: string;
    status: string;
    export_generation?: string | null;
  };
}

type PartKind =
  | "table_json"
  | "table_csv"
  | "source_object"
  | "auth_accounts"
  | "manifest_page"
  | "manifest";

interface ExportPart {
  request_id: string;
  generation: string;
  part_id: string;
  org_id: string;
  kind: PartKind;
  payload: Record<string, unknown>;
  mime_type: "application/json" | "text/csv" | "application/octet-stream";
  claim_token: string;
}

interface TablePartPlan {
  tableName: string;
  afterOrdinal: number;
  limit: number;
  columns: string[];
  firstOrdinal: number | null;
  lastOrdinal: number | null;
  oversizedSingleRow: boolean;
}

interface SnapshotRow {
  row_ordinal: number;
  row_data: Record<string, unknown>;
}

interface ArtifactEvidence {
  sha256: string;
  sizeBytes: number;
}

interface VerifiedManifest {
  manifest: ExportManifest;
  path: string;
  sha256: string;
}

interface VerifiedManifestPage {
  page: ExportManifestPage;
  descriptor: ManifestPageSummary;
}

interface ResolvedArtifact extends ManifestArtifact {
  artifact_kind: string;
}

type ExportAccessKind =
  | "portal_opened"
  | "manifest_downloaded"
  | "manifest_page_downloaded"
  | "artifact_link_issued";

interface ExportAccessReceipt {
  recorded: true;
  request_id: string;
  generation: string;
  access_kind: ExportAccessKind;
  idempotency_key: string;
  idempotent: boolean;
}

interface SnapshotBatchReceipt {
  state_kind: "table" | "storage" | "completed";
  table_name: string | null;
  status: string;
  batch_index: number | null;
  batch_row_count: number;
  batch_object_count: number;
  batch_bytes: number;
  after_ordinal: number | null;
  last_ordinal: number | null;
  json_part_id: string | null;
  csv_part_id: string | null;
  auth_part_id: string | null;
  source_part_ids: string[];
  oversized_single_record: boolean;
  all_snapshots_completed: boolean;
  idempotent: boolean;
}

function json(body: unknown, status = 200, cors = true): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(cors ? CORS_HEADERS : {}),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function downloadPortal(
  requestUrl: string,
  token: string,
  manifest: ExportManifest,
  verifiedPage: VerifiedManifestPage | null,
): Response {
  const manifestUrl = new URL(requestUrl);
  manifestUrl.search = "";
  manifestUrl.searchParams.set("token", token);
  manifestUrl.searchParams.set("format", "json");
  manifestUrl.searchParams.set("access", crypto.randomUUID());
  const pageIndex = verifiedPage?.page.page_index ?? 0;
  const artifacts = (verifiedPage?.page.artifacts ?? []).map((artifact) => {
    const href = brokerArtifactUrl(
      requestUrl,
      token,
      artifact.path,
      pageIndex,
      crypto.randomUUID(),
    );
    return `<li><a href="${htmlEscape(href)}">${
      htmlEscape(artifact.name)
    }</a>` +
      `<small>${htmlEscape(artifact.mime_type)} · ${
        artifact.size_bytes.toLocaleString("he-IL")
      } bytes</small>` +
      `<code dir="ltr">SHA-256 ${htmlEscape(artifact.sha256)}</code></li>`;
  }).join("");
  const pageUrl = (targetPage: number) => {
    const target = new URL(requestUrl);
    target.search = "";
    target.searchParams.set("token", token);
    target.searchParams.set("page", String(targetPage));
    target.searchParams.set("access", crypto.randomUUID());
    return target.toString();
  };
  const pagination = manifest.page_count < 2
    ? ""
    : `<nav aria-label="עמודי ייצוא">${
      pageIndex > 0
        ? `<a href="${htmlEscape(pageUrl(pageIndex - 1))}">העמוד הקודם</a>`
        : ""
    }<span>עמוד ${pageIndex + 1} מתוך ${manifest.page_count}</span>${
      pageIndex + 1 < manifest.page_count
        ? `<a href="${htmlEscape(pageUrl(pageIndex + 1))}">העמוד הבא</a>`
        : ""
    }</nav>`;
  const document = `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ייצוא מידע — InPlace</title><style>
body{font-family:Arial,sans-serif;max-width:64rem;margin:0 auto;padding:2rem;color:#172126;background:#f7f5ef}main{background:#fff;border:1px solid #ddd8cc;border-radius:12px;padding:1.5rem}h1{font-size:1.5rem;margin-top:0}p{line-height:1.6}ul{list-style:none;padding:0;display:grid;gap:.75rem}li{border:1px solid #e4e0d7;border-radius:8px;padding:1rem;display:grid;gap:.4rem}a{color:#075d66;font-weight:700;overflow-wrap:anywhere}small{color:#59666c}code{font-size:.75rem;overflow-wrap:anywhere;color:#59666c}.machine{display:inline-block;margin-top:1rem}nav{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:1rem 0}</style></head>
<body><main><h1>ייצוא המידע שלך</h1><p>הקבצים נבנו מחלקים חתומים. כל קישור נבדק מחדש בזמן ההורדה ואינו נשמר במטמון.</p>
${pagination}<ul>${artifacts}</ul><a class="machine" href="${
    htmlEscape(manifestUrl.toString())
  }">הורדת אינדקס מכונתי (JSON)</a></main></body></html>`;
  return new Response(document, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeErrorCode(error: unknown): string {
  const code = message(error).split(":", 1)[0]?.toLowerCase() ?? "";
  return /^[a-z0-9_]{1,100}$/u.test(code) ? code : "unknown_export_error";
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join("\u0000") ===
      [...keys].sort().join("\u0000");
}

function snapshotBatchReceipt(value: unknown): SnapshotBatchReceipt {
  const keys = [
    "state_kind",
    "table_name",
    "status",
    "batch_index",
    "batch_row_count",
    "batch_object_count",
    "batch_bytes",
    "after_ordinal",
    "last_ordinal",
    "json_part_id",
    "csv_part_id",
    "auth_part_id",
    "source_part_ids",
    "oversized_single_record",
    "all_snapshots_completed",
    "idempotent",
  ];
  if (!exactRecord(value, keys)) {
    throw new Error("export_snapshot_receipt_invalid");
  }
  const receipt = value as unknown as SnapshotBatchReceipt;
  const nullableInteger = (item: unknown) =>
    item === null || (Number.isSafeInteger(item) && Number(item) >= 0);
  const nullableUuid = (item: unknown) => item === null || validUuid(item);
  if (
    !["table", "storage", "completed"].includes(receipt.state_kind) ||
    typeof receipt.status !== "string" || !receipt.status ||
    !nullableInteger(receipt.batch_index) ||
    !Number.isSafeInteger(receipt.batch_row_count) ||
    receipt.batch_row_count < 0 ||
    receipt.batch_row_count > SNAPSHOT_ROWS_PER_BATCH ||
    !Number.isSafeInteger(receipt.batch_object_count) ||
    receipt.batch_object_count < 0 ||
    receipt.batch_object_count > SNAPSHOT_ROWS_PER_BATCH ||
    !Number.isSafeInteger(receipt.batch_bytes) || receipt.batch_bytes < 0 ||
    receipt.batch_bytes > 26 * 1024 * 1024 ||
    !nullableInteger(receipt.after_ordinal) ||
    !nullableInteger(receipt.last_ordinal) ||
    !nullableUuid(receipt.json_part_id) ||
    !nullableUuid(receipt.csv_part_id) ||
    !nullableUuid(receipt.auth_part_id) ||
    !Array.isArray(receipt.source_part_ids) ||
    !receipt.source_part_ids.every(validUuid) ||
    typeof receipt.oversized_single_record !== "boolean" ||
    typeof receipt.all_snapshots_completed !== "boolean" ||
    typeof receipt.idempotent !== "boolean"
  ) throw new Error("export_snapshot_receipt_invalid");
  if (receipt.state_kind === "completed") {
    if (
      receipt.table_name !== null || receipt.status !== "completed" ||
      receipt.batch_index !== null || receipt.batch_row_count !== 0 ||
      receipt.batch_object_count !== 0 ||
      receipt.batch_bytes !== 0 || receipt.after_ordinal !== null ||
      receipt.last_ordinal !== null || receipt.json_part_id !== null ||
      receipt.csv_part_id !== null || receipt.auth_part_id !== null ||
      receipt.source_part_ids.length !== 0 ||
      receipt.oversized_single_record || !receipt.all_snapshots_completed ||
      !receipt.idempotent
    ) throw new Error("export_snapshot_receipt_invalid");
    return receipt;
  }
  if (
    !["copying", "completed"].includes(receipt.status) ||
    receipt.batch_index === null || receipt.after_ordinal === null ||
    receipt.last_ordinal === null || receipt.idempotent ||
    (receipt.all_snapshots_completed && receipt.status !== "completed")
  ) throw new Error("export_snapshot_receipt_invalid");
  const recordCount = receipt.state_kind === "table"
    ? receipt.batch_row_count
    : receipt.batch_object_count;
  if (
    (recordCount === 0
      ? receipt.status !== "completed" || receipt.batch_bytes !== 0 ||
        receipt.last_ordinal !== receipt.after_ordinal ||
        receipt.oversized_single_record
      : receipt.last_ordinal !== receipt.after_ordinal + recordCount ||
        receipt.batch_bytes < 1) ||
    (receipt.oversized_single_record
      ? recordCount !== 1 || receipt.batch_bytes <= SNAPSHOT_BYTES_PER_BATCH
      : receipt.batch_bytes > SNAPSHOT_BYTES_PER_BATCH)
  ) throw new Error("export_snapshot_receipt_invalid");
  if (receipt.state_kind === "table") {
    if (
      typeof receipt.table_name !== "string" ||
      !/^[a-z][a-z0-9_]*$/u.test(receipt.table_name) ||
      receipt.batch_object_count !== 0 || receipt.json_part_id === null ||
      receipt.csv_part_id === null || receipt.source_part_ids.length !== 0 ||
      (receipt.table_name === "profiles" && receipt.batch_row_count > 0
        ? receipt.auth_part_id === null
        : receipt.auth_part_id !== null)
    ) throw new Error("export_snapshot_receipt_invalid");
  } else if (
    receipt.table_name !== null || receipt.batch_row_count !== 0 ||
    receipt.json_part_id !== null || receipt.csv_part_id !== null ||
    receipt.auth_part_id !== null ||
    receipt.source_part_ids.length !== receipt.batch_object_count ||
    new Set(receipt.source_part_ids).size !== receipt.source_part_ids.length
  ) throw new Error("export_snapshot_receipt_invalid");
  return receipt;
}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label}_invalid`);
  }
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) || !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function oneChunk(bytes: Uint8Array): () => AsyncIterable<Uint8Array> {
  return () =>
    (async function* () {
      yield bytes;
    })();
}

async function* textChunks(text: string): AsyncGenerator<Uint8Array> {
  const bytes = encoder.encode(text);
  for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
    yield bytes.subarray(
      offset,
      Math.min(offset + 64 * 1024, bytes.byteLength),
    );
  }
}

async function* responseChunks(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) throw new Error("export_stream_missing");
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function hashChunks(
  chunks: AsyncIterable<Uint8Array>,
): Promise<ArtifactEvidence> {
  const digest = sha256.create();
  let sizeBytes = 0;
  for await (const chunk of chunks) {
    digest.update(chunk);
    sizeBytes += chunk.byteLength;
  }
  return { sha256: bytesToHex(digest.digest()), sizeBytes };
}

function storageObjectUrl(url: string, bucket: string, path: string): string {
  return `${url}/storage/v1/object/authenticated/${
    encodeURIComponent(bucket)
  }/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function sourceObjectChunks(
  url: string,
  serviceKey: string,
  bucket: string,
  path: string,
  expectedSize: number,
): () => AsyncIterable<Uint8Array> {
  return () =>
    (async function* () {
      const response = await fetch(storageObjectUrl(url, bucket, path), {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!response.ok || !response.body) {
        throw new Error(
          `export_file_download_failed:${response.status}`,
        );
      }
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== expectedSize) {
        throw new Error(
          "export_file_size_changed",
        );
      }
      let seen = 0;
      for await (const chunk of responseChunks(response)) {
        seen += chunk.byteLength;
        yield chunk;
      }
      if (seen !== expectedSize) throw new Error("export_file_size_changed");
    })();
}

async function existingArtifactEvidence(
  url: string,
  serviceKey: string,
  path: string,
): Promise<ArtifactEvidence | null> {
  const response = await fetch(storageObjectUrl(url, EXPORT_BUCKET, path), {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (response.status === 404) return null;
  if (!response.ok || !response.body) {
    throw new Error(`export_existing_part_read_failed:${response.status}`);
  }
  return hashChunks(responseChunks(response));
}

/**
 * Uploads without overwrite. If a worker died after upload but before DB settlement, the next
 * fenced worker hashes both immutable input and the existing object before accepting it.
 */
async function uploadArtifact(
  url: string,
  serviceKey: string,
  path: string,
  mimeType: string,
  chunksFactory: () => AsyncIterable<Uint8Array>,
  heartbeat: () => Promise<void>,
): Promise<ArtifactEvidence> {
  const existing = await existingArtifactEvidence(url, serviceKey, path);
  if (existing) {
    const intended = await hashChunks(chunksFactory());
    if (
      existing.sha256 !== intended.sha256 ||
      existing.sizeBytes !== intended.sizeBytes
    ) {
      throw new Error("export_part_collision");
    }
    return intended;
  }

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const uploadUrl = `${url}/storage/v1/object/${EXPORT_BUCKET}/${
    path.split("/").map(encodeURIComponent).join("/")
  }`;
  const upload = fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": mimeType,
      "x-upsert": "false",
    },
    body: stream.readable,
  });
  const digest = sha256.create();
  let sizeBytes = 0;
  let lastHeartbeat = Date.now();
  let pumpError: unknown = null;
  try {
    for await (const chunk of chunksFactory()) {
      if (Date.now() - lastHeartbeat >= 45_000) {
        await heartbeat();
        lastHeartbeat = Date.now();
      }
      digest.update(chunk);
      sizeBytes += chunk.byteLength;
      await writer.write(chunk);
    }
    await writer.close();
  } catch (error) {
    pumpError = error;
    await writer.abort(error).catch(() => undefined);
  }

  let response: Response;
  try {
    response = await upload;
  } catch (error) {
    if (pumpError) throw pumpError;
    throw error;
  }
  if (pumpError && response.status !== 409) throw pumpError;

  let intended = pumpError
    ? await hashChunks(chunksFactory())
    : { sha256: bytesToHex(digest.digest()), sizeBytes };
  if (response.status === 409) {
    const collided = await existingArtifactEvidence(url, serviceKey, path);
    if (
      !collided || collided.sha256 !== intended.sha256 ||
      collided.sizeBytes !== intended.sizeBytes
    ) {
      throw new Error("export_part_collision");
    }
    return intended;
  }
  if (!response.ok) {
    throw new Error(`export_storage_upload_failed:${response.status}`);
  }
  return intended;
}

function tablePartPlan(part: ExportPart): TablePartPlan {
  const payload = part.payload;
  const keys = [
    "table_name",
    "format",
    "batch_index",
    "after_ordinal",
    "limit",
    "first_ordinal",
    "last_ordinal",
    "row_count",
    "batch_row_count",
    "batch_bytes",
    "columns",
    "empty",
    "oversized_single_row",
  ];
  if (!exactRecord(payload, keys)) throw new Error("export_table_part_invalid");
  const tableName = typeof payload.table_name === "string"
    ? payload.table_name
    : "";
  if (!/^[a-z][a-z0-9_]*$/u.test(tableName)) {
    throw new Error("export_table_invalid");
  }
  const expectedFormat = part.kind === "table_json" ? "json" : "csv";
  const batchIndex = integer(payload.batch_index, "export_batch_index");
  const afterOrdinal = integer(payload.after_ordinal, "export_after_ordinal");
  const limit = integer(payload.limit, "export_page_limit");
  const rowCount = integer(payload.row_count, "export_row_count");
  const batchRowCount = integer(
    payload.batch_row_count,
    "export_batch_row_count",
  );
  const batchBytes = integer(payload.batch_bytes, "export_batch_bytes");
  const columns = stringArray(payload.columns, "export_columns");
  const firstOrdinal = payload.first_ordinal === null
    ? null
    : integer(payload.first_ordinal, "export_first_ordinal");
  const lastOrdinal = payload.last_ordinal === null
    ? null
    : integer(payload.last_ordinal, "export_last_ordinal");
  const empty = payload.empty;
  const oversizedSingleRow = payload.oversized_single_row;
  if (
    payload.format !== expectedFormat || batchIndex < 0 ||
    limit !== batchRowCount || limit > SNAPSHOT_ROWS_PER_BATCH ||
    rowCount < batchRowCount || !columns.length ||
    !columns.every((column) => /^[a-z][a-z0-9_]*$/u.test(column)) ||
    typeof empty !== "boolean" || typeof oversizedSingleRow !== "boolean" ||
    (empty
      ? limit !== 0 || rowCount !== 0 || batchBytes !== 0 ||
        firstOrdinal !== null || lastOrdinal !== null || oversizedSingleRow
      : limit < 1 || firstOrdinal !== afterOrdinal + 1 ||
        lastOrdinal !== afterOrdinal + limit || batchBytes < 1) ||
    (oversizedSingleRow
      ? limit !== 1 || batchBytes <= SNAPSHOT_BYTES_PER_BATCH ||
        batchBytes > 26 * 1024 * 1024
      : batchBytes > SNAPSHOT_BYTES_PER_BATCH)
  ) throw new Error("export_table_part_invalid");
  return {
    tableName,
    afterOrdinal,
    limit,
    columns,
    firstOrdinal,
    lastOrdinal,
    oversizedSingleRow,
  };
}

async function snapshotRows(
  admin: SupabaseClient,
  requestId: string,
  generation: string,
  workerToken: string,
  plan: TablePartPlan,
): Promise<Record<string, unknown>[]> {
  if (plan.limit === 0) return [];
  const result = await admin.rpc(
    "service_get_organization_export_snapshot_page",
    {
      p_request_id: requestId,
      p_generation: generation,
      p_worker_token: workerToken,
      p_table_name: plan.tableName,
      p_after_ordinal: plan.afterOrdinal,
      p_limit: plan.limit,
    },
  );
  if (result.error) {
    throw new Error(`table_export_failed:${result.error.message}`);
  }
  if (!Array.isArray(result.data) || result.data.length !== plan.limit) {
    throw new Error("table_export_page_invalid");
  }
  const rows = result.data as SnapshotRow[];
  let ordinal = plan.afterOrdinal;
  for (const row of rows) {
    if (
      !exactRecord(row, ["row_ordinal", "row_data"]) ||
      !Number.isSafeInteger(row.row_ordinal) ||
      row.row_ordinal !== ordinal + 1 ||
      typeof row.row_data !== "object" || row.row_data === null ||
      Array.isArray(row.row_data)
    ) {
      throw new Error("table_export_order_invalid");
    }
    ordinal = row.row_ordinal;
  }
  if (
    rows[0]?.row_ordinal !== plan.firstOrdinal || ordinal !== plan.lastOrdinal
  ) {
    throw new Error("table_export_order_invalid");
  }
  return rows.map(({ row_data }) => row_data);
}

async function authAccountBytes(
  admin: SupabaseClient,
  userIds: string[],
): Promise<Uint8Array> {
  if (!userIds.every(validUuid) || userIds.length > SNAPSHOT_ROWS_PER_BATCH) {
    throw new Error("auth_account_page_invalid");
  }
  const accounts: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < userIds.length; offset += 20) {
    const batch = userIds.slice(offset, offset + 20);
    const users = await Promise.all(
      batch.map((userId) => admin.auth.admin.getUserById(userId)),
    );
    for (let index = 0; index < users.length; index += 1) {
      const result = users[index];
      if (result.error || !result.data.user) {
        throw new Error("account_identity_export_failed");
      }
      accounts.push({
        user_id: batch[index],
        email: result.data.user.email ?? null,
        phone: result.data.user.phone ?? null,
        created_at: result.data.user.created_at,
        last_sign_in_at: result.data.user.last_sign_in_at ?? null,
      });
    }
  }
  return encoder.encode(`${JSON.stringify(accounts, null, 2)}\n`);
}

async function partChunks(
  admin: SupabaseClient,
  url: string,
  serviceKey: string,
  part: ExportPart,
  workerToken: string,
): Promise<() => AsyncIterable<Uint8Array>> {
  const payload = part.payload;
  if (part.kind === "table_json" || part.kind === "table_csv") {
    const plan = tablePartPlan(part);
    const rows = await snapshotRows(
      admin,
      part.request_id,
      part.generation,
      workerToken,
      plan,
    );
    if (part.kind === "table_json") {
      return () =>
        (async function* () {
          yield encoder.encode("[\n");
          for (let index = 0; index < rows.length; index += 1) {
            if (index > 0) yield encoder.encode(",\n");
            yield* textChunks(JSON.stringify(rows[index], null, 2));
          }
          yield encoder.encode("\n]\n");
        })();
    }
    return () =>
      (async function* () {
        yield* textChunks(`\ufeff${plan.columns.map(csvCell).join(",")}\r\n`);
        for (const row of rows) yield* textChunks(csvRow(plan.columns, row));
      })();
  }
  if (part.kind === "auth_accounts") {
    return oneChunk(
      await authAccountBytes(
        admin,
        stringArray(payload.user_ids, "auth_user_ids"),
      ),
    );
  }
  if (part.kind === "source_object") {
    const bucket = typeof payload.bucket_id === "string"
      ? payload.bucket_id
      : "";
    const path = typeof payload.object_name === "string"
      ? payload.object_name
      : "";
    if (
      !["documents", "price-submissions", "organization-branding"].includes(
        bucket,
      )
    ) {
      throw new Error("export_storage_bucket_invalid");
    }
    if (!path.startsWith(`${part.org_id}/`)) {
      throw new Error("export_storage_scope_invalid");
    }
    return sourceObjectChunks(
      url,
      serviceKey,
      bucket,
      path,
      integer(payload.size_bytes, "source_size"),
    );
  }
  const artifactRoot =
    `${part.org_id}/offboarding/${part.request_id}/${part.generation}/parts/`;
  if (part.kind === "manifest_page") {
    const pageIndex = integer(payload.page_index, "manifest_page_index");
    assertExportManifestPage(payload, pageIndex, artifactRoot);
    return oneChunk(encoder.encode(`${JSON.stringify(payload, null, 2)}\n`));
  }
  if (part.kind === "manifest") {
    assertExportManifest(
      payload,
      part.request_id,
      part.generation,
      artifactRoot,
    );
    return oneChunk(encoder.encode(`${JSON.stringify(payload, null, 2)}\n`));
  }
  throw new Error("export_part_kind_invalid");
}

function partPath(part: ExportPart): string {
  const root =
    `${part.org_id}/offboarding/${part.request_id}/${part.generation}`;
  return part.kind === "manifest"
    ? `${root}/manifest.json`
    : `${root}/parts/${part.part_id}.part`;
}

async function heartbeatPart(
  admin: SupabaseClient,
  requestId: string,
  generation: string,
  workerToken: string,
  part: ExportPart,
) {
  const [main, current] = await Promise.all([
    admin.rpc("service_heartbeat_organization_export", {
      p_request_id: requestId,
      p_generation: generation,
      p_worker_token: workerToken,
    }),
    admin.rpc("service_heartbeat_organization_export_part", {
      p_request_id: requestId,
      p_generation: generation,
      p_part_id: part.part_id,
      p_claim_token: part.claim_token,
    }),
  ]);
  if (main.error || current.error) throw new Error("export_lease_lost");
}

async function processPart(
  admin: SupabaseClient,
  url: string,
  serviceKey: string,
  requestId: string,
  generation: string,
  workerToken: string,
  part: ExportPart,
): Promise<{ finalized: boolean }> {
  if (
    part.request_id !== requestId || part.generation !== generation ||
    !validUuid(part.part_id) || !validUuid(part.claim_token) ||
    !validUuid(part.org_id)
  ) throw new Error("export_part_claim_invalid");
  const heartbeat = () =>
    heartbeatPart(admin, requestId, generation, workerToken, part);
  await heartbeat();
  try {
    const chunks = await partChunks(admin, url, serviceKey, part, workerToken);
    const path = partPath(part);
    const evidence = await uploadArtifact(
      url,
      serviceKey,
      path,
      part.mime_type,
      chunks,
      heartbeat,
    );
    await heartbeat();
    const completed = await admin.rpc(
      "service_complete_organization_export_part",
      {
        p_request_id: requestId,
        p_generation: generation,
        p_part_id: part.part_id,
        p_claim_token: part.claim_token,
        p_object_path: path,
        p_sha256: evidence.sha256,
        p_size_bytes: evidence.sizeBytes,
      },
    );
    if (completed.error) {
      throw new Error(`export_part_complete_failed:${completed.error.message}`);
    }

    if (part.kind !== "manifest") return { finalized: false };
    assertExportManifest(
      part.payload,
      requestId,
      generation,
      `${part.org_id}/offboarding/${requestId}/${generation}/parts/`,
    );
    const finalized = await admin.rpc("service_complete_organization_export", {
      p_request_id: requestId,
      p_generation: generation,
      p_worker_token: workerToken,
      p_object_path: path,
      p_sha256: evidence.sha256,
    });
    const finalKeys = [
      "request_id",
      "generation",
      "status",
      "artifact_count",
      "aggregate_size_bytes",
      "idempotent",
    ];
    if (
      finalized.error || !exactRecord(finalized.data, finalKeys) ||
      finalized.data.request_id !== requestId ||
      finalized.data.generation !== generation ||
      finalized.data.status !== "export_ready" ||
      !Number.isSafeInteger(finalized.data.artifact_count) ||
      Number(finalized.data.artifact_count) < 1 ||
      !Number.isSafeInteger(finalized.data.aggregate_size_bytes) ||
      Number(finalized.data.aggregate_size_bytes) < evidence.sizeBytes ||
      typeof finalized.data.idempotent !== "boolean"
    ) {
      throw new Error(
        `export_finalize_failed:${
          finalized.error?.message ?? "invalid_receipt"
        }`,
      );
    }
    return { finalized: true };
  } catch (error) {
    await admin.rpc("service_fail_organization_export_part", {
      p_request_id: requestId,
      p_generation: generation,
      p_part_id: part.part_id,
      p_claim_token: part.claim_token,
      p_error_code: safeErrorCode(error),
    });
    throw error;
  }
}

async function failExport(
  admin: SupabaseClient,
  requestId: string,
  generation: string,
  workerToken: string,
  error: unknown,
) {
  console.error("tenant export worker failed", safeErrorCode(error));
  await admin.rpc("service_fail_organization_export", {
    p_request_id: requestId,
    p_generation: generation,
    p_worker_token: workerToken,
    p_error_code: safeErrorCode(error),
  });
}

async function invokeContinuation(
  url: string,
  serviceKey: string,
  requestId: string,
  generation: string,
  workerToken: string,
) {
  const response = await fetch(`${url}/functions/v1/tenant-export`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "continue",
      request_id: requestId,
      generation,
      worker_token: workerToken,
    }),
  });
  if (!response.ok) {
    throw new Error(`export_continuation_failed:${response.status}`);
  }
}

async function snapshotBeforeParts(
  admin: SupabaseClient,
  requestId: string,
  generation: string,
  workerToken: string,
  startedAt: number,
): Promise<boolean> {
  for (
    let processed = 0;
    processed < SNAPSHOT_BATCHES_PER_INVOCATION;
    processed += 1
  ) {
    const heartbeat = await admin.rpc("service_heartbeat_organization_export", {
      p_request_id: requestId,
      p_generation: generation,
      p_worker_token: workerToken,
    });
    if (heartbeat.error) throw new Error("export_lease_lost");
    const batch = await admin.rpc(
      "service_snapshot_organization_export_batch",
      {
        p_request_id: requestId,
        p_generation: generation,
        p_worker_token: workerToken,
        p_max_rows: SNAPSHOT_ROWS_PER_BATCH,
        p_max_bytes: SNAPSHOT_BYTES_PER_BATCH,
      },
    );
    if (batch.error) {
      throw new Error(`export_snapshot_failed:${batch.error.message}`);
    }
    const receipt = snapshotBatchReceipt(batch.data);
    if (receipt.all_snapshots_completed) return true;
    if (Date.now() - startedAt >= MAX_BATCH_MS) return false;
  }
  return false;
}

async function runExportBatch(
  admin: SupabaseClient,
  url: string,
  serviceKey: string,
  requestId: string,
  generation: string,
  workerToken: string,
) {
  const startedAt = Date.now();
  const snapshotComplete = await snapshotBeforeParts(
    admin,
    requestId,
    generation,
    workerToken,
    startedAt,
  );
  if (!snapshotComplete || Date.now() - startedAt >= MAX_BATCH_MS) {
    await invokeContinuation(
      url,
      serviceKey,
      requestId,
      generation,
      workerToken,
    );
    return;
  }
  for (let processed = 0; processed < PARTS_PER_INVOCATION; processed += 1) {
    const heartbeat = await admin.rpc("service_heartbeat_organization_export", {
      p_request_id: requestId,
      p_generation: generation,
      p_worker_token: workerToken,
    });
    if (heartbeat.error) throw new Error("export_lease_lost");
    const claimed = await admin.rpc("service_claim_organization_export_part", {
      p_request_id: requestId,
      p_generation: generation,
      p_worker_token: workerToken,
    });
    if (claimed.error) {
      throw new Error(`export_part_claim_failed:${claimed.error.message}`);
    }
    if (!claimed.data) return;
    const result = await processPart(
      admin,
      url,
      serviceKey,
      requestId,
      generation,
      workerToken,
      claimed.data as ExportPart,
    );
    if (result.finalized) return;
    if (Date.now() - startedAt >= MAX_BATCH_MS) break;
  }
  await invokeContinuation(url, serviceKey, requestId, generation, workerToken);
}

function scheduleExport(
  admin: SupabaseClient,
  url: string,
  serviceKey: string,
  requestId: string,
  generation: string,
  workerToken: string,
) {
  const task = runExportBatch(
    admin,
    url,
    serviceKey,
    requestId,
    generation,
    workerToken,
  )
    .catch((error) =>
      failExport(admin, requestId, generation, workerToken, error)
    );
  const runtime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
  }).EdgeRuntime;
  if (runtime) runtime.waitUntil(task);
  else void task;
}

async function startExport(
  admin: SupabaseClient,
  url: string,
  serviceKey: string,
  requestId: string,
) {
  const workerToken = crypto.randomUUID();
  const claimed = await admin.rpc("service_claim_organization_export", {
    p_request_id: requestId,
    p_worker_token: workerToken,
  });
  if (claimed.error || !claimed.data) {
    throw new Error(claimed.error?.message ?? "export_claim_failed");
  }
  const claim = claimed.data as MainClaim;
  if (!claim.build_required) {
    return { accepted: false, status: claim.request.status, resumed: false };
  }
  const generation = claim.request.export_generation;
  if (!validUuid(generation)) throw new Error("export_generation_missing");
  scheduleExport(admin, url, serviceKey, requestId, generation, workerToken);
  return {
    accepted: true,
    status: "export_building",
    resumed: claim.resumed === true,
    part_count: claim.part_count ?? null,
  };
}

async function readManifest(
  admin: SupabaseClient,
  path: string,
  requestId: string,
  expectedGeneration: string,
  expectedSha256: string,
  expectedSizeBytes: number,
): Promise<VerifiedManifest> {
  const downloaded = await admin.storage.from(EXPORT_BUCKET).download(path);
  if (downloaded.error || !downloaded.data) {
    throw new Error("export_manifest_unavailable");
  }
  if (
    downloaded.data.size !== expectedSizeBytes ||
    downloaded.data.size > 8 * 1024 * 1024
  ) {
    throw new Error("export_manifest_too_large");
  }
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  const manifestSha256 = bytesToHex(sha256(bytes));
  if (manifestSha256 !== expectedSha256) {
    throw new Error("export_manifest_invalid");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error("export_manifest_invalid");
  }
  const generation = typeof parsed.generation === "string"
    ? parsed.generation
    : "";
  const pathSegments = path.split("/");
  if (
    pathSegments.length !== 5 ||
    !validUuid(pathSegments[0]) ||
    pathSegments[1] !== "offboarding" ||
    pathSegments[2] !== requestId ||
    generation !== expectedGeneration ||
    pathSegments[3] !== generation ||
    pathSegments[4] !== "manifest.json"
  ) {
    throw new Error("export_manifest_invalid");
  }
  assertExportManifest(
    parsed,
    requestId,
    generation,
    `${pathSegments[0]}/offboarding/${requestId}/${generation}/parts/`,
  );
  return { manifest: parsed, path, sha256: manifestSha256 };
}

async function readManifestPage(
  admin: SupabaseClient,
  descriptor: ManifestPageSummary,
  artifactRoot: string,
): Promise<VerifiedManifestPage> {
  const downloaded = await admin.storage.from(EXPORT_BUCKET).download(
    descriptor.path,
  );
  if (downloaded.error || !downloaded.data) {
    throw new Error("export_manifest_page_unavailable");
  }
  if (
    downloaded.data.size !== descriptor.size_bytes ||
    downloaded.data.size > 8 * 1024 * 1024
  ) throw new Error("export_manifest_page_invalid");
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (bytesToHex(sha256(bytes)) !== descriptor.sha256) {
    throw new Error("export_manifest_page_invalid");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as Record<string, unknown>;
  } catch {
    throw new Error("export_manifest_page_invalid");
  }
  assertExportManifestPage(parsed, descriptor.page_index, artifactRoot);
  return { page: parsed, descriptor };
}

function brokerArtifactUrl(
  requestUrl: string,
  token: string,
  artifactPath: string,
  pageIndex: number,
  accessId: string,
): string {
  if (
    !validUuid(accessId) || !Number.isSafeInteger(pageIndex) || pageIndex < 0
  ) {
    throw new Error("export_access_id_invalid");
  }
  const target = new URL(requestUrl);
  target.search = "";
  target.searchParams.set("token", token);
  target.searchParams.set("artifact", artifactPath);
  target.searchParams.set("page", String(pageIndex));
  target.searchParams.set("access", accessId);
  return target.toString();
}

async function recordExportAccess(
  admin: SupabaseClient,
  tokenHash: string,
  accessKind: ExportAccessKind,
  accessId: string,
  manifest: VerifiedManifest,
  artifact: ManifestArtifact | null,
): Promise<void> {
  const requiresArtifact = accessKind === "manifest_page_downloaded" ||
    accessKind === "artifact_link_issued";
  if (requiresArtifact !== (artifact !== null)) {
    throw new Error("export_access_artifact_invalid");
  }
  const result = await admin.rpc("service_record_organization_export_access", {
    p_token_hash: tokenHash,
    p_access_kind: accessKind,
    p_idempotency_key: accessId,
    p_artifact_name: accessKind === "portal_opened"
      ? null
      : artifact?.name ?? "manifest.json",
    p_artifact_path: accessKind === "portal_opened"
      ? null
      : artifact?.path ?? manifest.path,
    p_artifact_sha256: accessKind === "portal_opened"
      ? null
      : artifact?.sha256 ?? manifest.sha256,
  });
  const counterKey = accessKind === "portal_opened"
    ? "portal_open_count"
    : accessKind === "artifact_link_issued"
    ? "artifact_link_issued_count"
    : "download_count";
  const keys = [
    "recorded",
    "request_id",
    "generation",
    "access_kind",
    "idempotency_key",
    "idempotent",
    counterKey,
  ];
  if (
    result.error || !exactRecord(result.data, keys) ||
    result.data.recorded !== true ||
    result.data.request_id !== manifest.manifest.request_id ||
    !validUuid(result.data.generation) ||
    result.data.generation !== manifest.manifest.generation ||
    result.data.access_kind !== accessKind ||
    result.data.idempotency_key !== accessId ||
    typeof result.data.idempotent !== "boolean" ||
    !Number.isSafeInteger(result.data[counterKey]) ||
    Number(result.data[counterKey]) < 0
  ) {
    throw new Error("export_access_audit_failed");
  }
}

async function resolveExportArtifact(
  admin: SupabaseClient,
  tokenHash: string,
  path: string,
  pageArtifact: ManifestArtifact,
): Promise<ResolvedArtifact> {
  const result = await admin.rpc(
    "service_resolve_organization_export_artifact",
    {
      p_token_hash: tokenHash,
      p_artifact_path: path,
    },
  );
  if (result.error) throw new Error("export_artifact_resolution_failed");
  const row = Array.isArray(result.data) && result.data.length === 1
    ? result.data[0]
    : null;
  const keys = [
    "name",
    "path",
    "sha256",
    "size_bytes",
    "mime_type",
    "artifact_kind",
  ];
  if (
    !exactRecord(row, keys) || row.path !== path ||
    row.name !== pageArtifact.name || row.sha256 !== pageArtifact.sha256 ||
    row.size_bytes !== pageArtifact.size_bytes ||
    row.mime_type !== pageArtifact.mime_type ||
    typeof row.artifact_kind !== "string" || !row.artifact_kind
  ) throw new Error("export_artifact_unverified");
  safeArchivePath(String(row.name));
  return row as unknown as ResolvedArtifact;
}

async function brokerDownload(
  request: Request,
  admin: SupabaseClient,
  token: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const accessId = requestUrl.searchParams.get("access");
  if (!/^[A-Za-z0-9_-]{40,100}$/u.test(token) || !validUuid(accessId)) {
    return json({ error: "link_invalid" }, 404, false);
  }
  const tokenHash = bytesToHex(sha256(encoder.encode(token)));
  const resolved = await admin.rpc("service_resolve_organization_export_link", {
    p_token_hash: tokenHash,
  });
  const row = Array.isArray(resolved.data) && resolved.data.length === 1
    ? resolved.data[0]
    : null;
  const linkKeys = [
    "request_id",
    "generation",
    "object_path",
    "object_sha256",
    "object_size_bytes",
  ];
  if (
    resolved.error || !exactRecord(row, linkKeys) ||
    !validUuid(row.request_id) || !validUuid(row.generation) ||
    typeof row.object_path !== "string" ||
    typeof row.object_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(row.object_sha256) ||
    !Number.isSafeInteger(row.object_size_bytes) ||
    Number(row.object_size_bytes) < 1
  ) {
    return json({ error: "link_invalid_or_expired" }, 404, false);
  }
  let verifiedManifest: VerifiedManifest;
  try {
    verifiedManifest = await readManifest(
      admin,
      row.object_path,
      row.request_id,
      row.generation,
      row.object_sha256,
      Number(row.object_size_bytes),
    );
  } catch {
    return json({ error: "download_unavailable" }, 503, false);
  }
  const manifest = verifiedManifest.manifest;
  const requestedArtifact = requestUrl.searchParams.get("artifact");
  const rawPage = requestUrl.searchParams.get("page");
  if (rawPage !== null && !/^(0|[1-9][0-9]*)$/u.test(rawPage)) {
    return json({ error: "manifest_page_unknown" }, 404, false);
  }
  const requestedPage = rawPage === null ? null : Number(rawPage);
  if (
    requestedPage !== null &&
    (!Number.isSafeInteger(requestedPage) ||
      requestedPage >= manifest.page_count)
  ) return json({ error: "manifest_page_unknown" }, 404, false);
  const artifactRoot = verifiedManifest.path.replace(
    /manifest\.json$/u,
    "parts/",
  );
  const pageBrokerUrl = (pageIndex: number, formatJson: boolean) => {
    const target = new URL(request.url);
    target.search = "";
    target.searchParams.set("token", token);
    target.searchParams.set("page", String(pageIndex));
    if (formatJson) target.searchParams.set("format", "json");
    target.searchParams.set("access", crypto.randomUUID());
    return target.toString();
  };
  if (!requestedArtifact) {
    const wantsJson = requestUrl.searchParams.get("format") === "json" ||
      (request.headers.get("Accept") ?? "").includes("application/json");
    if (wantsJson && requestedPage === null) {
      const response = json(
        {
          contract: "supplyflow_export_download_root_v2",
          request_id: manifest.request_id,
          generation: manifest.generation,
          generated_at: manifest.created_at,
          artifact_count: manifest.artifact_count,
          page_count: manifest.page_count,
          indexed_file_count: manifest.indexed_file_count,
          indexed_size_bytes: manifest.indexed_size_bytes,
          pages: manifest.pages.map((page) => ({
            page_index: page.page_index,
            name: page.name,
            sha256: page.sha256,
            size_bytes: page.size_bytes,
            artifact_count: page.artifact_count,
            page_url: pageBrokerUrl(page.page_index, true),
          })),
        },
        200,
        false,
      );
      try {
        await recordExportAccess(
          admin,
          tokenHash,
          "manifest_downloaded",
          accessId,
          verifiedManifest,
          null,
        );
      } catch {
        return json({ error: "download_audit_failed" }, 503, false);
      }
      return response;
    }
    let verifiedPage: VerifiedManifestPage | null = null;
    if (manifest.page_count > 0) {
      const pageIndex = requestedPage ?? 0;
      try {
        verifiedPage = await readManifestPage(
          admin,
          manifest.pages[pageIndex],
          artifactRoot,
        );
      } catch {
        return json({ error: "download_unavailable" }, 503, false);
      }
    }
    const response = wantsJson
      ? json(
        {
          contract: "supplyflow_export_download_page_v2",
          request_id: manifest.request_id,
          generation: manifest.generation,
          page_index: verifiedPage?.page.page_index ?? 0,
          page_count: manifest.page_count,
          artifact_count: verifiedPage?.page.artifact_count ?? 0,
          artifacts: (verifiedPage?.page.artifacts ?? []).map((artifact) => ({
            name: artifact.name,
            sha256: artifact.sha256,
            size_bytes: artifact.size_bytes,
            mime_type: artifact.mime_type,
            download_url: brokerArtifactUrl(
              request.url,
              token,
              artifact.path,
              verifiedPage?.page.page_index ?? 0,
              crypto.randomUUID(),
            ),
          })),
        },
        200,
        false,
      )
      : downloadPortal(request.url, token, manifest, verifiedPage);
    const pageAccessKind: ExportAccessKind = wantsJson
      ? "manifest_page_downloaded"
      : "portal_opened";
    const pageAccessArtifact = wantsJson
      ? verifiedPage?.descriptor ?? null
      : null;
    if (wantsJson && pageAccessArtifact === null) {
      return json({ error: "download_unavailable" }, 503, false);
    }
    try {
      await recordExportAccess(
        admin,
        tokenHash,
        pageAccessKind,
        accessId,
        verifiedManifest,
        pageAccessArtifact,
      );
    } catch {
      return json({ error: "download_audit_failed" }, 503, false);
    }
    return response;
  }
  if (requestedPage === null) {
    return json({ error: "artifact_page_required" }, 404, false);
  }
  let verifiedPage: VerifiedManifestPage;
  try {
    verifiedPage = await readManifestPage(
      admin,
      manifest.pages[requestedPage],
      artifactRoot,
    );
  } catch {
    return json({ error: "download_unavailable" }, 503, false);
  }
  const pageArtifact = verifiedPage.page.artifacts.find(({ path }) =>
    path === requestedArtifact
  );
  if (!pageArtifact) return json({ error: "artifact_unknown" }, 404, false);
  let artifact: ResolvedArtifact;
  try {
    artifact = await resolveExportArtifact(
      admin,
      tokenHash,
      requestedArtifact,
      pageArtifact,
    );
  } catch (error) {
    return json(
      { error: "artifact_unavailable" },
      message(error) === "export_artifact_resolution_failed" ? 503 : 404,
      false,
    );
  }
  const downloadName = artifact.name.split("/").at(-1) ??
    "supplyflow-export.part";
  const signed = await admin.storage.from(EXPORT_BUCKET)
    .createSignedUrl(artifact.path, STORAGE_REDIRECT_SECONDS, {
      download: downloadName,
    });
  if (signed.error || !signed.data?.signedUrl) {
    return json({ error: "download_unavailable" }, 503, false);
  }
  const revalidated = await admin.rpc(
    "service_revalidate_organization_export_link",
    {
      p_token_hash: tokenHash,
      p_object_path: row.object_path,
    },
  );
  if (revalidated.error || revalidated.data !== true) {
    return json({ error: "link_invalid_or_expired" }, 404, false);
  }
  try {
    await recordExportAccess(
      admin,
      tokenHash,
      "artifact_link_issued",
      accessId,
      verifiedManifest,
      artifact,
    );
  } catch {
    return json({ error: "download_audit_failed" }, 503, false);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: signed.data.signedUrl,
      "Cache-Control": "no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
    },
  });
}

Deno.serve(withAllowedOrigin(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    return json({ error: "server_misconfigured" }, 500);
  }
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  if (request.method === "GET") {
    return brokerDownload(
      request,
      admin,
      new URL(request.url).searchParams.get("token") ?? "",
    );
  }
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body: ExportRequestBody;
  try {
    body = await request.json() as ExportRequestBody;
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const authorization = request.headers.get("Authorization");
  if (
    body.action === "continue" &&
    authorization === `Bearer ${serviceKey}` &&
    validUuid(body.request_id) &&
    validUuid(body.generation) &&
    validUuid(body.worker_token)
  ) {
    scheduleExport(
      admin,
      url,
      serviceKey,
      body.request_id,
      body.generation,
      body.worker_token,
    );
    return json({ accepted: true }, 202);
  }
  if (!authorization) return json({ error: "unauthenticated" }, 401);
  if (
    !validUuid(body.request_id) ||
    !["build", "download"].includes(body.action ?? "")
  ) {
    return json({ error: "invalid_request" }, 400);
  }

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const identity = await caller.auth.getUser();
  if (identity.error || !identity.data.user) {
    return json({ error: "unauthenticated" }, 401);
  }
  const authorized = await caller.rpc("authorize_organization_export_action", {
    p_request_id: body.request_id,
    p_action: body.action,
  });
  if (authorized.error || authorized.data !== true) {
    return json({
      error: authorized.error?.message.includes("fresh_authentication_required")
        ? "reauthentication_required"
        : "authorization_failed",
    }, 403);
  }

  const requestRow = await admin.from("organization_offboarding_requests")
    .select("id,org_id,status,export_object_path")
    .eq("id", body.request_id)
    .maybeSingle();
  if (requestRow.error) return json({ error: "request_lookup_failed" }, 500);
  if (!requestRow.data) return json({ error: "request_unknown" }, 404);

  if (body.action === "build") {
    try {
      return json(
        await startExport(admin, url, serviceKey, body.request_id),
        202,
      );
    } catch (error) {
      console.error("tenant export start failed", safeErrorCode(error));
      return json({ error: "export_build_failed" }, 500);
    }
  }

  const randomToken = new Uint8Array(32);
  crypto.getRandomValues(randomToken);
  const token = btoa(String.fromCharCode(...randomToken))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const tokenHash = bytesToHex(sha256(encoder.encode(token)));
  const expiresAt = new Date(Date.now() + LINK_SECONDS * 1000).toISOString();
  const recorded = await admin.rpc("service_issue_organization_export_link", {
    p_request_id: body.request_id,
    p_actor_id: identity.data.user.id,
    p_token_hash: tokenHash,
    p_expires_at: expiresAt,
  });
  if (recorded.error) return json({ error: "signed_link_audit_failed" }, 500);
  const accessId = crypto.randomUUID();
  return json({
    signed_url: `${url}/functions/v1/tenant-export?token=${
      encodeURIComponent(token)
    }&access=${encodeURIComponent(accessId)}`,
    expires_at: expiresAt,
  });
}));

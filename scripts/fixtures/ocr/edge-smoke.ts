import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { handler as interpretDocument } from "../../../supabase/functions/interpret-document/index.ts";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing OCR acceptance environment: ${name}`);
  return value;
}

const apiUrl = required("OCR_ACCEPTANCE_API_URL").replace(/\/+$/, "");
const anonKey = required("OCR_ACCEPTANCE_ANON_KEY");
const serviceRoleKey = required("OCR_ACCEPTANCE_SERVICE_ROLE_KEY");
const workerToken = required("OCR_ACCEPTANCE_WORKER_TOKEN");

if (apiUrl !== "http://127.0.0.1:55431") {
  throw new Error(`Refusing non-local Supabase URL: ${apiUrl}`);
}
if (workerToken.length < 32) {
  throw new Error("OCR acceptance worker token is too short");
}

const clientOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
};
const admin = createClient(apiUrl, serviceRoleKey, clientOptions);
const user = createClient(apiUrl, anonKey, clientOptions);
let storageObjectPath: string | null = null;

function randomId(): string {
  return crypto.randomUUID();
}

type QueryResult<T> = { data: T | null; error: { message: string } | null };

async function ok(
  label: string,
  promise: PromiseLike<QueryResult<unknown>>,
): Promise<void> {
  const result = await promise;
  assert.equal(
    result.error,
    null,
    `${label}: ${result.error?.message ?? "unknown error"}`,
  );
}

async function must<T>(
  label: string,
  promise: PromiseLike<QueryResult<T>>,
): Promise<T> {
  const result = await promise;
  assert.equal(
    result.error,
    null,
    `${label}: ${result.error?.message ?? "unknown error"}`,
  );
  if (result.data === null) throw new Error(`${label}: query returned no data`);
  return result.data;
}

async function invokeFunction(
  name: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  const response = await fetch(`${apiUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, unknown>;
  return { response, payload };
}

function extractionPayload() {
  return {
    schema_version: "1",
    document: {
      page_count: 1,
      detected_languages: ["he", "en"],
      plain_text: "מחירון ספק\nSKU-001 מוצר בדיקה 31.90",
      partial: false,
    },
    blocks: [{
      id: "block-price-row",
      page: 1,
      type: "table",
      bbox: [0.05, 0.1, 0.95, 0.3],
      text: "SKU-001 מוצר בדיקה 31.90",
      confidence: 0.98,
    }],
    tables: [{
      id: "table-prices",
      page: 1,
      bbox: [0.05, 0.1, 0.95, 0.4],
      rows: [[
        { text: "SKU-001", bbox: null },
        { text: "מוצר בדיקה", bbox: null },
        { text: "31.90", bbox: null },
      ]],
    }],
    marks: [],
    // Required from gateway contract version 3 onward. A spreadsheet-shaped price list has no
    // text layer to lay out backwards, so the honest value is the empty array: no corrector ran.
    normalizations: [],
  };
}

function providerResponse(supplierId: string) {
  const interpretation = {
    schema_version: "1",
    document_type: "price_list",
    document_type_confidence: 0.99,
    supplier: {
      suggested_id: supplierId,
      suggested_name: "OCR acceptance supplier",
      confidence: 0.99,
      evidence_block_ids: ["block-price-row"],
    },
    fields: [],
    line_items: [{
      source_row: 1,
      values: [
        { key: "sku", value: "SKU-001" },
        { key: "description", value: "מוצר בדיקה" },
        { key: "price", value: 31.9 },
      ],
      evidence_block_ids: ["block-price-row"],
    }],
    suggested_annotations: [],
  };
  return {
    id: "resp_ocr_acceptance",
    // Dated snapshot on purpose: the handler must accept the alias prefix, not exact equality.
    model: "gpt-5.6-terra-2026-06-01",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(interpretation) }],
    }],
    usage: {
      input_tokens: 50,
      output_tokens: 25,
      total_tokens: 75,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

async function removeStorageFixture(): Promise<void> {
  if (!storageObjectPath) return;
  const path = storageObjectPath;
  const separator = path.lastIndexOf("/");
  const folder = path.slice(0, separator);
  const fileName = path.slice(separator + 1);
  const removed = await admin.storage.from("documents").remove([path]);
  assert.equal(
    removed.error,
    null,
    `remove Edge Storage fixture: ${removed.error?.message ?? "unknown error"}`,
  );
  const listed = await admin.storage.from("documents").list(folder, {
    limit: 100,
    search: fileName,
  });
  assert.equal(
    listed.error,
    null,
    `verify Edge Storage cleanup: ${listed.error?.message ?? "unknown error"}`,
  );
  assert.equal(
    (listed.data ?? []).some((item) => item.name === fileName),
    false,
    "Edge Storage fixture still exists after cleanup",
  );
}

async function main() {
  const orgId = randomId();
  const supplierId = randomId();
  const productId = randomId();
  const supplierProductId = randomId();
  const email = `ocr-acceptance-${randomId()}@example.test`;
  const password = `Ocr-${randomId()}-Aa7!`;

  await ok(
    "create organization",
    admin.from("organizations").insert({
      id: orgId,
      name: "OCR local Edge acceptance",
      status: "active",
    }),
  );
  await ok(
    "create supplier",
    admin.from("suppliers").insert({
      id: supplierId,
      org_id: orgId,
      name: "OCR acceptance supplier",
      status: "active",
    }),
  );
  await ok(
    "create product",
    admin.from("products").insert({
      id: productId,
      org_id: orgId,
      name: "OCR acceptance product",
      sku: "SKU-001",
      unit: "unit",
      active: true,
    }),
  );
  await ok(
    "create supplier price",
    admin.from("supplier_products").insert({
      id: supplierProductId,
      org_id: orgId,
      supplier_id: supplierId,
      product_id: productId,
      current_price: 10,
      price_effective_date: "2026-06-01",
      available: true,
    }),
  );

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.equal(
    created.error,
    null,
    `create auth user: ${created.error?.message ?? "unknown error"}`,
  );
  const actorId = created.data.user?.id;
  assert.ok(actorId, "create auth user returned no id");
  await ok(
    "create owner profile",
    admin.from("profiles").insert({
      id: actorId,
      org_id: orgId,
      full_name: "OCR acceptance owner",
      role: "owner",
      active: true,
    }),
  );

  const signedIn = await user.auth.signInWithPassword({ email, password });
  assert.equal(
    signedIn.error,
    null,
    `sign in: ${signedIn.error?.message ?? "unknown error"}`,
  );
  const accessToken = signedIn.data.session?.access_token;
  assert.ok(accessToken, "sign in returned no access token");

  const reservation = await must<Record<string, string>>(
    "reserve supplier price document",
    user.rpc("reserve_supplier_price_document_upload", {
      p_supplier_id: supplierId,
      p_file_name: "prices.png",
      p_mime_type: "image/png",
    }),
  );
  const documentId = reservation.document_id;
  storageObjectPath = reservation.storage_path;
  const storagePath = storageObjectPath;
  assert.match(documentId, /^[0-9a-f-]{36}$/i);
  assert.equal(
    storagePath.startsWith(`${orgId}/supplier/${supplierId}/${documentId}/`),
    true,
  );

  const pngBytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ),
    (character) => character.charCodeAt(0),
  );
  await ok(
    "upload source document",
    user.storage.from("documents").upload(
      storagePath,
      pngBytes,
      { contentType: "image/png", upsert: false },
    ),
  );
  const registration = await must<Record<string, unknown>>(
    "register supplier price document",
    user.rpc("register_supplier_price_document", { p_document_id: documentId }),
  );
  const jobId = String(registration.job_id);
  assert.equal(registration.document_id, documentId);
  assert.equal(registration.idempotent, false);

  const wrongToken = await invokeFunction("document-processing", {
    action: "claim",
    lease_owner: "ocr-acceptance-worker",
    lease_seconds: 120,
  }, { "x-ocr-worker-token": `${workerToken}-wrong` });
  assert.equal(wrongToken.response.status, 401);
  assert.equal(
    (wrongToken.payload.error as Record<string, unknown>)?.code,
    "invalid_worker_token",
  );

  const claimed = await invokeFunction("document-processing", {
    action: "claim",
    lease_owner: "ocr-acceptance-worker",
    lease_seconds: 120,
  }, { "x-ocr-worker-token": workerToken });
  assert.equal(claimed.response.status, 200, JSON.stringify(claimed.payload));
  const claimData = claimed.payload.data as Record<string, unknown>;
  assert.equal(claimData.job_id, jobId, "worker claimed an unexpected job");
  assert.match(String(claimData.processing_attempt_id), /^[0-9a-f-]{36}$/i);
  assert.equal("org_id" in claimData, false, "worker response exposed org_id");
  assert.equal(
    "storage_path" in claimData,
    false,
    "worker response exposed storage_path",
  );
  const signedDownload = new URL(String(claimData.download_url));
  const hostDownload = new URL(
    `${signedDownload.pathname}${signedDownload.search}`,
    apiUrl,
  );
  const downloaded = await fetch(hostDownload);
  assert.equal(downloaded.status, 200, "signed worker download failed");
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), pngBytes);

  const acknowledged = await invokeFunction("document-processing", {
    action: "ack_download",
    job_id: jobId,
    lease_owner: "ocr-acceptance-worker",
    download_lease_id: claimData.download_lease_id,
    download_lease_token: claimData.download_lease_token,
    lease_seconds: 120,
  }, { "x-ocr-worker-token": workerToken });
  assert.equal(
    acknowledged.response.status,
    200,
    JSON.stringify(acknowledged.payload),
  );
  assert.equal(
    (acknowledged.payload.data as Record<string, unknown>)?.job_id,
    jobId,
  );

  const completed = await invokeFunction("document-processing", {
    action: "complete",
    job_id: jobId,
    processing_attempt_id: claimData.processing_attempt_id,
    lease_owner: "ocr-acceptance-worker",
    download_lease_id: claimData.download_lease_id,
    download_lease_token: claimData.download_lease_token,
    engine: "fixture-engine",
    model: "fixture-model",
    model_version: "sha256:fixture",
    input_checksum: claimData.input_checksum,
    contract_version: "1",
    payload: extractionPayload(),
    duration_ms: 5,
    resource_metadata: { fixture: true },
  }, { "x-ocr-worker-token": workerToken });
  assert.equal(
    completed.response.status,
    200,
    JSON.stringify(completed.payload),
  );
  assert.ok((completed.payload.data as Record<string, unknown>)?.extraction_id);
  assert.equal(
    (completed.payload.data as Record<string, unknown>)?.business_applied,
    true,
  );

  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  let providerRequestText = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "https://api.openai.com/v1/responses") {
      return await originalFetch(input, init);
    }
    providerCalls += 1;
    providerRequestText = String(init?.body ?? "");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${required("OPENAI_API_KEY")}`,
    );
    return new Response(JSON.stringify(providerResponse(supplierId)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  let interpreted: Response;
  try {
    interpreted = await interpretDocument(
      new Request(
        "http://127.0.0.1/functions/v1/interpret-document",
        {
          method: "POST",
          headers: {
            apikey: anonKey,
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            origin: "http://127.0.0.1:5199",
          },
          body: JSON.stringify({ jobId }),
        },
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const interpretationResult = await interpreted.json() as Record<
    string,
    unknown
  >;
  assert.equal(interpreted.status, 200, JSON.stringify(interpretationResult));
  assert.equal(
    providerCalls,
    1,
    "interpret handler did not call the focused provider mock exactly once",
  );
  for (
    const forbidden of [
      storagePath,
      "download_url",
      "storage_path",
      "base64",
      "JVBERi0",
    ]
  ) {
    assert.equal(
      providerRequestText.includes(forbidden),
      false,
      `provider payload leaked ${forbidden}`,
    );
  }
  const interpretationId = String(interpretationResult.interpretationId);
  assert.match(interpretationId, /^[0-9a-f-]{36}$/i);
  assert.equal(interpretationResult.status, "review");

  const confirmBody = {
    mode: "confirm",
    documentId,
    interpretationId,
    targetMonth: "2026-07-01",
    approvedRows: [{
      lineItemIndex: 0,
      productId,
      priceText: "31.90",
      available: true,
    }],
    reason: "OCR local Edge acceptance",
  };
  const confirmed = await invokeFunction("submit-price-list", confirmBody, {
    apikey: anonKey,
    authorization: `Bearer ${accessToken}`,
  });
  assert.equal(
    confirmed.response.status,
    200,
    JSON.stringify(confirmed.payload),
  );
  assert.equal(confirmed.payload.submission_id, interpretationId);
  assert.equal(confirmed.payload.accepted_count, 1);
  assert.equal(confirmed.payload.rejected_count, 0);

  const retry = await invokeFunction("submit-price-list", confirmBody, {
    apikey: anonKey,
    authorization: `Bearer ${accessToken}`,
  });
  assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
  assert.equal(retry.payload.submission_id, interpretationId);
  assert.equal(retry.payload.idempotent, true);

  const price = await must<{ current_price: number }>(
    "read confirmed supplier price",
    admin.from("supplier_products").select("current_price").eq(
      "id",
      supplierProductId,
    ).single(),
  );
  assert.equal(Number(price.current_price), 31.9);
  const productCount = await admin.from("products").select("id", {
    count: "exact",
    head: true,
  })
    .eq("org_id", orgId);
  assert.equal(productCount.error, null);
  assert.equal(
    productCount.count,
    1,
    "OCR confirmation created an unknown product",
  );
  const job = await must<{ status: string }>(
    "read completed document job",
    admin.from("document_processing_jobs").select("status").eq("id", jobId)
      .single(),
  );
  assert.equal(job.status, "completed");

  return {
    result: "ocr_edge_acceptance_passed",
    document_processing_http: true,
    interpret_handler_provider_mock: true,
    price_confirm_http: true,
    retry_idempotent: true,
    single_writer_product_count: productCount.count,
    storage_cleanup: true,
  };
}

let result: Record<string, unknown> | null = null;
let runError: unknown = null;
let cleanupError: unknown = null;
try {
  result = await main();
} catch (error) {
  runError = error;
}
try {
  await removeStorageFixture();
} catch (error) {
  cleanupError = error;
}
if (runError) {
  if (cleanupError) {
    console.error(`Edge Storage cleanup also failed: ${String(cleanupError)}`);
  }
  throw runError;
}
if (cleanupError) throw cleanupError;
assert.ok(result, "OCR Edge acceptance returned no result");
console.log(JSON.stringify(result));

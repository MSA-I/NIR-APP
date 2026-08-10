import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "jsr:@std/assert@1";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function section(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0, `missing source marker: ${start}`);
  assert(endIndex > startIndex, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertOrder(value: string, ...needles: string[]): void {
  let cursor = -1;
  for (const needle of needles) {
    const next = value.indexOf(needle, cursor + 1);
    assert(next > cursor, `missing or out-of-order source marker: ${needle}`);
    cursor = next;
  }
}

Deno.test("snapshot completion is required before any export part claim", () => {
  assertStringIncludes(source, "const SNAPSHOT_ROWS_PER_BATCH = 50;");
  assertStringIncludes(source, "const SNAPSHOT_BYTES_PER_BATCH = 1024 * 1024;");
  const runBatch = section(
    "async function runExportBatch(",
    "function scheduleExport(",
  );
  assertOrder(
    runBatch,
    "await snapshotBeforeParts(",
    "if (!snapshotComplete",
    'admin.rpc("service_claim_organization_export_part"',
  );
  const snapshot = section(
    "async function snapshotBeforeParts(",
    "async function runExportBatch(",
  );
  assertStringIncludes(snapshot, "p_max_rows: SNAPSHOT_ROWS_PER_BATCH");
  assertStringIncludes(snapshot, "p_max_bytes: SNAPSHOT_BYTES_PER_BATCH");
  const receipt = section(
    "function snapshotBatchReceipt(",
    "function integer(",
  );
  assertStringIncludes(
    receipt,
    'receipt.all_snapshots_completed && receipt.status !== "completed"',
  );
  assertEquals(source.includes("claim.storage_objects"), false);
});

Deno.test("table snapshots stay row and byte bounded and serialize incrementally", () => {
  const tablePlan = section(
    "function tablePartPlan(",
    "async function snapshotRows(",
  );
  assertStringIncludes(tablePlan, "limit > SNAPSHOT_ROWS_PER_BATCH");
  assertStringIncludes(tablePlan, "batchBytes > SNAPSHOT_BYTES_PER_BATCH");
  assertStringIncludes(tablePlan, "batchBytes > 26 * 1024 * 1024");
  const parts = section("async function partChunks(", "function partPath(");
  assertStringIncludes(
    parts,
    "for (let index = 0; index < rows.length; index += 1)",
  );
  assertStringIncludes(
    parts,
    "yield* textChunks(JSON.stringify(rows[index], null, 2))",
  );
  assertStringIncludes(
    parts,
    "for (const row of rows) yield* textChunks(csvRow(plan.columns, row))",
  );
  assertEquals(parts.includes("rows.map"), false);
  const auth = section(
    "async function authAccountBytes(",
    "async function partChunks(",
  );
  assertStringIncludes(auth, "userIds.length > SNAPSHOT_ROWS_PER_BATCH");
});

Deno.test("broker verifies root and page evidence before returning bounded indexes", () => {
  const readRoot = section(
    "async function readManifest(",
    "async function readManifestPage(",
  );
  assertOrder(
    readRoot,
    "download(path)",
    "downloaded.data.size !== expectedSizeBytes",
    "sha256(bytes)",
    "manifestSha256 !== expectedSha256",
    "assertExportManifest(",
  );
  const readPage = section(
    "async function readManifestPage(",
    "function brokerArtifactUrl(",
  );
  assertOrder(
    readPage,
    "descriptor.path",
    "downloaded.data.size !== descriptor.size_bytes",
    "sha256(bytes)",
    "descriptor.sha256",
    "assertExportManifestPage(",
  );
  const broker = section("async function brokerDownload(", "Deno.serve(");
  assertOrder(
    broker,
    'admin.rpc("service_resolve_organization_export_link"',
    "verifiedManifest = await readManifest(",
    "const manifest = verifiedManifest.manifest",
  );
  assertEquals(broker.includes("manifest.artifacts"), false);
  assertMatch(broker, /pages:\s*manifest\.pages\.map/u);
  assertMatch(broker, /verifiedPage\?\.page\.artifacts\s*\?\?\s*\[\]/u);
});

Deno.test("access audit is fail closed and follows response preparation", () => {
  const broker = section("async function brokerDownload(", "Deno.serve(");
  assertMatch(
    broker,
    /const accessId = requestUrl\.searchParams\.get\("access"\);[\s\S]*!validUuid\(accessId\)/u,
  );
  assertOrder(
    broker,
    'contract: "supplyflow_export_download_root_v2"',
    '"manifest_downloaded"',
    "return response;",
  );
  assertOrder(
    broker,
    "verifiedPage = await readManifestPage(",
    "const response = wantsJson",
    "const pageAccessKind: ExportAccessKind = wantsJson",
    '? "manifest_page_downloaded"',
    ': "portal_opened"',
    "pageAccessArtifact = wantsJson",
    "verifiedPage?.descriptor",
    "await recordExportAccess(",
    "pageAccessKind",
    "pageAccessArtifact",
    "return response;",
  );
  const record = section(
    "async function recordExportAccess(",
    "async function resolveExportArtifact(",
  );
  assertStringIncludes(source, '| "manifest_page_downloaded"');
  assertOrder(
    record,
    'accessKind === "manifest_page_downloaded"',
    'accessKind === "artifact_link_issued"',
    "requiresArtifact !== (artifact !== null)",
    'admin.rpc("service_record_organization_export_access"',
  );
  assertStringIncludes(record, 'accessKind === "portal_opened"');
  assertStringIncludes(record, 'accessKind === "artifact_link_issued"');
  assertStringIncludes(record, '"portal_open_count"');
  assertStringIncludes(record, '"download_count"');
  assertStringIncludes(record, '"artifact_link_issued_count"');
  assertStringIncludes(record, "exactRecord(result.data, keys)");
});

Deno.test("artifact redirect requires page membership, DB resolution, revalidation and audit", () => {
  const broker = section("async function brokerDownload(", "Deno.serve(");
  assertOrder(
    broker,
    "const pageArtifact = verifiedPage.page.artifacts.find",
    "artifact = await resolveExportArtifact(",
    ".createSignedUrl(artifact.path",
    '"service_revalidate_organization_export_link"',
    '"artifact_link_issued"',
    "status: 302",
  );
  assertStringIncludes(
    broker,
    'return json({ error: "download_audit_failed" }, 503',
  );
});

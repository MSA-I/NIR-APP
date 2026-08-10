import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertExportManifest,
  assertExportManifestPage,
  csvCell,
  csvRow,
  htmlEscape,
  safeArchivePath,
} from "./core.ts";

Deno.test("CSV escaping preserves Hebrew, commas, quotes and JSON values", () => {
  assertEquals(csvCell("ספק, צפון"), '"ספק, צפון"');
  assertEquals(csvCell('a"b'), '"a""b"');
  assertEquals(csvCell({ status: "פעיל" }), '"{""status"":""פעיל""}"');
  assertEquals(csvCell("=1+1"), "'=1+1");
  assertEquals(csvCell(-42), "-42");
  assertEquals(
    csvRow(["name", "amount"], { name: "ספק, צפון", amount: 42 }),
    '"ספק, צפון",42\r\n',
  );
});

Deno.test("archive paths cannot escape the export root", () => {
  assertEquals(
    safeArchivePath("original-files/documents/org/file.pdf"),
    "original-files/documents/org/file.pdf",
  );
  assertThrows(
    () => safeArchivePath("../secret"),
    Error,
    "unsafe_archive_path",
  );
  assertThrows(() => safeArchivePath("a//b"), Error, "unsafe_archive_path");
});

Deno.test("download portal escapes artifact names and tokenized links", () => {
  assertEquals(
    htmlEscape(`מסמך <script>alert('x')</script>?a=1&b="2"`),
    "מסמך &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;?a=1&amp;b=&quot;2&quot;",
  );
});

Deno.test("paged artifact manifest and its page are complete and scoped", () => {
  const requestId = "10000000-0000-4000-8000-000000000001";
  const generation = "20000000-0000-4000-8000-000000000002";
  const root =
    `30000000-0000-4000-8000-000000000003/offboarding/${requestId}/${generation}/parts/`;
  const artifact = {
    name: "data/suppliers/json/part-1.json",
    path: `${root}40000000-0000-4000-8000-000000000004.part`,
    sha256: "a".repeat(64),
    size_bytes: 42,
    mime_type: "application/json",
  };
  const page = {
    schema_version: 1,
    contract: "artifact_index_page_v1",
    page_index: 0,
    artifact_count: 1,
    artifacts: [artifact],
  };
  const manifest = {
    schema_version: 1,
    contract: "paged_artifact_index_v1",
    request_id: requestId,
    generation,
    created_at: "2026-08-09T12:00:00Z",
    artifact_count: 1,
    page_count: 1,
    indexed_file_count: 2,
    indexed_size_bytes: 84,
    artifact_fields: ["name", "path", "sha256", "size_bytes", "mime_type"],
    pages: [{
      page_index: 0,
      name: "manifest-pages/page-1.json",
      path: `${root}50000000-0000-4000-8000-000000000005.part`,
      sha256: "b".repeat(64),
      size_bytes: 42,
      mime_type: "application/json",
      artifact_count: 1,
    }],
  };
  assertExportManifest(manifest, requestId, generation, root);
  assertExportManifestPage(page, 0, root);
  assertEquals(manifest.pages.length, 1);
  assertEquals(page.artifacts.length, 1);
});

Deno.test("paged manifest rejects cross-root, traversal, nested and non-UUID part paths", () => {
  const requestId = "10000000-0000-4000-8000-000000000001";
  const generation = "20000000-0000-4000-8000-000000000002";
  const root =
    `30000000-0000-4000-8000-000000000003/offboarding/${requestId}/${generation}/parts/`;
  const page = {
    page_index: 0,
    name: "manifest-pages/page-1.json",
    path: `${root}50000000-0000-4000-8000-000000000005.part`,
    sha256: "b".repeat(64),
    size_bytes: 42,
    mime_type: "application/json",
    artifact_count: 1,
  };
  const base = {
    schema_version: 1,
    contract: "paged_artifact_index_v1",
    request_id: requestId,
    generation,
    created_at: "2026-08-09T12:00:00Z",
    artifact_count: 1,
    page_count: 1,
    indexed_file_count: 2,
    indexed_size_bytes: 84,
    artifact_fields: ["name", "path", "sha256", "size_bytes", "mime_type"],
    pages: [page],
  };
  for (
    const path of [
      `other/${page.path}`,
      `${root}../50000000-0000-4000-8000-000000000005.part`,
      `${root}nested/50000000-0000-4000-8000-000000000005.part`,
      `${root}not-a-uuid.part`,
    ]
  ) {
    assertThrows(
      () =>
        assertExportManifest(
          { ...base, pages: [{ ...page, path }] },
          requestId,
          generation,
          root,
        ),
      Error,
      "export_manifest_page_invalid",
    );
  }
});

Deno.test("manifest page rejects duplicate and incomplete artifact descriptors", () => {
  const root =
    "30000000-0000-4000-8000-000000000003/offboarding/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000002/parts/";
  const artifact = {
    name: "data/suppliers/json/part-1.json",
    path: `${root}40000000-0000-4000-8000-000000000004.part`,
    sha256: "a".repeat(64),
    size_bytes: 42,
    mime_type: "application/json",
  };
  const page = {
    schema_version: 1,
    contract: "artifact_index_page_v1",
    page_index: 0,
    artifact_count: 1,
    artifacts: [artifact],
  };
  assertThrows(
    () =>
      assertExportManifestPage(
        { ...page, artifact_count: 2, artifacts: [artifact, artifact] },
        0,
        root,
      ),
    Error,
    "export_manifest_duplicate",
  );
  assertThrows(
    () =>
      assertExportManifestPage(
        { ...page, artifacts: [{ ...artifact, mime_type: undefined }] },
        0,
        root,
      ),
    Error,
    "export_manifest_artifact_invalid",
  );
});

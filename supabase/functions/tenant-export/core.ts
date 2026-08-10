export interface ManifestArtifact {
  name: string;
  path: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
}

export interface ManifestPageSummary extends ManifestArtifact {
  page_index: number;
  artifact_count: number;
}

export interface ExportManifestPage {
  schema_version: number;
  contract: "artifact_index_page_v1";
  page_index: number;
  artifact_count: number;
  artifacts: ManifestArtifact[];
}

export interface ExportManifest {
  schema_version: number;
  contract: "paged_artifact_index_v1";
  request_id: string;
  generation: string;
  created_at: string;
  artifact_count: number;
  page_count: number;
  indexed_file_count: number;
  indexed_size_bytes: number;
  artifact_fields: string[];
  pages: ManifestPageSummary[];
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join("\u0000") ===
      [...keys].sort().join("\u0000");
}

function artifactValid(
  artifact: Partial<ManifestArtifact>,
  artifactRoot: string,
): artifact is ManifestArtifact {
  const pathSuffix = typeof artifact.path === "string" &&
      artifact.path.startsWith(artifactRoot)
    ? artifact.path.slice(artifactRoot.length)
    : "";
  return typeof artifact.name === "string" &&
    typeof artifact.path === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/iu
      .test(pathSuffix) &&
    /^[0-9a-f]{64}$/u.test(artifact.sha256 ?? "") &&
    Number.isSafeInteger(artifact.size_bytes) &&
    Number(artifact.size_bytes) >= 0 &&
    ["application/json", "text/csv", "application/octet-stream"].includes(
      artifact.mime_type ?? "",
    );
}

/** Prevent ZIP-slip and control-character filenames even if a legacy storage path is malformed. */
export function safeArchivePath(value: string): string {
  const segments = value.replaceAll("\\", "/").split("/");
  if (
    value.startsWith("/") ||
    segments.some((segment) =>
      !segment || segment === "." || segment === ".."
    ) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("unsafe_archive_path");
  }
  return segments.map((segment) =>
    encodeURIComponent(segment).replaceAll("%20", " ")
  ).join("/");
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Spreadsheet applications execute leading =,+,-,@,TAB and CR in string cells. Prefix an
  // apostrophe without changing real numeric values, so a supplier-controlled description can
  // never become a formula when the owner opens the CSV.
  const text = typeof value === "string" && /^[=+\-@\t\r]/u.test(raw)
    ? `'${raw}`
    : raw;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(
  columns: readonly string[],
  row: Record<string, unknown>,
): string {
  return `${columns.map((column) => csvCell(row[column])).join(",")}\r\n`;
}

export function htmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function assertExportManifest(
  value: Record<string, unknown>,
  requestId: string,
  generation: string,
  artifactRoot: string,
): asserts value is Record<string, unknown> & ExportManifest {
  if (
    !exactObject(value, [
      "schema_version",
      "contract",
      "request_id",
      "generation",
      "created_at",
      "artifact_count",
      "page_count",
      "indexed_file_count",
      "indexed_size_bytes",
      "artifact_fields",
      "pages",
    ]) ||
    value.schema_version !== 1 ||
    value.contract !== "paged_artifact_index_v1" ||
    value.request_id !== requestId ||
    value.generation !== generation ||
    typeof value.created_at !== "string" ||
    Number.isNaN(Date.parse(value.created_at)) ||
    !Number.isSafeInteger(value.artifact_count) ||
    Number(value.artifact_count) < 0 ||
    Number(value.artifact_count) > 100_000 ||
    !Number.isSafeInteger(value.page_count) ||
    Number(value.page_count) < 0 || Number(value.page_count) > 1_000 ||
    !Number.isSafeInteger(value.indexed_file_count) ||
    value.indexed_file_count !==
      Number(value.artifact_count) + Number(value.page_count) ||
    !Number.isSafeInteger(value.indexed_size_bytes) ||
    Number(value.indexed_size_bytes) < 0 ||
    !Array.isArray(value.artifact_fields) ||
    value.artifact_fields.join(",") !==
      "name,path,sha256,size_bytes,mime_type" ||
    !Array.isArray(value.pages) ||
    value.pages.length !== value.page_count ||
    !artifactRoot.endsWith("/parts/")
  ) throw new Error("export_manifest_invalid");

  const paths = new Set<string>();
  const names = new Set<string>();
  let artifactCount = 0;
  for (let index = 0; index < value.pages.length; index += 1) {
    const item = value.pages[index];
    if (
      !exactObject(item, [
        "page_index",
        "name",
        "path",
        "sha256",
        "size_bytes",
        "mime_type",
        "artifact_count",
      ])
    ) throw new Error("export_manifest_page_invalid");
    const page = item as unknown as ManifestPageSummary;
    if (
      !artifactValid(page, artifactRoot) ||
      page.mime_type !== "application/json" ||
      page.page_index !== index ||
      page.name !== `manifest-pages/page-${index + 1}.json` ||
      !Number.isSafeInteger(page.artifact_count) || page.artifact_count < 1 ||
      page.artifact_count > 100
    ) throw new Error("export_manifest_page_invalid");
    safeArchivePath(page.name);
    if (paths.has(page.path) || names.has(page.name)) {
      throw new Error("export_manifest_duplicate");
    }
    paths.add(page.path);
    names.add(page.name);
    artifactCount += page.artifact_count;
  }
  if (artifactCount !== value.artifact_count) {
    throw new Error("export_manifest_invalid");
  }
}

export function assertExportManifestPage(
  value: Record<string, unknown>,
  expectedPageIndex: number,
  artifactRoot: string,
): asserts value is Record<string, unknown> & ExportManifestPage {
  if (
    !exactObject(value, [
      "schema_version",
      "contract",
      "page_index",
      "artifact_count",
      "artifacts",
    ]) ||
    value.schema_version !== 1 || value.contract !== "artifact_index_page_v1" ||
    value.page_index !== expectedPageIndex ||
    !Number.isSafeInteger(value.artifact_count) ||
    Number(value.artifact_count) < 1 || Number(value.artifact_count) > 100 ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== value.artifact_count ||
    !artifactRoot.endsWith("/parts/")
  ) throw new Error("export_manifest_page_invalid");
  const paths = new Set<string>();
  const names = new Set<string>();
  for (const item of value.artifacts) {
    if (
      !exactObject(item, ["name", "path", "sha256", "size_bytes", "mime_type"])
    ) {
      throw new Error("export_manifest_artifact_invalid");
    }
    const artifact = item as unknown as ManifestArtifact;
    if (!artifactValid(artifact, artifactRoot)) {
      throw new Error("export_manifest_artifact_invalid");
    }
    safeArchivePath(artifact.name);
    if (paths.has(artifact.path) || names.has(artifact.name)) {
      throw new Error("export_manifest_duplicate");
    }
    paths.add(artifact.path);
    names.add(artifact.name);
  }
}

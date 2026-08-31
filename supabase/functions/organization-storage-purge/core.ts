/**
 * organization-storage-purge — the part that has no network in it.
 *
 * The whole reason this function exists is a measured fact about the database: a tenant's files
 * are NOT in it. `storage.objects` carries no `org_id`, so the staged tenant teardown (0196) has
 * never listed it, and Supabase's own `storage.protect_delete()` refuses a direct SQL DELETE on
 * that table outright — `Direct deletion from storage tables is not allowed. Use the Storage API
 * instead.` Even past that trigger the row is only an index: the bytes live in the storage
 * backend, where deleting the row orphans them rather than removing them.
 *
 * So the deletion has to be an API call, and the only question left is which paths. That answer
 * comes from the database — `public.platform_organization_storage_objects(uuid)` (0254), which is
 * `storage.objects` itself, gated behind the same Platform Admin + `offboarding.handle` pair the
 * purge candidate list requires. Enumerating with the Storage API's own `list()` would mean
 * walking one directory level at a time and hoping nothing was missed; the index cannot miss.
 */

/** One object to remove, exactly as the enumerator returns it. */
export interface StorageObjectRow {
  bucket: string;
  object_name: string;
}

/** What was removed from one bucket, and what refused. */
export interface BucketOutcome {
  bucket: string;
  requested: number;
  removed: number;
  failed: string[];
}

/**
 * `remove()` takes a list of paths in ONE bucket, so the work is grouped by bucket first. Order
 * is stable (bucket name, then path) so two runs over the same tenant produce comparable output;
 * a purge report that reshuffles itself is a purge report nobody can diff.
 */
export function groupByBucket(rows: readonly StorageObjectRow[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const paths = grouped.get(row.bucket);
    if (paths) paths.push(row.object_name);
    else grouped.set(row.bucket, [row.object_name]);
  }
  for (const paths of grouped.values()) paths.sort();
  return new Map([...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The Storage API takes a bounded list per call. A tenant that used the product for two years
 * holds far more than one call's worth, and a purge that silently removed only the first page
 * would leave the rest behind while reporting success — the exact failure shape §66 is about.
 */
export const REMOVE_BATCH_SIZE = 100;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A path must sit under the tenant's own prefix. The enumerator already filters on it, but this
 * function is what actually issues deletions, so it refuses to delete anything it cannot prove
 * belongs to the target — a purge is irreversible and one wrong prefix is another tenant's data.
 */
export function isUnderTenantPrefix(orgId: string, path: string): boolean {
  return path.startsWith(`${orgId}/`);
}

export function foreignPaths(orgId: string, rows: readonly StorageObjectRow[]): string[] {
  return rows.filter((row) => !isUnderTenantPrefix(orgId, row.object_name))
    .map((row) => row.object_name);
}

/** True only when every bucket removed everything it was handed. */
export function isComplete(outcomes: readonly BucketOutcome[]): boolean {
  return outcomes.every((outcome) =>
    outcome.failed.length === 0 && outcome.removed === outcome.requested);
}

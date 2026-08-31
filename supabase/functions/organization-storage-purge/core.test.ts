/**
 * The three ways a storage purge lies about itself, asserted so they cannot happen quietly:
 * it deletes only the first page, it deletes a path belonging to somebody else, or it reports
 * success while the API removed less than it was handed.
 */
import { assert, assertEquals, assertFalse, assertThrows } from 'jsr:@std/assert@1';
import {
  type BucketOutcome,
  chunk,
  foreignPaths,
  groupByBucket,
  isComplete,
  isUnderTenantPrefix,
  REMOVE_BATCH_SIZE,
  type StorageObjectRow,
} from './core.ts';

const ORG = '75000000-0000-4000-8000-000000000031';
const OTHER = '75000000-0000-4000-8000-000000000032';

Deno.test('groupByBucket splits the work the way remove() takes it, in a stable order', () => {
  const rows: StorageObjectRow[] = [
    { bucket: 'documents', object_name: `${ORG}/b.pdf` },
    { bucket: 'feedback', object_name: `${ORG}/note.txt` },
    { bucket: 'documents', object_name: `${ORG}/a.pdf` },
  ];
  const grouped = groupByBucket(rows);
  assertEquals([...grouped.keys()], ['documents', 'feedback']);
  assertEquals(grouped.get('documents'), [`${ORG}/a.pdf`, `${ORG}/b.pdf`]);
  assertEquals(grouped.get('feedback'), [`${ORG}/note.txt`]);
});

Deno.test('groupByBucket of nothing is nothing, not one empty bucket', () => {
  assertEquals(groupByBucket([]).size, 0);
});

Deno.test('chunk covers every path exactly once, past one API call', () => {
  const paths = Array.from({ length: REMOVE_BATCH_SIZE * 2 + 7 }, (_, i) => `${ORG}/${i}.pdf`);
  const batches = chunk(paths, REMOVE_BATCH_SIZE);
  assertEquals(batches.length, 3);
  assertEquals(batches.flat().length, paths.length);
  assertEquals(new Set(batches.flat()).size, paths.length);
  assertEquals(batches.at(-1)?.length, 7);
});

Deno.test('chunk refuses a size that would loop forever', () => {
  assertThrows(() => chunk([1, 2, 3], 0), RangeError);
});

Deno.test('a path outside the tenant prefix is named, not deleted', () => {
  assert(isUnderTenantPrefix(ORG, `${ORG}/offboarding/manifest.json`));
  assertFalse(isUnderTenantPrefix(ORG, `${OTHER}/offboarding/manifest.json`));
  // A prefix that merely STARTS with the id is a different tenant, not this one.
  assertFalse(isUnderTenantPrefix(ORG, `${ORG}x/a.pdf`));
  assertEquals(
    foreignPaths(ORG, [
      { bucket: 'documents', object_name: `${ORG}/mine.pdf` },
      { bucket: 'documents', object_name: `${OTHER}/theirs.pdf` },
    ]),
    [`${OTHER}/theirs.pdf`],
  );
});

Deno.test('completeness counts what the API said it removed, not what it was asked to remove', () => {
  const full: BucketOutcome[] = [{ bucket: 'documents', requested: 2, removed: 2, failed: [] }];
  const short: BucketOutcome[] = [{ bucket: 'documents', requested: 2, removed: 1, failed: [] }];
  const refused: BucketOutcome[] = [
    { bucket: 'documents', requested: 2, removed: 2, failed: [`${ORG}/a.pdf`] },
  ];
  assert(isComplete(full));
  assertFalse(isComplete(short));
  assertFalse(isComplete(refused));
  // Nothing to delete is complete: a tenant that never uploaded a file is still fully purged.
  assert(isComplete([]));
});

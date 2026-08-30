/**
 * organization-storage-purge — removes one finished tenant's files, through the Storage API,
 * because SQL cannot.
 *
 * MEASURED, NOT ASSUMED (local stack, 30.08.2026). `storage.objects` has no `org_id` column and
 * lives outside `public`/`private`, so `private.tenant_delete_stages()` has never listed it and
 * `private.delete_tenant_rows()` never touched it. Supabase installs
 * `storage.protect_delete()` — a BEFORE DELETE trigger on `storage.objects` that raises
 * `Direct deletion from storage tables is not allowed. Use the Storage API instead.` unless
 * `storage.allow_delete_query` is `'true'`. And past that trigger the row is still only an index:
 * the backend held 1249 files against a handful of surviving rows on the same stack. A SQL DELETE
 * would orphan bytes, not delete them.
 *
 * WHAT MAKES THIS VERIFIABLE RATHER THAN HOPEFUL. Because the API is the only thing that can
 * empty a prefix, an empty prefix is PROOF the API ran. `public.execute_organization_purge_batch`
 * (0254) skips, by name, any tenant that still has objects under `{org_id}/` — so the database
 * cannot record a tenant as purged while its documents are still downloadable, and this function
 * is not trusted to have told the truth about its own work.
 *
 * ORDER. Approve the batch, run this for every organization in it, then execute the batch. The
 * tenant's own offboarding export lives in `tenant-exports/{org_id}/` and is removed here too:
 * it has been delivered, and a purge that leaves the export behind has not deleted the customer.
 *
 * AUTHORITY IS BORROWED, NOT INVENTED. Enumeration goes through
 * `public.platform_organization_storage_objects`, which requires the same Platform Admin plus
 * `offboarding.handle` pair the purge candidate list does, and it is called with the CALLER's
 * JWT. The service key is used for one thing only — the removals themselves, which no browser
 * role may perform.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  type BucketOutcome,
  chunk,
  foreignPaths,
  groupByBucket,
  isComplete,
  REMOVE_BATCH_SIZE,
  type StorageObjectRow,
} from './core.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-correlation-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type ErrorCode =
  | 'method_not_allowed'
  | 'server_misconfigured'
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_request'
  | 'enumeration_failed'
  | 'foreign_path'
  | 'purge_incomplete';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function fail(code: ErrorCode, message: string, status: number, detail?: unknown): Response {
  return json({ error: { code, message, detail } }, status);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail('method_not_allowed', 'POST בלבד', 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) {
    return fail('server_misconfigured', 'הפונקציה אינה מוגדרת כראוי', 500);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return fail('unauthenticated', 'נדרשת התחברות', 401);

  let body: { org_id?: unknown };
  try {
    body = (await req.json()) as { org_id?: unknown };
  } catch {
    return fail('invalid_request', 'גוף הבקשה אינו JSON תקין', 400);
  }
  const orgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
  if (!UUID.test(orgId)) return fail('invalid_request', 'org_id אינו מזהה תקין', 400);

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  // The two predicates are asked EXPLICITLY rather than being inferred from an empty result:
  // "you may not look" and "there is nothing there" are opposite answers and a purge report must
  // never confuse them.
  const [operator, capability] = await Promise.all([
    caller.rpc('is_platform_admin'),
    caller.rpc('platform_has_capability', { p_capability: 'offboarding.handle' }),
  ]);
  if (operator.error || capability.error) {
    return fail('unauthenticated', 'הסשן אינו תקף', 401,
      operator.error?.message ?? capability.error?.message);
  }
  if (operator.data !== true || capability.data !== true) {
    return fail('forbidden', 'הפעולה מותרת למנהל פלטפורמה עם הרשאת גריעה בלבד', 403);
  }

  const enumerated = await caller.rpc('platform_organization_storage_objects', {
    p_org_id: orgId,
  });
  if (enumerated.error) {
    return fail('enumeration_failed', 'קריאת רשימת הקבצים נכשלה', 500, enumerated.error.message);
  }
  const rows = (enumerated.data ?? []) as StorageObjectRow[];

  const foreign = foreignPaths(orgId, rows);
  if (foreign.length > 0) {
    return fail('foreign_path', 'נתיב שאינו של הארגון הגיע לרשימת המחיקה', 500,
      foreign.slice(0, 5));
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const outcomes: BucketOutcome[] = [];
  for (const [bucket, paths] of groupByBucket(rows)) {
    const outcome: BucketOutcome = {
      bucket,
      requested: paths.length,
      removed: 0,
      failed: [],
    };
    for (const batch of chunk(paths, REMOVE_BATCH_SIZE)) {
      const { data, error } = await admin.storage.from(bucket).remove(batch);
      if (error) {
        outcome.failed.push(...batch);
        continue;
      }
      const removed = new Set((data ?? []).map((entry) => entry.name));
      outcome.removed += removed.size;
      // `remove()` reports what it actually deleted. A path it did not report is not a path that
      // was removed, whatever the absence of an error suggests.
      outcome.failed.push(...batch.filter((path) => !removed.has(path)));
    }
    outcomes.push(outcome);
  }

  const complete = isComplete(outcomes);
  const result = {
    org_id: orgId,
    complete,
    buckets: outcomes,
    objects_requested: rows.length,
    objects_removed: outcomes.reduce((total, outcome) => total + outcome.removed, 0),
  };

  // A partial purge answers 409, not 200. The database will refuse the teardown for the same
  // reason a moment later, and the two refusals should agree rather than one of them being a
  // surprise.
  return complete ? json(result, 200) : fail(
    'purge_incomplete', 'לא כל הקבצים נמחקו — הגריעה תסורב עד שיושלמו', 409, result);
});

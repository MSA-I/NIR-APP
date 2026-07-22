/**
 * admin-provision — create a new tenant (organization + owner user).
 *
 * This is the FIRST and ONLY exception to "no middle tier" (docs/ARCHITECTURE.md:5).
 * The reason is narrow and specific: creating an auth user requires the Supabase
 * `service_role` key, that key bypasses every RLS policy in the database, and it therefore
 * must never be shipped to a browser. Everything else in SupplyFlow still goes straight from
 * the SPA to PostgREST under RLS.
 *
 * Because this function holds `service_role`, its own authorization check IS the security
 * boundary. It verifies the caller's JWT with the anon client and then requires a
 * `platform_admins` row before touching anything. A service_role function that trusts its
 * caller is a total compromise of every tenant, not a bug in one screen.
 *
 * Behavioural reference for user creation: scripts/create-users.ps1 (admin API,
 * email_confirm: true, password supplied by the operator).
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type ErrorCode =
  | 'method_not_allowed'
  | 'server_misconfigured'
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_request'
  | 'email_taken'
  | 'provision_failed';

interface ProvisionRequest {
  name: string;
  owner_email: string;
  owner_name: string;
  owner_password: string;
  vat_rate?: number;
  trial_ends_at?: string | null;
  /** Baseline categories for the new tenant. See DEFAULT_CATEGORIES. */
  categories?: string[];
}

interface ProvisionResult {
  org_id: string;
  owner_user_id: string;
  categories_created: number;
}

/**
 * A single neutral bucket, NOT the food/beverage/cleaning set from supabase/seed.sql — those
 * describe a legacy tenant's business and would be an invented assumption about what a new
 * customer buys (docs/OPEN-DECISIONS.md:3). `products.category_id` is nullable, so a tenant
 * can also run with none. The operator can pass a real list in `categories`.
 */
const DEFAULT_CATEGORIES = ['כללי'];

const MIN_PASSWORD_LENGTH = 10;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function fail(code: ErrorCode, message: string, status: number, detail?: string): Response {
  return json({ error: { code, message, detail } }, status);
}

/** Returns a human-readable problem, or null when the payload is usable. */
function validate(body: Partial<ProvisionRequest>): string | null {
  const name = body.name?.trim();
  if (!name) return 'שם הארגון חסר';
  if (name.length > 200) return 'שם הארגון ארוך מדי';

  const email = body.owner_email?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'כתובת אימייל של בעל העסק אינה תקינה';

  if (!body.owner_name?.trim()) return 'שם בעל העסק חסר';

  if (!body.owner_password || body.owner_password.length < MIN_PASSWORD_LENGTH) {
    return `סיסמה ראשונית חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`;
  }

  if (body.vat_rate !== undefined) {
    if (typeof body.vat_rate !== 'number' || !Number.isFinite(body.vat_rate) || body.vat_rate < 0 || body.vat_rate > 100) {
      return 'שיעור מע״מ אינו תקין';
    }
  }

  if (body.trial_ends_at != null && Number.isNaN(Date.parse(body.trial_ends_at))) {
    return 'תאריך סיום תקופת ניסיון אינו תקין';
  }

  if (body.categories !== undefined) {
    if (!Array.isArray(body.categories) || body.categories.some((c) => typeof c !== 'string')) {
      return 'רשימת הקטגוריות אינה תקינה';
    }
  }

  return null;
}

/**
 * Postgres cannot roll back an `auth.users` insert together with a public-schema transaction —
 * the admin API is a separate call over HTTP. So provisioning is unwound explicitly, in
 * reverse order of creation. Deleting the auth user cascades its `profiles` row
 * (0001_init.sql:32), and categories must go before the organization they reference.
 *
 * Returns the list of steps that could not be undone, so a half-provisioned tenant is at
 * least reported loudly rather than left silently.
 */
async function rollback(
  admin: SupabaseClient,
  created: { orgId?: string; userId?: string },
): Promise<string[]> {
  const leftovers: string[] = [];

  if (created.userId) {
    const { error } = await admin.auth.admin.deleteUser(created.userId);
    if (error) leftovers.push(`auth user ${created.userId}: ${error.message}`);
  }
  if (created.orgId) {
    const cats = await admin.from('categories').delete().eq('org_id', created.orgId);
    if (cats.error) leftovers.push(`categories of org ${created.orgId}: ${cats.error.message}`);

    const org = await admin.from('organizations').delete().eq('id', created.orgId);
    if (org.error) leftovers.push(`organization ${created.orgId}: ${org.error.message}`);
  }

  return leftovers;
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

  // ===== 1. Who is calling? =====
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return fail('unauthenticated', 'נדרשת התחברות', 401);

  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return fail('unauthenticated', 'הסשן אינו תקף', 401);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // ===== 2. Is the caller a platform operator? =====
  // Checked against the table directly rather than through RLS: this must not depend on a
  // policy staying correct in a future migration.
  const { data: adminRow, error: adminError } = await admin
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', userData.user.id)
    .maybeSingle();

  if (adminError) return fail('provision_failed', 'בדיקת ההרשאה נכשלה', 500, adminError.message);
  if (!adminRow) return fail('forbidden', 'הפעולה מותרת למנהלי פלטפורמה בלבד', 403);

  // ===== 3. Payload =====
  let body: Partial<ProvisionRequest>;
  try {
    body = (await req.json()) as Partial<ProvisionRequest>;
  } catch {
    return fail('invalid_request', 'גוף הבקשה אינו JSON תקין', 400);
  }

  const problem = validate(body);
  if (problem) return fail('invalid_request', problem, 400);

  const name = body.name!.trim();
  const ownerEmail = body.owner_email!.trim().toLowerCase();
  const ownerName = body.owner_name!.trim();
  const categories = (body.categories ?? DEFAULT_CATEGORIES)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const created: { orgId?: string; userId?: string } = {};

  try {
    // ===== 4. Organization =====
    // status defaults to 'trial' (0006). trial_ends_at is recorded only if the operator set
    // one — trial length is an open business question, not something to invent here.
    const orgInsert = await admin
      .from('organizations')
      .insert({
        name,
        ...(body.vat_rate !== undefined ? { vat_rate: body.vat_rate } : {}),
        ...(body.trial_ends_at ? { trial_ends_at: body.trial_ends_at } : {}),
      })
      .select('id')
      .single();

    if (orgInsert.error || !orgInsert.data) {
      throw new Error(`יצירת הארגון נכשלה: ${orgInsert.error?.message ?? 'לא הוחזר מזהה'}`);
    }
    created.orgId = orgInsert.data.id as string;

    // ===== 5. Owner auth user =====
    const userCreate = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: body.owner_password!,
      email_confirm: true,
    });

    if (userCreate.error || !userCreate.data.user) {
      const message = userCreate.error?.message ?? 'לא הוחזר משתמש';
      // Surface the common operator mistake as its own code instead of a generic failure.
      const taken = /already|registered|exists/i.test(message);
      const leftovers = await rollback(admin, created);
      return taken
        ? fail('email_taken', 'כתובת האימייל כבר רשומה במערכת', 409, leftovers.join('; ') || undefined)
        : fail('provision_failed', `יצירת משתמש הבעלים נכשלה: ${message}`, 500, leftovers.join('; ') || undefined);
    }
    created.userId = userCreate.data.user.id;

    // ===== 6. Owner profile =====
    const profileInsert = await admin.from('profiles').insert({
      id: created.userId,
      org_id: created.orgId,
      full_name: ownerName,
      role: 'owner',
      active: true,
    });
    if (profileInsert.error) throw new Error(`יצירת פרופיל הבעלים נכשלה: ${profileInsert.error.message}`);

    // ===== 7. Baseline categories =====
    let categoriesCreated = 0;
    if (categories.length > 0) {
      const catInsert = await admin
        .from('categories')
        .insert(categories.map((c, i) => ({ org_id: created.orgId, name: c, sort: i + 1 })))
        .select('id');
      if (catInsert.error) throw new Error(`יצירת קטגוריות הבסיס נכשלה: ${catInsert.error.message}`);
      categoriesCreated = catInsert.data?.length ?? 0;
    }

    const result: ProvisionResult = {
      org_id: created.orgId,
      owner_user_id: created.userId,
      categories_created: categoriesCreated,
    };
    return json(result, 201);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const leftovers = await rollback(admin, created);
    return fail(
      'provision_failed',
      message,
      500,
      leftovers.length ? `ניקוי חלקי נכשל — נדרש טיפול ידני: ${leftovers.join('; ')}` : undefined,
    );
  }
});

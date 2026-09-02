/**
 * admin-provision — create a new tenant (organization + owner user).
 *
 * This is the FIRST and ONLY exception to "no middle tier" (docs/ARCHITECTURE.md:5).
 * The reason is narrow and specific: creating an auth user requires the Supabase
 * `service_role` key, that key bypasses every RLS policy in the database, and it therefore
 * must never be shipped to a browser. Everything else in InPlace still goes straight from
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

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  provisionTenant, validateProvisionInput, type ProvisionResult,
} from '../_shared/provision.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id',
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
  /** Baseline categories for the new tenant. See DEFAULT_CATEGORIES. */
  categories?: string[];
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function fail(code: ErrorCode, message: string, status: number, detail?: string): Response {
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

  const input = {
    name: body.name ?? '',
    ownerEmail: body.owner_email ?? '',
    ownerName: body.owner_name ?? '',
    ownerPassword: body.owner_password ?? '',
    vatRate: body.vat_rate,
    categories: body.categories,
    // An operator hands the credentials over in person; there is nobody to send a confirmation
    // to. Self-signup (0159) is the path that starts unconfirmed.
    emailConfirmed: true,
    // And it is also the path that defers the password (owner ruling #332). This one cannot: the
    // operator IS the trusted party, the address is confirmed the moment the tenant exists, and
    // there would be no confirmation link to carry a `/set-password` visit. Stated rather than
    // defaulted, because `validateProvisionInput` refuses a payload whose two halves disagree.
    passwordPending: false,
  };

  const problem = validateProvisionInput(input);
  if (problem) return fail('invalid_request', problem, 400);

  // ===== 4-7. Organization, owner, profile, categories =====
  // One implementation, shared with public-signup (0159): a second copy of the create-and-unwind
  // sequence is how the two doors would drift until one forgot its rollback.
  const outcome = await provisionTenant(admin, input);
  if (!outcome.ok) {
    const detail = outcome.failure.leftovers.length
      ? `ניקוי חלקי נכשל — נדרש טיפול ידני: ${outcome.failure.leftovers.join('; ')}`
      : undefined;
    return outcome.failure.kind === 'email_taken'
      ? fail('email_taken', outcome.failure.message, 409, detail)
      : fail('provision_failed', outcome.failure.message, 500, detail);
  }

  const result: ProvisionResult = outcome.result;
  return json(result, 201);
});

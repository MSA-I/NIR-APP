// webhook-verify — performs the ownership handshake against a customer-registered webhook
// endpoint (OPEN-DECISIONS #98 / #253).
//
// Authorization, in order, so the reasoning is visible rather than implied:
//
//   1. The platform gate. This function is deployed with `verify_jwt = true` — its only caller
//      is a signed-in browser, so there is no reason to let an unauthenticated request reach the
//      handler at all (the `assistant` precedent; contrast `outbox-worker`, whose caller is a
//      database job holding a shared secret and which therefore cannot present a JWT).
//   2. The database. The browser has ALREADY called
//      `public.request_webhook_verification(uuid, text)` with its own JWT, and that command is
//      the real boundary: owner role, `assert_recent_password_authentication()` (#85), a
//      mandatory reason, the offboarding write fence, an audit row and a `security_events` row.
//      It hands back an opaque, single-use, 15-minute `verification_id`.
//   3. This function. It exchanges that id — and nothing else it was told by the caller — for
//      the signed envelope. It cannot verify an endpoint the owner did not authorize, because
//      the id is the only thing that resolves to a subscription, and
//      `service_begin_webhook_verification` refuses an id that is unknown, settled, expired or
//      already dispatched.
//
// service_role is used here and stays server-side (CLAUDE.md iron rule): the two RPCs it calls
// are revoked from every browser role, and it touches no business row.
//
// SSRF: every outbound byte goes through guardedRequest (ssrf.ts). The address is validated and
// the socket is pinned to it; the registered hostname is carried only as SNI. Redirects are
// never followed and response bodies are never read.
//
// Required environment (injected by the platform):
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//
// Request contract: POST { "verificationId": "<uuid>" }, preceded by the browser's own CORS
// preflight (OPTIONS), which is answered before anything else this function checks.
// Response: { ok: true, verified: boolean, code: "<named_code>" } — a NAMED code, never a
// provider string and never a database message (#98 forbids raw errors on this surface).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { withAllowedOrigin } from '../_shared/cors.ts';
import { denoDialDeps } from './ssrf.ts';
import { runVerification, type BeginEnvelope, type VerifyRpc } from './verify.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS_HEADERS: Record<string, string> = {
  // Filled per request by withAllowedOrigin (../_shared/cors.ts): the caller's Origin when it
  // is on ALLOWED_ORIGINS/APP_BASE_URL, and the first allowed origin otherwise. Never "*".
  'Access-Control-Allow-Origin': '',
  Vary: 'Origin',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function fail(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

/**
 * Exported so the preflight and the method door are provable without a listener --
 * `assistant/index.ts` is the precedent. `Deno.serve` runs only when this file is the program.
 */
export const handler = withAllowedOrigin(async (req: Request): Promise<Response> => {
  // FIRST — before the method check, before the environment read, before the body is touched.
  // A CORS preflight is an OPTIONS request carrying no Authorization header and no body, and
  // until now it fell through to the line below and was answered 405 with no CORS headers at
  // all. The browser then never sent the POST, so `requestWebhookVerification` failed for every
  // owner while the function itself looked healthy. Same shape as assistant/index.ts.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  if (req.method !== 'POST') return fail('method_not_allowed', 'POST only', 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    return fail('misconfigured', 'missing environment', 500);
  }

  let verificationId: unknown;
  try {
    verificationId = ((await req.json()) as { verificationId?: unknown })?.verificationId;
  } catch {
    return fail('invalid_request', 'a JSON body is required', 400);
  }
  if (typeof verificationId !== 'string' || !UUID.test(verificationId)) {
    return fail('invalid_request', 'verificationId must be a uuid', 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const rpc: VerifyRpc = {
    begin: async (id) => {
      const { data, error } = await admin.rpc('service_begin_webhook_verification', {
        p_verification_id: id,
      });
      return { data: (data ?? null) as BeginEnvelope | null, error };
    },
    complete: async (id, echo, failureCode) => {
      const { data, error } = await admin.rpc('service_complete_webhook_verification', {
        p_verification_id: id,
        p_echo: echo,
        p_failure_code: failureCode,
      });
      return { data: (data ?? null) as { verified: boolean; code?: string } | null, error };
    },
  };

  const outcome = await runVerification(verificationId, rpc, denoDialDeps);
  return json({ ok: true, ...outcome }, 200);
});

if (import.meta.main) {
  Deno.serve(handler);
}

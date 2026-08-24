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
// Request contract: POST { "verificationId": "<uuid>" }
// Response: { ok: true, verified: boolean, code: "<named_code>" } — a NAMED code, never a
// provider string and never a database message (#98 forbids raw errors on this surface).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { denoDialDeps } from './ssrf.ts';
import { runVerification, type BeginEnvelope, type VerifyRpc } from './verify.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fail(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

Deno.serve(async (req: Request): Promise<Response> => {
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

// supplier-portal -- the token door for the no-login supplier order portal.
//
// A supplier holds a raw bearer token (minted by issue_supplier_order_link, carried in the
// link's URL FRAGMENT so it never reaches server logs). This function hashes it and asks the
// database through two service_role-only RPCs; the DB stores only the hash and answers only
// for a live, unexpired, unrevoked link (0167_supplier_order_portal.sql). No JWT is involved
// anywhere -- verify_jwt=false, the 0103 tenant-export shape -- and no tenant data beyond the
// one snapshotted order can be reached, because the RPCs return the snapshot, not queries.
//
// POST-only, deliberately: a GET would put the token in the URL, and URLs are logged by every
// hop. Failures are uniform: a wrong, expired, revoked or foreign token is answered with the
// same 404 `link_invalid`, so the endpoint confirms nothing about what exists (the
// tenant-export idiom). Before the token is inspected, the gateway-provided client IP is HMACed
// with a server-only pepper and counted by a database RPC. That limit is persistent across Edge
// isolates and never stores or logs the readable IP.
//
// Required environment (supabase secrets set ...):
//   ALLOWED_ORIGINS / APP_BASE_URL -- CORS allowlist, same convention as send-invite
//   SUPPLIER_PORTAL_RATE_LIMIT_PEPPER -- random server-only value, at least 32 characters
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY -- injected by the platform
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';
import {
  clientAddress,
  corsFor,
  mapSubmitError,
  normalizeToken,
  rateLimitFingerprint,
  sha256Hex,
  validRateLimitPepper,
} from './core.ts';

function json(
  body: unknown,
  status: number,
  cors: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      ...extraHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

interface PortalRequest {
  action: 'resolve' | 'submit';
  token?: unknown;
  proposal?: unknown;
}

Deno.serve(async (request) => {
  const cors = corsFor(
    request.headers.get('Origin'),
    Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('APP_BASE_URL') ?? undefined,
  );
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const rateLimitPepper = Deno.env.get('SUPPLIER_PORTAL_RATE_LIMIT_PEPPER');
  if (!supabaseUrl || !serviceKey || !validRateLimitPepper(rateLimitPepper)) {
    return json({ error: 'misconfigured' }, 500, cors);
  }

  const address = clientAddress(request.headers);
  if (!address) {
    console.error('supplier-portal client address unavailable');
    return json({ error: 'service_unavailable' }, 503, cors);
  }
  const fingerprint = await rateLimitFingerprint(address, rateLimitPepper);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: rateDecision, error: rateError } = await admin.rpc(
    'service_check_supplier_portal_rate_limit',
    { p_fingerprint: fingerprint },
  );
  if (rateError) {
    console.error('supplier-portal rate limit failed', rateError.code);
    return json({ error: 'service_unavailable' }, 503, cors);
  }
  const rate = rateDecision as { allowed?: boolean; retry_after_seconds?: number } | null;
  if (rate?.allowed !== true) {
    const retryAfter = Math.max(1, Math.ceil(rate?.retry_after_seconds ?? 60));
    return json({ error: 'rate_limited' }, 429, cors, { 'Retry-After': String(retryAfter) });
  }

  let body: PortalRequest;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_request' }, 400, cors);
  }

  const token = normalizeToken(body.token);
  if (!token) return json({ error: 'link_invalid' }, 404, cors);

  const tokenHash = await sha256Hex(token);

  if (body.action === 'resolve') {
    const { data, error } = await admin.rpc('service_resolve_supplier_order_link', {
      p_token_hash: tokenHash,
    });
    if (error) {
      console.error('supplier-portal resolve failed', error.code);
      return json({ error: 'service_unavailable' }, 503, cors);
    }
    if (data === null) return json({ error: 'link_invalid' }, 404, cors);
    if ((data as { state?: string }).state === 'locked') {
      return json({ error: 'rate_limited' }, 429, cors);
    }
    return json(data, 200, cors);
  }

  if (body.action === 'submit') {
    const { data, error } = await admin.rpc('service_submit_supplier_order_proposal', {
      p_token_hash: tokenHash,
      p_payload: body.proposal ?? null,
    });
    if (error) {
      // Unexpected: the SQL answers failures in-band (so its bookkeeping commits) and raises
      // only for a broken deployment.
      console.error('supplier-portal submit failed', error.code);
      return json({ error: 'service_unavailable' }, 503, cors);
    }
    const failure = (data as { error?: string } | null)?.error;
    if (failure) {
      const mapped = mapSubmitError(failure);
      return json({ error: mapped.error }, mapped.status, cors);
    }
    return json(data, 200, cors);
  }

  return json({ error: 'invalid_request' }, 400, cors);
});

// email-webhook -- the signed Resend delivery webhook: the ONLY door through which `delivered`
// and `bounced` can enter this system.
//
// 0168 stamps an order `sent` when Resend accepted the message (#187). Everything the provider
// learns afterwards arrives here, asynchronously and unauthenticated-by-JWT, so the signature IS
// the authentication. The function is deliberately thin: verify, parse, hand six bounded values to
// service_record_email_delivery_event (0190), map the answer. Every decision that matters --
// de-duplication by provider event id, the monotonic ladder that stops a late `delivered` from
// overwriting a `bounced`, and the rule that a bounce never touches the order lifecycle -- lives
// in SQL, where a redeployed Edge Function cannot hold a different opinion about it.
//
// PROVIDER CONTRACT, read 2026-08-23 (the full derivation is in core.ts):
//   https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
//   https://docs.svix.com/receiving/verifying-payloads/how-manual
//   https://docs.svix.com/receiving/verifying-payloads/why
//   https://resend.com/docs/webhooks/introduction
//   https://resend.com/docs/dashboard/webhooks/event-types
// Resend signs with Svix: `svix-id` / `svix-timestamp` / `svix-signature`, HMAC-SHA256 over
// `${id}.${timestamp}.${raw body}`, key = base64-decoded `whsec_` secret, +/- 5 minute window,
// space-separated `v1,<sig>` entries during key rotation. No Svix SDK is imported to do eight
// lines of Web Crypto.
//
// AUTHENTICATION SHAPE: verify_jwt = false, because there is no caller to authenticate -- the
// same argument outbox-worker and send-push already make for a machine caller holding a shared
// secret. A bad or missing signature answers 403 `forbidden`, matching
// supabase/functions/outbox-worker/index.ts:185 and supabase/functions/send-push/index.ts:463.
// No CORS headers: no browser ever calls this, and advertising an allowed origin would only
// invite one to try.
//
// Required environment (supabase secrets set ...):
//   RESEND_WEBHOOK_SECRET -- the endpoint's signing secret from the Resend dashboard, `whsec_...`
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY -- injected by the platform
//
// NOTHING from the provider is logged. Not the body, not the headers, not the secret: a bounce
// payload carries a supplier's address, and a log line is the easiest place to leak one.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';
import {
  mapRecordOutcome,
  parseDeliveryEvent,
  readWebhookHeaders,
  verifyWebhookSignature,
  type RecordOutcome,
} from './core.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function fail(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return fail('method_not_allowed', 'the delivery webhook accepts POST only', 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const signingSecret = Deno.env.get('RESEND_WEBHOOK_SECRET');
  if (!supabaseUrl || !serviceKey || !signingSecret) {
    // Refuse rather than accept unverified events: an endpoint with no secret configured is not
    // a webhook, it is an open write door onto tenant delivery evidence.
    console.error('email-webhook is missing required configuration');
    return fail('misconfigured', 'the delivery webhook is not configured', 500);
  }

  const headers = readWebhookHeaders(request.headers);
  if (!headers) {
    return fail('forbidden', 'missing signature headers', 403);
  }

  // THE RAW BODY, AS TEXT, BEFORE ANY JSON PARSE. The signature covers exactly these bytes;
  // parsing and re-stringifying would reorder keys, re-escape unicode and drop whitespace, and
  // the recomputed HMAC would never match again. Resend's own documentation is explicit about
  // this: "The cryptographic signature is sensitive to even the slightest change."
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return fail('invalid_request', 'unreadable request body', 400);
  }

  const verification = await verifyWebhookSignature({
    rawBody,
    headers,
    secret: signingSecret,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!verification.ok) {
    if (verification.reason === 'misconfigured_secret') {
      console.error('email-webhook signing secret is not a decodable whsec_ value');
      return fail('misconfigured', 'the delivery webhook is not configured', 500);
    }
    // A stale timestamp, a forged signature and an unparseable one are all the same answer to
    // the caller: nothing about which check failed is worth telling an unauthenticated sender.
    return fail('forbidden', 'signature verification failed', 403);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return fail('invalid_request', 'body is not valid JSON', 400);
  }

  const event = parseDeliveryEvent(payload);
  if (!event) {
    // An opened, clicked, contact or domain event -- or one Resend adds after this was written.
    // Ignored BY NAME and answered 200: an unrecognized event is never read as a delivery, and
    // never left pending for the provider to retry for hours.
    return json({ ok: true, state: 'ignored' }, 200);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc('service_record_email_delivery_event', {
    // The per-delivery identifier from the signature headers -- the same value Svix documents as
    // the de-duplication key. The database holds a UNIQUE index on it, so a replay collides there.
    p_provider_event_id: verification.eventId,
    p_provider_message_id: event.providerMessageId,
    p_event_type: event.eventType,
    p_reason_code: event.reasonCode,
    p_reason_message: event.reasonMessage,
    p_occurred_at: event.occurredAt,
  });
  if (error) {
    // Only the error CODE: the message could echo provider content back into the logs.
    console.error('email-webhook settlement failed', error.code);
    return fail('settlement_failed', 'the delivery event could not be recorded', 500);
  }

  const mapped = mapRecordOutcome(data as RecordOutcome | null);
  return json(mapped.body, mapped.status);
});

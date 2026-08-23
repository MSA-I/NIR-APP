// whatsapp-webhook -- the tenant's WhatsApp provider calls this with delivery status.
//
// THERE IS NO JWT HERE BY DESIGN. The provider is not a user of this system and cannot present
// one. The credential is the request signature: HMAC-SHA1 over the exact callback URL plus the
// sorted POST parameters, keyed by that tenant's own auth token, per Twilio's published
// contract read 2026-08-23 (https://www.twilio.com/docs/usage/security and
// https://www.twilio.com/docs/usage/webhooks/webhooks-security). The algorithm lives in core.ts
// with the documentation quoted beside it, and core.test.ts pins the vendor's own published
// known-answer vector.
//
// THE URL IS CONFIGURATION, NOT A GUESS. The signed string starts with the URL the provider
// actually called. Reconstructing it from request headers is unsafe behind a proxy or load
// balancer that rewrites scheme, host or port -- a caveat the vendor documentation states
// explicitly. WHATSAPP_WEBHOOK_URL therefore holds the exact public URL, and the query string
// the request arrived with is appended to it verbatim.
//
// #241 (owner, 22.08.2026): inbound text and media are NOT supported at launch. They are not
// ingested, not filed, not stored and never answered as handled. Classification happens before
// any tenant lookup, so an inbound payload never even causes a credential to be read. Extending
// this to inbound requires a NEW owner decision; there is deliberately no hook for it here.
//
// #239 STATUS: Twilio is SELECTED / ACCOUNT_NOT_PROVEN / CREDENTIALS_NOT_CONFIGURED /
// NOT_INTEGRATED. This function has never been deployed and no URL has been registered with any
// provider.
//
// Required environment (supabase secrets set ...):
//   WHATSAPP_WEBHOOK_URL -- the exact public URL registered with the provider
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY -- injected by the platform
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';
import {
  classifyTwilioWebhook,
  formParams,
  verifyTwilioJsonSignature,
  verifyTwilioSignature,
} from './core.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const configuredUrl = (Deno.env.get('WHATSAPP_WEBHOOK_URL') ?? '').trim();
  if (!supabaseUrl || !serviceKey || !configuredUrl) return json({ error: 'misconfigured' }, 500);

  const rawBody = await request.text();
  const contentType = (request.headers.get('Content-Type') ?? '').toLowerCase();
  const isJsonBody = contentType.includes('application/json');
  const params = isJsonBody ? {} : formParams(rawBody);

  const classification = classifyTwilioWebhook(
    isJsonBody ? safeJsonParams(rawBody) : params,
  );
  if (classification.kind !== 'delivery_status') {
    // Ignored, and said so. No tenant is resolved, no credential is read, no row is written,
    // and the reply does not describe this as processed.
    return json({ handled: false, reason: classification.reason }, 200);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // The claimed sender selects a CANDIDATE key only. A forged sender simply selects a key the
  // forger does not hold, and verification then fails -- which is the whole point of signing.
  const lookup = await admin.rpc('service_get_whatsapp_provider_connection', {
    p_provider: 'twilio',
    p_provider_sender_id: classification.providerSenderId,
  });
  if (lookup.error) return json({ handled: false, reason: 'connection_unknown' }, 404);
  const connection = lookup.data as { credential?: string };

  const query = new URL(request.url).search;
  const signedUrl = `${configuredUrl}${query}`;
  const signature = request.headers.get('X-Twilio-Signature');
  const verified = isJsonBody
    ? await verifyTwilioJsonSignature(connection.credential ?? '', signedUrl, rawBody, signature)
    : await verifyTwilioSignature(connection.credential ?? '', signedUrl, params, signature);
  if (!verified) return json({ handled: false, reason: 'signature_invalid' }, 403);

  const processed = await admin.rpc('service_process_whatsapp_provider_event', {
    p_provider: 'twilio',
    p_provider_sender_id: classification.providerSenderId,
    // The provider's own message identifier IS the event identity for a status callback: the
    // status plus the message id is what must not be applied twice.
    p_event_id: `${classification.providerMessageId}:${classification.status}`,
    p_event_kind: 'delivery_status',
    p_provider_message_id: classification.providerMessageId,
    p_status: classification.status,
    p_error_code: classification.errorCode,
    p_error_message: null,
    p_event_at: new Date().toISOString(),
  });
  if (processed.error) {
    console.error('whatsapp-webhook processing failed', processed.error.code);
    return json({ handled: false, reason: 'processing_failed' }, 500);
  }

  return json({ handled: true }, 200);
});

/** A JSON callback still carries its fields flat; anything non-scalar is dropped rather than
 * coerced, so no structure from a payload reaches classification. */
function safeJsonParams(rawBody: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object') return {};
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number') flat[key] = String(value);
    }
    return flat;
  } catch {
    return {};
  }
}

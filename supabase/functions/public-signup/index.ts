/**
 * public-signup — the anonymous door that creates a tenant (0159).
 *
 * This is the second function in the project to hold the `service_role` key, and unlike
 * admin-provision it has NO caller to authenticate: anybody on the internet can knock. Its
 * safety therefore rests on four things, in this order:
 *
 *   1. A rate limit counted IN THE DATABASE. A limiter held in process memory resets on every
 *      cold start, and Edge Functions cold-start constantly, so it would bound nothing.
 *   2. Nothing about the tenant is caller-selectable beyond a name. No status, no plan, no VAT
 *      rate, no categories — a signup form that could ask for Business would be a free upgrade.
 *   3. The owner's email starts UNCONFIRMED, so an address the visitor does not control cannot
 *      be used to sign in.
 *   4. One answer for every outcome that involves an email address, so this endpoint cannot be
 *      used to discover who already has an account.
 *
 * What it deliberately does not do: send its own email. Supabase Auth owns the confirmation
 * message; DEBT §25 (no verified sender domain) is why it is not branded yet, and inventing a
 * second mailer here would make that worse rather than better.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { provisionTenant, validateProvisionInput } from '../_shared/provision.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'x-client-info, apikey, content-type, x-correlation-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * The one sentence every email-shaped outcome returns. It is deliberately true for both a fresh
 * signup and an address that already exists: this endpoint must not be a way to find out which
 * of the two happened, and the reader is told what to do in either case.
 */
const NEUTRAL_ANSWER =
  'אם הכתובת אינה רשומה עדיין — נשלח אליה מייל אישור, ויש להשלים ממנו את ההרשמה. ' +
  'אם היא כבר רשומה — יש להיכנס עם הסיסמה הקיימת או לאפס אותה.';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The left-most address in x-forwarded-for is the client as the edge saw it. It is
 * spoofable — which is exactly why it is only ever hashed into a rate-limit bucket and never
 * treated as identity or stored in readable form.
 */
function clientAddress(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim() || null;
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip');
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return json({ error: { code: 'method_not_allowed', message: 'POST בלבד' } }, 405);
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    return json({ error: { code: 'server_misconfigured', message: 'ההרשמה אינה זמינה כרגע' } }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: { code: 'invalid_request', message: 'גוף הבקשה אינו JSON תקין' } }, 400);
  }

  const input = {
    name: typeof body.organization_name === 'string' ? body.organization_name : '',
    ownerEmail: typeof body.email === 'string' ? body.email : '',
    ownerName: typeof body.full_name === 'string' ? body.full_name : '',
    ownerPassword: typeof body.password === 'string' ? body.password : '',
    // Nothing else is read from the request. Plan, status, VAT rate and categories are the
    // database's to decide, and a form that could set them would be a free upgrade.
    emailConfirmed: false,
  };

  const problem = validateProvisionInput(input);
  if (problem) return json({ error: { code: 'invalid_request', message: problem } }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const address = clientAddress(req);
  const emailHash = await sha256Hex(input.ownerEmail.trim().toLowerCase());
  const ipHash = address ? await sha256Hex(address) : null;

  const limit = await admin.rpc('service_check_signup_rate', {
    p_ip_hash: ipHash,
    p_email_hash: emailHash,
  });
  if (limit.error) {
    return json({ error: { code: 'signup_unavailable', message: 'ההרשמה אינה זמינה כרגע' } }, 503);
  }
  if (!(limit.data as { allowed?: boolean })?.allowed) {
    // Fail closed and say so plainly. The reason is not disclosed: telling a caller which of the
    // three limits they hit tells them how to stay under it.
    return json({
      error: {
        code: 'rate_limited',
        message: 'התקבלו יותר מדי בקשות הרשמה. יש לנסות שוב מאוחר יותר.',
      },
    }, 429);
  }

  const outcome = await provisionTenant(admin, input);

  if (!outcome.ok) {
    await admin.rpc('service_mark_signup_rejected', { p_email_hash: emailHash });

    // An address that already exists gets the SAME answer as a fresh signup. Anything else turns
    // this endpoint into a way to enumerate who has an account.
    if (outcome.failure.kind === 'email_taken') {
      return json({ status: 'pending_confirmation', message: NEUTRAL_ANSWER }, 202);
    }
    return json({
      error: {
        code: 'signup_failed',
        message: 'ההרשמה נכשלה. יש לנסות שוב, ואם הבעיה חוזרת לפנות לתמיכה.',
        // The leftovers line is for our logs, not for the visitor's screen.
        detail: outcome.failure.leftovers.length ? outcome.failure.leftovers.join('; ') : undefined,
      },
    }, 500);
  }

  // Best effort: a recorded funnel event is worth less than a created customer, so a failure
  // here must not turn a successful signup into an error the visitor sees.
  await admin.rpc('service_record_product_event', {
    p_org_id: outcome.result.org_id,
    p_event_name: 'signup.completed',
    p_properties: {},
    p_idempotency_key: outcome.result.org_id,
  });

  // The organization id is deliberately absent from the response. The visitor cannot use it
  // before confirming their email, and an anonymous endpoint that hands out tenant identifiers
  // is a needless one.
  return json({ status: 'pending_confirmation', message: NEUTRAL_ANSWER }, 202);
});

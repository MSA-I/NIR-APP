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
 * It never invents a second mailer: Supabase Auth owns the confirmation link and hands it to the
 * configured SMTP provider. `auth.admin.createUser` does not trigger that delivery, so the
 * password branch requests it explicitly after tenant provisioning succeeds.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  adoptExistingUserAsOwner,
  provisionTenant,
  validateProvisionInput,
} from '../_shared/provision.ts';
import { sendSignupConfirmation } from './confirmation.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-correlation-id',
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

  const admin0 = createClient(url, serviceKey, { auth: { persistSession: false } });
  const address0 = clientAddress(req);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: { code: 'invalid_request', message: 'גוף הבקשה אינו JSON תקין' } }, 400);
  }

  /**
   * The federated branch (0205). Owner decision 24.08.2026, extended to Apple on 25.08.2026:
   * signing up with a federated identity is for the person creating the organization, and for
   * nobody else.
   *
   * Unlike the password branch this one HAS a caller, and its safety is that caller's own token:
   *
   *   * The provider is read from `app_metadata`, which GoTrue writes. `user_metadata` is
   *     self-asserted and is never consulted for an authorization decision.
   *   * The email is the provider's, not the form's. A federated signup cannot claim an address it
   *     did not prove, so there is nothing here to enumerate and no neutral answer to hide behind.
   *   * A caller that already has a profile is refused. This path creates a NEW tenant and can
   *     never attach a second profile to an existing one, which is the other half of "owner only"
   *     -- the first half being 0205's refusal inside `accept_invitation`.
   *
   * The rate limit still applies: an authenticated caller is not an unbounded one.
   *
   * Adding Apple needed no migration, and that is a property of how 0205 was written rather than
   * luck: its guard reads `coalesce(private.auth_identity_provider(), 'email') <> 'email'`, so it
   * already refuses EVERY non-password identity, and `service_identity_has_profile` never asked
   * which provider was involved. The rule was "federated", never "Google".
   */
  const FEDERATED_IDENTITIES = ['google', 'apple'] as const;
  const requestedIdentity = FEDERATED_IDENTITIES.find((id) => id === body.identity);
  if (requestedIdentity) {
    // The provider name is safe to echo: the caller sent it, and it is checked against the token
    // below before it decides anything.
    const label = requestedIdentity === 'google' ? 'Google' : 'Apple';
    const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
    if (!bearer) {
      return json({ error: { code: 'unauthenticated', message: `נדרשת התחברות עם ${label}` } }, 401);
    }
    const caller = await admin0.auth.getUser(bearer);
    const user = caller.data?.user;
    if (caller.error || !user) {
      return json({ error: { code: 'unauthenticated', message: `נדרשת התחברות עם ${label}` } }, 401);
    }
    const provider = (user.app_metadata as { provider?: unknown } | null)?.provider;
    // The token decides, not the body. A session issued by one provider cannot be spent on
    // another's branch, so `identity` in the payload is a request and never a claim.
    if (provider !== requestedIdentity) {
      return json({
        error: {
          code: 'identity_provider_mismatch',
          message: `המסלול הזה פתוח רק לחשבון שהתחבר דרך ${label}.`,
        },
      }, 403);
    }
    const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
    if (!email) {
      // Apple returns no address when the person hides it and the relay is unavailable. Without one
      // there is nothing to rate-limit against and no way to reach the owner, so this refuses
      // rather than inventing a placeholder address the tenant would be keyed by forever.
      return json({
        error: { code: 'identity_without_email', message: `חשבון ${label} ללא כתובת דואר מאומתת` },
      }, 403);
    }

    const standing = await admin0.rpc('service_identity_has_profile', { p_user_id: user.id });
    if (standing.error) {
      return json({ error: { code: 'signup_unavailable', message: 'ההרשמה אינה זמינה כרגע' } }, 503);
    }
    if (standing.data === true) {
      // Already belongs somewhere. Saying so is safe: the caller proved this identity is theirs.
      return json({
        error: {
          code: 'identity_already_has_organization',
          message: 'החשבון הזה כבר משויך לארגון. יש להיכנס במקום להירשם.',
        },
      }, 409);
    }

    const organizationName = typeof body.organization_name === 'string'
      ? body.organization_name.trim()
      : '';
    if (organizationName.length < 2) {
      return json({ error: { code: 'invalid_request', message: 'שם הארגון קצר מדי' } }, 400);
    }
    const displayName = typeof body.full_name === 'string' && body.full_name.trim()
      ? body.full_name.trim()
      : (user.user_metadata as { full_name?: unknown } | null)?.full_name;
    const ownerName = typeof displayName === 'string' && displayName.trim()
      ? displayName.trim()
      : email;

    const federatedLimit = await admin0.rpc('service_check_signup_rate', {
      p_ip_hash: address0 ? await sha256Hex(address0) : null,
      p_email_hash: await sha256Hex(email),
    });
    if (federatedLimit.error) {
      return json({ error: { code: 'signup_unavailable', message: 'ההרשמה אינה זמינה כרגע' } }, 503);
    }
    if (!(federatedLimit.data as { allowed?: boolean })?.allowed) {
      return json({
        error: {
          code: 'rate_limited',
          message: 'התקבלו יותר מדי בקשות הרשמה. יש לנסות שוב מאוחר יותר.',
        },
      }, 429);
    }

    const adopted = await adoptExistingUserAsOwner(admin0, {
      name: organizationName,
      ownerUserId: user.id,
      ownerName,
    });
    if (!adopted.ok) {
      await admin0.rpc('service_mark_signup_rejected', { p_email_hash: await sha256Hex(email) });
      return json({
        error: {
          code: 'signup_failed',
          message: 'ההרשמה נכשלה. יש לנסות שוב, ואם הבעיה חוזרת לפנות לתמיכה.',
        },
      }, 500);
    }

    await admin0.rpc('service_record_product_event', {
      p_org_id: adopted.result.org_id,
      p_event_name: 'signup.completed',
      p_properties: { identity: requestedIdentity },
      p_idempotency_key: adopted.result.org_id,
    });

    // The provider already proved the address, so there is nothing to confirm and the person is
    // signed in already. The browser reloads into the product, not into a "check your mail" page.
    return json({ status: 'ready', message: 'הארגון נוצר. אפשר להתחיל.' }, 201);
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

  const admin = admin0;

  const address = address0;
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

    // The response stays identical to a fresh signup. The confirmation screen offers Auth's
    // public, rate-limited resend without making this endpoint reveal confirmation state.
    if (outcome.failure.kind === 'email_taken') {
      return json({ status: 'pending_confirmation', message: NEUTRAL_ANSWER }, 202);
    }
    return json({
      error: {
        code: 'signup_failed',
        message: 'ההרשמה נכשלה. יש לנסות שוב, ואם הבעיה חוזרת לפנות לתמיכה.',
        // Rollback leftovers remain available to the trusted admin-provision caller, but an
        // anonymous response must never expose internal row identifiers or database errors.
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

  const { error: confirmationError } = await sendSignupConfirmation(
    admin,
    input.ownerEmail.trim().toLowerCase(),
  );
  if (confirmationError) {
    // Never return provider wording or the address from this anonymous endpoint. A second submit
    // reaches the neutral confirmation screen, whose public Auth resend can retry without another org.
    console.error('signup confirmation delivery failed', {
      code: (confirmationError as { code?: unknown }).code ?? 'auth_resend_failed',
    });
    return json({
      error: {
        code: 'confirmation_delivery_failed',
        message: 'החשבון נוצר, אך לא הצלחנו לשלוח את מייל האישור. יש לנסות שוב בעוד דקה.',
      },
    }, 503);
  }

  // The organization id is deliberately absent from the response. The visitor cannot use it
  // before confirming their email, and an anonymous endpoint that hands out tenant identifiers
  // is a needless one.
  return json({ status: 'pending_confirmation', message: NEUTRAL_ANSWER }, 202);
});

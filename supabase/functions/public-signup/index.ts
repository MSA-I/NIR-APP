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
 *   3. The owner's email starts UNCONFIRMED **and the account's password is one nobody holds** —
 *      GoTrue generates a random one when the admin create is given none (owner ruling #332,
 *      02.09.2026). Unconfirmed alone was not enough: it stopped a stranger
 *      signing in today, but the password they typed against somebody else's address stayed on
 *      the account, and the real owner's confirmation click activated it. The password is now
 *      chosen on `/set-password`, after the link has proved who holds the address.
 *   4. One answer for every outcome that involves an email address, so this endpoint cannot be
 *      used to discover who already has an account.
 *
 * It never invents a second mailer: Supabase Auth owns the confirmation link and hands it to the
 * configured SMTP provider. `auth.admin.createUser` does not trigger that delivery, so the
 * password branch requests it explicitly after tenant provisioning succeeds.
 *
 * NO `emailRedirectTo` IS SENT WITH THAT RESEND, and the omission is the safe choice rather than a
 * gap. GoTrue then substitutes the project's Site URL into `{{ .RedirectTo }}`, the template hands
 * that to `/auth/confirm` as `next`, and the route reads a bare site root as "no destination" and
 * sends a pending owner to `/set-password`. The alternative — reading the caller's `Origin` header
 * — would let an anonymous request choose where a confirmation mail lands, which is an open
 * redirect with a session attached.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  adoptExistingUserAsOwner,
  backupEmailRefusal,
  provisionTenant,
  validateProvisionInput,
} from '../_shared/provision.ts';
import { backupEmailRequired, normaliseEmail } from '../../../src/lib/backupEmail.ts';
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
  'אם הכתובת אינה רשומה עדיין — נשלח אליה מייל אישור, וממנו בוחרים סיסמה ומשלימים את ההרשמה. ' +
  'אם היא כבר רשומה — יש להיכנס עם הסיסמה הקיימת או לאפס אותה.';

/**
 * Owner decision #270, the server half. Two things are separate here and must stay separate:
 *
 *   * A supplied backup address is ALWAYS validated, from the day this ships. `backupEmailRefusal`
 *     inside `validateProvisionInput` does that, on every path, switch or no switch.
 *   * A backup address is only ever REQUIRED when enforcement is on AND the primary address is a
 *     Private Relay forwarder. Both halves are read below, and neither of them defaults to yes.
 *
 * `REQUIRE_BACKUP_EMAIL` unset reads as "not switched on yet", NEVER as a refusal — the same rule
 * `private.auth_org_allows` and `src/lib/entitlements.ts` state on the two sides of the
 * entitlement question (`DEBT §79`). Turning a missing environment variable into a refusal would
 * make signup unreachable the first time a deploy forgot to carry it, and the visitor would have
 * no way to tell that from the product being broken. It is switched on in the same change that
 * switches Apple on, beside `VITE_REQUIRE_BACKUP_EMAIL` in the bundle.
 *
 * Read at module scope, like every other switch this function has: an Edge Function cold-starts
 * constantly, so this is re-read far more often than it is changed.
 */
const BACKUP_EMAIL_ENFORCED = Deno.env.get('REQUIRE_BACKUP_EMAIL') === 'true';

/**
 * The one sentence a relay signup is refused with while enforcement is on. It names the reason,
 * because unlike the address-shaped answers above there is nothing to hide: the caller already
 * knows which address they signed in with.
 */
const BACKUP_EMAIL_REQUIRED_MESSAGE =
  'הכתובת שהתקבלה מ-Apple היא כתובת העברה שאפשר לכבות. ' +
  'כדי שלא נאבד את הקשר איתך, יש להוסיף כתובת דואר חלופית.';

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

    /**
     * The backup address (owner decision #270). This branch is where the requirement actually
     * bites: a relay forwarder can only reach the product through a federated identity.
     *
     * Note what is NOT asked. A Google signup arrives here with a real mailbox and is asked for
     * nothing, and so is an Apple signup by somebody who chose to share their real address — the
     * ruling is about the ADDRESS, and `backupEmailRequired` reads nothing but the address and
     * the switch. `email` here is the provider's, never the body's, so this cannot be talked out
     * of by a caller who would rather not answer.
     */
    const federatedBackup = typeof body.backup_email === 'string'
      ? normaliseEmail(body.backup_email)
      : '';
    const federatedBackupProblem = backupEmailRefusal(federatedBackup, email);
    if (federatedBackupProblem) {
      return json({
        error: { code: 'backup_email_invalid', message: federatedBackupProblem },
      }, 400);
    }
    if (!federatedBackup && backupEmailRequired(email, { enforced: BACKUP_EMAIL_ENFORCED })) {
      return json({
        error: { code: 'backup_email_required', message: BACKUP_EMAIL_REQUIRED_MESSAGE },
      }, 400);
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

    /**
     * The third state this branch was blind to, and why being blind to it was one-way damage.
     *
     * `service_identity_has_profile` answers "does this identity already belong somewhere", and an
     * employee who was invited but has not accepted yet answers NO -- they have no auth user at all
     * until they open the invitation and choose a password (`AcceptInvite.tsx`). So everything
     * below would have handed them an organization of their own and made them its OWNER, which is
     * the exact opposite of what the invitation was for. And it could not be walked back by the
     * person it happened to: `0205` refuses a federated caller inside `accept_invitation` by name,
     * so once they arrive as a Google identity the invitation they came for can never be redeemed.
     *
     * Owner decision 31.08.2026. Naming the business is safe here for the same reason
     * `identity_already_has_organization` is safe one block up: the provider proved the address,
     * so this tells the caller nothing they did not already hold.
     *
     * Two details that are load-bearing:
     *   * `invitations.email` is stored lowercased (`0020`: `v_email := lower(trim(p_email))`) and
     *     `email` here is the provider's, lowercased above -- so this is an exact match. `ilike`
     *     would have been a bug: `_` is legal in an address and is a LIKE wildcard.
     *   * Only a LIVE invitation counts. An expired one is not actionable, and treating it as a
     *     block would strand that address forever -- someone who was invited once and never joined
     *     is entitled to open a business of their own.
     */
    const invited = await admin0
      .from('invitations')
      .select('org_id')
      .eq('email', email)
      .is('accepted_at', null)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .limit(1);
    if (invited.error) {
      return json({ error: { code: 'signup_unavailable', message: 'ההרשמה אינה זמינה כרגע' } }, 503);
    }
    const pendingInvite = (invited.data as { org_id?: string }[] | null)?.[0];
    if (pendingInvite?.org_id) {
      const inviter = await admin0
        .from('organizations')
        .select('name')
        .eq('id', pendingInvite.org_id)
        .maybeSingle();
      // The name is a courtesy, not the refusal. A lookup that failed must not turn "you were
      // invited" into "here is a brand new business", so the refusal stands either way.
      const organization = (inviter.data as { name?: string } | null)?.name ?? '';
      return json({
        error: {
          code: 'invitation_pending',
          message: 'הכתובת הזו הוזמנה להצטרף לעסק קיים. ההצטרפות נעשית מקישור ההזמנה ובסיסמה.',
          organization,
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
      backupEmail: federatedBackup || undefined,
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

  /**
   * THE PASSWORD IS NOT READ FROM THIS REQUEST, and that is owner ruling #332 (02.09.2026).
   *
   * It used to be. `body.password` became the owner's password on an address nobody had proved, so
   * a stranger could pre-register YOUR address with THEIR password: the account started
   * unconfirmed, the confirmation mail went to you, and clicking it brought the account to life
   * under their credentials, as the owner of an organization. "Unconfirmed" bounded who could sign
   * in TODAY; it never bounded whose password was on the account tomorrow.
   *
   * `body.password` is not read here and is not passed on. A caller can still send the field — this
   * is an anonymous HTTP endpoint and anyone may send anything — and it is ignored rather than
   * refused, because a refusal would be a second answer this endpoint has to keep neutral. The
   * account is created with a random password nobody holds — GoTrue's own, generated because the
   * admin create was given none — so no password anybody typed can open it, and the first usable
   * one is chosen on `/set-password` after the confirmation link has proved who holds the address.
   */
  const input = {
    name: typeof body.organization_name === 'string' ? body.organization_name : '',
    ownerEmail: typeof body.email === 'string' ? body.email : '',
    ownerName: typeof body.full_name === 'string' ? body.full_name : '',
    // The fourth field, and the only one added since 0159 (owner decision #270). It is read on this
    // branch too even though a password signup can almost never need it, because the requirement
    // follows the ADDRESS: somebody who types a relay forwarder into this form has exactly the
    // problem the decision is about, and a rule that only looked at the provider would miss them.
    backupEmail: typeof body.backup_email === 'string' ? body.backup_email : undefined,
    // Nothing else is read from the request. Plan, status, VAT rate and categories are the
    // database's to decide, and a form that could set them would be a free upgrade.
    emailConfirmed: false,
    passwordPending: true,
  };

  const problem = validateProvisionInput(input);
  if (problem) return json({ error: { code: 'invalid_request', message: problem } }, 400);

  if (!normaliseEmail(input.backupEmail)
      && backupEmailRequired(input.ownerEmail, { enforced: BACKUP_EMAIL_ENFORCED })) {
    return json({
      error: { code: 'backup_email_required', message: BACKUP_EMAIL_REQUIRED_MESSAGE },
    }, 400);
  }

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

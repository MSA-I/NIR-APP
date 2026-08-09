// send-invite -- issues an employee invitation and emails the link.
//
// Why an Edge Function at all: the Resend API key must never reach the browser, and the raw
// invitation token must never reach it either. Both live only here. The DB hands the token to
// this function once (create_invitation / resend_invitation return it), the function puts it in
// the email, and it is never stored, returned to the caller, or logged.
//
// Authorisation is NOT re-implemented here. The function forwards the caller's JWT to Postgres
// and the RPCs enforce "active owner of this org" via auth_org()/auth_role(), so there is one
// place where that rule lives (0007_invitations.sql). The check below is a fast fail for
// unauthenticated calls, not the security boundary.
//
// Required environment (see supabase secrets set):
//   RESEND_API_KEY    -- Resend API key
//   INVITE_FROM_EMAIL -- verified sender, e.g. "SupplyFlow <invites@example.co.il>"
//   APP_BASE_URL      -- e.g. https://app.example.co.il  (NOT taken from the request body:
//                        a client-supplied base URL would let a caller aim the token elsewhere)
//   ALLOWED_ORIGINS   -- optional, comma-separated; defaults to APP_BASE_URL. Add the dev
//                        origin (http://localhost:5199) here to call this from `npm run dev`.
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY -- injected by the platform;
//                         service_role is used only for the canonical tenant lifecycle preflight

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';
import {
  releaseOrganizationEgress,
  reserveOrganizationEgress,
  type ServiceRpc,
  type ServiceRpcResult,
} from '../_shared/organization-egress.ts';
import { runReservedEgress } from '../_shared/reserved-egress.ts';

/** Echo the caller's Origin only when it is on the allowlist -- never a blanket '*'. */
function corsFor(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('APP_BASE_URL') ?? '')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  const origin = req.headers.get('Origin')?.replace(/\/+$/, '') ?? '';

  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] ?? ''),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

type ErrorCode =
  | 'unauthenticated' | 'not_owner' | 'invalid_request' | 'invalid_email'
  | 'already_member' | 'role_not_invitable' | 'invitation_unknown'
  | 'invitation_accepted' | 'invitation_revoked' | 'invite_cooldown'
  | 'invite_daily_limit' | 'email_failed' | 'org_unavailable'
  | 'service_unavailable' | 'misconfigured';

interface InviteRequest {
  action: 'create' | 'resend';
  email?: string;
  role?: string;
  invitationId?: string;
}

interface IssuedInvitation {
  invitation_id: string;
  token: string;
  email: string;
  role: string;
  org_name: string;
  expires_at: string;
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'מנהל/בעלים',
  kitchen: 'מנהל מטבח',
  office: 'מנהל רכש',
  payer: 'מבצע העברות',
  accountant: 'הנהלת חשבונות',
};

/** Hebrew message per error code -- the UI shows these verbatim. */
const MESSAGE: Record<ErrorCode, string> = {
  org_unavailable: 'לא ניתן לשלוח הזמנות כאשר הארגון במצב קריאה בלבד.',
  service_unavailable: 'לא ניתן לאמת כרגע את מצב הארגון. נסה שוב מאוחר יותר.',
  unauthenticated: 'נדרשת התחברות',
  not_owner: 'רק בעל העסק יכול להזמין משתמשים',
  invalid_request: 'בקשה לא תקינה',
  invalid_email: 'כתובת אימייל לא תקינה',
  already_member: 'כתובת האימייל הזו כבר משויכת למשתמש בעסק',
  role_not_invitable: 'לא ניתן להזמין תפקיד זה דרך המסך הזה',
  invitation_unknown: 'ההזמנה לא נמצאה',
  invitation_accepted: 'ההזמנה כבר נוצלה',
  invitation_revoked: 'ההזמנה בוטלה',
  invite_cooldown: 'נשלחה הזמנה לאחרונה. נסה שוב בעוד דקה.',
  invite_daily_limit: 'מכסת ההזמנות היומית הושגה. נסה שוב מחר.',
  email_failed: 'ההזמנה נוצרה אך שליחת המייל נכשלה — נסה "שליחה מחדש"',
  misconfigured: 'שירות המיילים אינו מוגדר בסביבה זו',
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PROVIDER_TIMEOUT_MS = 10_000;

function serviceRpc(admin: SupabaseClient<any, any, any>): ServiceRpc {
  return (name, args) =>
    admin.rpc(name, args) as unknown as PromiseLike<ServiceRpcResult>;
}

class EmailProviderError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super('email_provider_failed');
    this.status = status;
  }
}

function fail(cors: Record<string, string>, code: ErrorCode, status: number) {
  return new Response(JSON.stringify({ error: { code, message: MESSAGE[code] } }), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function ok(cors: Record<string, string>, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

/** Postgres raises bare codes (see 0007); map them, don't leak the raw SQL error. */
function codeFromPgError(message: string): ErrorCode {
  const known: ErrorCode[] = [
    'not_owner', 'invalid_email', 'already_member', 'role_not_invitable',
    'invitation_unknown', 'invitation_accepted', 'invitation_revoked',
    'invite_cooldown', 'invite_daily_limit',
  ];
  return known.find((c) => message.includes(c)) ?? 'invalid_request';
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain, legible, RTL. A business tool, not a marketing blast. */
function emailHtml(orgName: string, roleLabel: string, link: string, expiresAt: string): string {
  const expires = new Intl.DateTimeFormat('he-IL', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jerusalem',
  }).format(new Date(expiresAt));

  return `<!doctype html>
<html dir="rtl" lang="he">
  <body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
      <tr><td style="padding:28px 28px 8px;">
        <div style="font-size:18px;font-weight:bold;">הוזמנת ל-SupplyFlow</div>
      </td></tr>
      <tr><td style="padding:0 28px 20px;font-size:14px;line-height:1.7;">
        <p style="margin:12px 0;">${esc(orgName)} הזמינו אותך להצטרף למערכת ניהול הרכש, החשבוניות והתשלומים.</p>
        <p style="margin:12px 0;">התפקיד שהוגדר עבורך: <strong>${esc(roleLabel)}</strong>.</p>
        <p style="margin:12px 0;">כדי להשלים את ההצטרפות יש להגדיר שם וסיסמה:</p>
        <p style="margin:20px 0;">
          <a href="${esc(link)}" style="display:inline-block;background:#4338ca;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:8px;font-size:14px;font-weight:bold;">השלמת ההרשמה</a>
        </p>
        <p style="margin:12px 0;color:#64748b;font-size:13px;">הקישור תקף עד ${expires}. לאחר מכן יש לבקש הזמנה חדשה.</p>
        <p style="margin:12px 0;color:#64748b;font-size:13px;">אם לא ציפית להזמנה הזו, אפשר להתעלם מהודעה זו.</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

function emailText(orgName: string, roleLabel: string, link: string): string {
  return [
    `הוזמנת ל-SupplyFlow`,
    ``,
    `${orgName} הזמינו אותך להצטרף למערכת ניהול הרכש, החשבוניות והתשלומים.`,
    `התפקיד שהוגדר עבורך: ${roleLabel}.`,
    ``,
    `להשלמת ההרשמה:`,
    link,
    ``,
    `אם לא ציפית להזמנה הזו, אפשר להתעלם מהודעה זו.`,
  ].join('\n');
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(cors, 'invalid_request', 405);

  const resendKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('INVITE_FROM_EMAIL');
  const appBaseUrl = Deno.env.get('APP_BASE_URL');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!resendKey || !fromEmail || !appBaseUrl || !supabaseUrl || !anonKey || !serviceKey) {
    return fail(cors, 'misconfigured', 500);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return fail(cors, 'unauthenticated', 401);

  let body: InviteRequest;
  try {
    body = await req.json() as InviteRequest;
  } catch {
    return fail(cors, 'invalid_request', 400);
  }
  if (body.action !== 'create' && body.action !== 'resend') return fail(cors, 'invalid_request', 400);
  if (body.action === 'create') {
    if (typeof body.email !== 'string' || typeof body.role !== 'string') {
      return fail(cors, 'invalid_request', 400);
    }
    if (!(body.role in ROLE_LABEL)) return fail(cors, 'role_not_invitable', 400);
  } else if (typeof body.invitationId !== 'string') {
    return fail(cors, 'invalid_request', 400);
  }

  // Anon key + the caller's JWT: invitation RPCs still run as the caller, so
  // auth_org()/auth_role() remain the mutation boundary. The service client below only reserves
  // and settles the bounded external-email lease; it never receives invitation data or tokens.
  const supabase = createClient(
    supabaseUrl,
    anonKey,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return fail(cors, 'unauthenticated', 401);

  const profileResult = await supabase.from('profiles').select('org_id, role, active')
    .eq('id', userData.user.id).maybeSingle();
  if (profileResult.error) return fail(cors, 'service_unavailable', 503);
  if (!profileResult.data?.active || profileResult.data.role !== 'owner') {
    return fail(cors, 'not_owner', 403);
  }
  const orgId = profileResult.data.org_id;
  if (typeof orgId !== 'string') return fail(cors, 'not_owner', 403);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const rpc = serviceRpc(admin);
  const presentedCorrelation = req.headers.get('x-correlation-id') ?? '';
  const correlationId = UUID.test(presentedCorrelation)
    ? presentedCorrelation
    : crypto.randomUUID();
  let reservation;
  try {
    reservation = await reserveOrganizationEgress(rpc, {
      orgId,
      kind: 'invitation_email',
      correlationId,
      ttlSeconds: 30,
    });
  } catch {
    return fail(cors, 'service_unavailable', 503);
  }
  if (!reservation.lease) {
    if (reservation.settledOutcome === 'delivered') {
      return ok(cors, { ok: true, idempotent: true });
    }
    return fail(
      cors,
      reservation.settledOutcome ? 'email_failed' : 'org_unavailable',
      reservation.settledOutcome ? 502 : 409,
    );
  }
  const egressLease = reservation.lease;
  if (egressLease.idempotent) {
    return fail(cors, 'service_unavailable', 409);
  }

  let issued: IssuedInvitation;
  if (body.action === 'create') {
    const { data, error } = await supabase.rpc('create_invitation', {
      p_email: body.email,
      p_role: body.role,
    });
    if (error) {
      const code = codeFromPgError(error.message);
      try {
        await releaseOrganizationEgress(rpc, egressLease, {
          outcome: 'failed',
          evidenceCode: `invitation_${code}`,
        });
      } catch {
        return fail(cors, 'service_unavailable', 503);
      }
      return fail(cors, code, code === 'invite_cooldown' || code === 'invite_daily_limit' ? 429 : 403);
    }
    issued = data as IssuedInvitation;
  } else {
    const { data, error } = await supabase.rpc('resend_invitation', { p_id: body.invitationId });
    if (error) {
      const code = codeFromPgError(error.message);
      try {
        await releaseOrganizationEgress(rpc, egressLease, {
          outcome: 'failed',
          evidenceCode: `invitation_${code}`,
        });
      } catch {
        return fail(cors, 'service_unavailable', 503);
      }
      return fail(cors, code, code === 'invite_cooldown' || code === 'invite_daily_limit' ? 429 : 403);
    }
    issued = data as IssuedInvitation;
  }

  const link = `${appBaseUrl.replace(/\/+$/, '')}/accept-invite?token=${encodeURIComponent(issued.token)}`;
  const roleLabel = ROLE_LABEL[issued.role] ?? issued.role;

  try {
    await runReservedEgress({
      reserve: () => Promise.resolve(egressLease),
      perform: async () => {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
            // Resend retains this key for 24 hours, so response/settlement retries cannot send a
            // second copy of the same token-bearing email.
            'Idempotency-Key': `supplyflow-invite/${correlationId}`,
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [issued.email],
            subject: `הוזמנת להצטרף ל-${issued.org_name} ב-SupplyFlow`,
            html: emailHtml(issued.org_name, roleLabel, link, issued.expires_at),
            text: emailText(issued.org_name, roleLabel, link),
          }),
          signal: AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS),
        });

        if (!res.ok) {
          // The status is safe to log; the body may echo the recipient, and `link` carries token.
          console.error('resend rejected the invitation email, status', res.status);
          throw new EmailProviderError(res.status);
        }
        return res.status;
      },
      settle: (lease, outcome) => {
        const providerStatus = outcome.ok
          ? outcome.result
          : outcome.error instanceof EmailProviderError
          ? outcome.error.status
          : null;
        return releaseOrganizationEgress(rpc, lease, {
          outcome: outcome.ok ? 'delivered' : 'failed',
          evidenceCode: outcome.ok ? 'resend_accepted' : 'resend_failed',
          providerStatus,
        });
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'organization_egress_settlement_failed') {
      return fail(cors, 'service_unavailable', 503);
    }
    return fail(cors, 'email_failed', 502);
  }

  // Deliberately no token in the response -- the browser never needs it.
  return ok(cors, {
    ok: true,
    invitationId: issued.invitation_id,
    email: issued.email,
    expiresAt: issued.expires_at,
  });
});

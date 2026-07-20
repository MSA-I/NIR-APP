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
//   SUPABASE_URL / SUPABASE_ANON_KEY -- injected by the platform

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';

/** Echo the caller's Origin only when it is on the allowlist -- never a blanket '*'. */
function corsFor(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('APP_BASE_URL') ?? '')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  const origin = req.headers.get('Origin')?.replace(/\/+$/, '') ?? '';

  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] ?? ''),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

type ErrorCode =
  | 'unauthenticated' | 'not_owner' | 'invalid_request' | 'invalid_email'
  | 'already_member' | 'role_not_invitable' | 'invitation_unknown'
  | 'invitation_accepted' | 'invitation_revoked' | 'email_failed' | 'misconfigured';

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
  owner: 'הנהלה',
  kitchen: 'מנהל מטבח',
  office: 'מזכירות',
  payer: 'מבצע העברות',
  accountant: 'רואה חשבון',
};

/** Hebrew message per error code -- the UI shows these verbatim. */
const MESSAGE: Record<ErrorCode, string> = {
  unauthenticated: 'נדרשת התחברות',
  not_owner: 'רק בעל העסק יכול להזמין משתמשים',
  invalid_request: 'בקשה לא תקינה',
  invalid_email: 'כתובת אימייל לא תקינה',
  already_member: 'כתובת האימייל הזו כבר משויכת למשתמש בעסק',
  role_not_invitable: 'לא ניתן להזמין תפקיד זה דרך המסך הזה',
  invitation_unknown: 'ההזמנה לא נמצאה',
  invitation_accepted: 'ההזמנה כבר נוצלה',
  invitation_revoked: 'ההזמנה בוטלה',
  email_failed: 'ההזמנה נוצרה אך שליחת המייל נכשלה — נסה "שליחה מחדש"',
  misconfigured: 'שירות המיילים אינו מוגדר בסביבה זו',
};

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
  if (!resendKey || !fromEmail || !appBaseUrl) return fail(cors, 'misconfigured', 500);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return fail(cors, 'unauthenticated', 401);

  let body: InviteRequest;
  try {
    body = await req.json() as InviteRequest;
  } catch {
    return fail(cors, 'invalid_request', 400);
  }
  if (body.action !== 'create' && body.action !== 'resend') return fail(cors, 'invalid_request', 400);

  // Anon key + the caller's JWT: every RPC below runs as the caller, so auth_org()/auth_role()
  // decide what they may do. No service_role anywhere in this function.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return fail(cors, 'unauthenticated', 401);

  let issued: IssuedInvitation;
  if (body.action === 'create') {
    if (typeof body.email !== 'string' || typeof body.role !== 'string') return fail(cors, 'invalid_request', 400);
    if (!(body.role in ROLE_LABEL)) return fail(cors, 'role_not_invitable', 400);

    const { data, error } = await supabase.rpc('create_invitation', {
      p_email: body.email,
      p_role: body.role,
    });
    if (error) return fail(cors, codeFromPgError(error.message), 403);
    issued = data as IssuedInvitation;
  } else {
    if (typeof body.invitationId !== 'string') return fail(cors, 'invalid_request', 400);

    const { data, error } = await supabase.rpc('resend_invitation', { p_id: body.invitationId });
    if (error) return fail(cors, codeFromPgError(error.message), 403);
    issued = data as IssuedInvitation;
  }

  const link = `${appBaseUrl.replace(/\/+$/, '')}/accept-invite?token=${encodeURIComponent(issued.token)}`;
  const roleLabel = ROLE_LABEL[issued.role] ?? issued.role;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromEmail,
      to: [issued.email],
      subject: `הוזמנת להצטרף ל-${issued.org_name} ב-SupplyFlow`,
      html: emailHtml(issued.org_name, roleLabel, link, issued.expires_at),
      text: emailText(issued.org_name, roleLabel, link),
    }),
  });

  if (!res.ok) {
    // The status is safe to log; the body may echo the recipient, and `link` carries the token.
    console.error('resend rejected the invitation email, status', res.status);
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

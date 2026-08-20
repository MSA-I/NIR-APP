// email-sender -- delivers a purchase order to its supplier over the REAL email provider.
//
// The browser calls this with the caller's JWT after an owner/office user presses "שליחה
// במייל". Authorization is NOT re-implemented here: claim_email_order_message (0168) enforces
// the role, the tenant, the supplier's communication preferences and the attempt ceiling, and
// mints the portal link whose raw token exists only inside this request. The provider call runs
// under an organization egress lease (kind supplier_order_email); the outcome settles through
// service_settle_email_order_message, which is ALSO what stamps the order `sent` -- the order
// status follows the observed provider event, never the click (CLAUDE.md iron rule).
//
// Required environment (supabase secrets set ...):
//   RESEND_API_KEY     -- Resend API key (already set for send-invite)
//   ORDERS_FROM_EMAIL  -- verified sender for order mail, e.g. "InPlace <orders@example.co.il>"
//                         (falls back to INVITE_FROM_EMAIL; sandbox senders set deliveryLimited)
//   APP_BASE_URL       -- portal links are built as {APP_BASE_URL}/portal#token=...
//   ALLOWED_ORIGINS    -- optional CORS allowlist, the send-invite convention
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY -- injected by the platform
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';
import {
  releaseOrganizationEgress,
  reserveOrganizationEgress,
  type ServiceRpc,
} from '../_shared/organization-egress.ts';
import { runReservedEgress } from '../_shared/reserved-egress.ts';
import {
  renderOrderEmail,
  TEMPLATE_VERSION,
  type OrderTemplateInput,
  type OrderTemplateName,
  type TemplateLocale,
} from './templates.ts';

const EMAIL_PROVIDER_TIMEOUT_MS = 15_000;

class EmailProviderError extends Error {
  constructor(readonly status: number) {
    super(`provider_status_${status}`);
  }
}

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

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

interface ClaimedSend {
  message_id: string;
  state: 'claimed' | 'already_sent' | 'in_flight' | 'ambiguous';
  status?: string;
  attempt?: number;
  to_email?: string;
  locale?: TemplateLocale;
  template_name?: OrderTemplateName;
  template_version?: number;
  portal_token?: string;
  link_expires_at?: string;
  order_snapshot?: {
    order_number: number;
    revision_number: number;
    expected_date: string | null;
    notes: string | null;
    supplier_name: string | null;
    org_name: string;
    items: OrderTemplateInput['items'];
  };
  correlation_id?: string;
  org_id?: string;
}

Deno.serve(async (request) => {
  const cors = corsFor(request);
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('ORDERS_FROM_EMAIL') ?? Deno.env.get('INVITE_FROM_EMAIL');
  const appBaseUrl = Deno.env.get('APP_BASE_URL');
  if (!supabaseUrl || !anonKey || !serviceKey || !resendKey || !fromEmail || !appBaseUrl) {
    return json({ error: 'misconfigured' }, 500, cors);
  }

  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return json({ error: 'unauthenticated' }, 401, cors);

  let body: { action?: string; orderId?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_request' }, 400, cors);
  }
  if (body.action !== 'send_order' || typeof body.orderId !== 'string') {
    return json({ error: 'invalid_request' }, 400, cors);
  }

  // The caller's own client: the RPC is the security boundary (auth_org/auth_role inside).
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const rpc: ServiceRpc = (name, args) => admin.rpc(name, args);

  const claim = await caller.rpc('claim_email_order_message', {
    p_order_id: body.orderId,
    p_reason: body.reason ?? null,
  });
  if (claim.error) {
    const code = claim.error.message ?? 'claim_failed';
    const known = ['not_authorized', 'order_unknown', 'email_channel_disabled',
      'email_destination_missing', 'email_order_not_sendable', 'email_message_retry_limit',
      'proposal_pending_decision', 'email_message_invalid'];
    const matched = known.find((k) => code.includes(k));
    return json({ error: matched ?? 'claim_failed' }, matched ? 409 : 500, cors);
  }
  const claimed = claim.data as ClaimedSend;
  if (claimed.state !== 'claimed') {
    // Nothing was sent: the thread is already with the provider, in flight, or frozen.
    return json({ ok: true, state: claimed.state, status: claimed.status ?? null }, 200, cors);
  }
  if (!claimed.portal_token || !claimed.order_snapshot || !claimed.to_email || !claimed.org_id) {
    return json({ error: 'claim_incomplete' }, 500, cors);
  }

  const snapshot = claimed.order_snapshot;
  const portalUrl = `${appBaseUrl.replace(/\/+$/, '')}/portal#token=${encodeURIComponent(claimed.portal_token)}`;
  const rendered = renderOrderEmail(
    claimed.template_name ?? 'new_purchase_order',
    claimed.locale ?? 'he',
    {
      orgName: snapshot.org_name,
      supplierName: snapshot.supplier_name,
      orderNumber: snapshot.order_number,
      revisionNumber: snapshot.revision_number,
      expectedDate: snapshot.expected_date,
      notes: snapshot.notes,
      items: snapshot.items ?? [],
      portalUrl,
      linkExpiresAt: claimed.link_expires_at ?? null,
    },
  );

  let reservation;
  try {
    reservation = await reserveOrganizationEgress(rpc, {
      orgId: claimed.org_id,
      kind: 'supplier_order_email',
      correlationId: claimed.correlation_id ?? crypto.randomUUID(),
      ttlSeconds: 60,
    });
  } catch {
    return json({ error: 'service_unavailable' }, 503, cors);
  }
  if (!reservation.lease) {
    // A previously settled identical correlation means this attempt already ran to completion.
    return json({ ok: reservation.settledOutcome === 'delivered', state: 'egress_settled' },
      reservation.settledOutcome === 'delivered' ? 200 : 502, cors);
  }

  let providerStatus: number | null = null;
  let providerMessageId: string | null = null;
  let sendOk = false;
  try {
    await runReservedEgress({
      reserve: () => Promise.resolve(reservation.lease),
      perform: async () => {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
            // Retained by Resend for 24h: a retry of THIS attempt can never send a second copy.
            'Idempotency-Key': `supplyflow-order/${claimed.message_id}/${claimed.attempt}`,
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [claimed.to_email],
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          }),
          signal: AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS),
        });
        providerStatus = res.status;
        if (!res.ok) {
          console.error('resend rejected the order email, status', res.status);
          throw new EmailProviderError(res.status);
        }
        const payload = await res.json().catch(() => null) as { id?: string } | null;
        providerMessageId = payload?.id ?? null;
        return res.status;
      },
      settle: (lease, outcome) => releaseOrganizationEgress(rpc, lease, {
        outcome: outcome.ok ? 'delivered' : 'failed',
        evidenceCode: outcome.ok ? 'resend_accepted' : 'resend_failed',
        providerStatus: outcome.ok
          ? providerStatus
          : outcome.error instanceof EmailProviderError ? outcome.error.status : null,
      }),
    });
    sendOk = true;
  } catch {
    sendOk = false;
  }

  const settlement = await admin.rpc('service_settle_email_order_message', {
    p_message_id: claimed.message_id,
    p_outcome: sendOk ? 'accepted' : 'failed',
    p_provider_message_id: providerMessageId,
    p_provider_status: providerStatus,
    p_error_code: sendOk ? null : (providerStatus ? `provider_${providerStatus}` : 'provider_unreachable'),
    p_error_message: sendOk ? null : 'שליחת המייל נכשלה מול ספק המייל',
  });
  if (settlement.error) {
    console.error('email-sender settlement failed', settlement.error.code);
    return json({ error: 'settlement_failed' }, 500, cors);
  }

  return json({
    ok: sendOk,
    state: sendOk ? 'accepted' : 'failed',
    attempt: claimed.attempt,
    templateVersion: TEMPLATE_VERSION,
    // Resend accepts sandbox sends it will only deliver to the account owner (DEBT §25).
    deliveryLimited: /@resend\.dev>?\s*$/i.test(fromEmail.trim()),
  }, sendOk ? 200 : 502, cors);
});

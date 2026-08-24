// whatsapp-sender -- delivers a purchase order to its supplier over the tenant's OWN WhatsApp
// sender, through the provider adapter in core.ts.
//
// AUTHORIZATION IS NOT RE-IMPLEMENTED HERE. The browser's JWT is forwarded to
// claim_whatsapp_order_message (0028/0029, generalized by 0191), which enforces the role, the
// tenant, the supplier's reachable number, the active connection, the attempt ceiling and the
// claim lease. This function performs the provider call and settles the observed outcome; the
// order becomes `sent` only inside complete_whatsapp_order_message, on provider acceptance --
// never on the click.
//
// #240: every organization connects its own sender. There is no central InPlace number and no
// shared credential: the credential is fetched per request from that tenant's Vault row through
// service_get_whatsapp_provider_connection, is used once, and is never returned to the browser,
// never logged and never written anywhere.
//
// #239 STATUS: Twilio is SELECTED / ACCOUNT_NOT_PROVEN / CREDENTIALS_NOT_CONFIGURED /
// NOT_INTEGRATED. This function has never been deployed and has never called a provider.
//
// Required environment (supabase secrets set ...):
//   APP_BASE_URL   -- used to derive the status-callback URL the provider will call back on
//   ALLOWED_ORIGINS -- optional CORS allowlist, the send-invite/email-sender convention
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY -- injected by the platform
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';
import {
  buildProviderRequest,
  classifyProviderOutcome,
  resolveSenderConfiguration,
  type MessageKind,
  type ProviderConnection,
} from './core.ts';

const PROVIDER_TIMEOUT_MS = 15_000;

function corsFor(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('APP_BASE_URL') ?? '')
    .split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean);
  const origin = req.headers.get('Origin')?.replace(/\/+$/, '') ?? '';
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] ?? ''),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
  delivery_status: string;
  should_send?: boolean;
  idempotent?: boolean;
  recipient_number?: string;
  order?: { number?: number; expected_date?: string | null; total?: number };
  supplier?: { name?: string };
  connection?: {
    provider?: string;
    provider_sender_id?: string;
    provider_account_id?: string;
    template_name?: string;
    language_code?: string;
  };
}

Deno.serve(async (request) => {
  const cors = corsFor(request);
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const appBaseUrl = Deno.env.get('APP_BASE_URL') ?? '';
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'misconfigured' }, 500, cors);

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

  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const claim = await caller.rpc('claim_whatsapp_order_message', {
    p_order_id: body.orderId,
    p_reason: body.reason ?? null,
  });
  if (claim.error) {
    const message = claim.error.message ?? 'claim_failed';
    const known = ['whatsapp_not_authorized', 'whatsapp_order_unknown', 'whatsapp_connection_inactive',
      'whatsapp_supplier_number_missing', 'whatsapp_order_not_ready', 'whatsapp_message_retry_limit',
      'whatsapp_message_invalid', 'whatsapp_recipient_snapshot_missing'];
    const matched = known.find((code) => message.includes(code));
    return json({ error: matched ?? 'claim_failed' }, matched ? 409 : 500, cors);
  }
  const claimed = claim.data as ClaimedSend;
  if (claimed.should_send !== true) {
    // Already with the provider, in flight, or frozen for reconciliation. Nothing is sent and
    // nothing is claimed about delivery.
    return json({ ok: true, state: claimed.delivery_status, idempotent: true }, 200, cors);
  }

  const provider = claimed.connection?.provider ?? '';
  const providerSenderId = claimed.connection?.provider_sender_id ?? '';

  const lookup = await admin.rpc('service_get_whatsapp_provider_connection', {
    p_provider: provider,
    p_provider_sender_id: providerSenderId,
  });
  const connectionRow = lookup.error ? null : lookup.data as {
    status?: string;
    credential?: string;
    provider_account_id?: string;
    provider_sender_id?: string;
    order_template_name?: string;
    reminder_template_name?: string;
    language_code?: string;
  };

  const configuration = resolveSenderConfiguration({
    status: connectionRow?.status ?? 'unknown',
    appBaseUrl,
    credential: connectionRow?.credential ?? '',
  });
  if (configuration.state === 'misconfigured') {
    // Fail closed and say so. The claimed attempt is settled as failed rather than left to
    // expire into `unknown`, because nothing reached a provider: this is a configuration
    // refusal, not an ambiguous send. The manual wa.me share stays available, labelled manual.
    await admin.rpc('fail_whatsapp_order_message', {
      p_message_id: claimed.message_id,
      p_error_code: 'misconfigured',
      p_error_message: 'ערוץ ה-WhatsApp אינו מוגדר או אינו פעיל; ההודעה לא נשלחה',
    });
    return json({
      error: 'misconfigured',
      reason: configuration.reason,
      manualShareAvailable: true,
      providerDelivery: false,
    }, 409, cors);
  }

  const connection: ProviderConnection = {
    provider: 'twilio',
    providerAccountId: connectionRow?.provider_account_id ?? '',
    providerSenderId: connectionRow?.provider_sender_id ?? providerSenderId,
    orderTemplateName: claimed.connection?.template_name ?? connectionRow?.order_template_name ?? '',
    reminderTemplateName: connectionRow?.reminder_template_name ?? '',
    languageCode: connectionRow?.language_code ?? claimed.connection?.language_code ?? 'he',
  };
  if (provider !== 'twilio') {
    await admin.rpc('fail_whatsapp_order_message', {
      p_message_id: claimed.message_id,
      p_error_code: 'provider_not_implemented',
      p_error_message: 'ספק ההודעות המוגדר אינו נתמך בגרסה זו; ההודעה לא נשלחה',
    });
    return json({ error: 'provider_not_implemented' }, 409, cors);
  }

  const kind: MessageKind = 'order';
  const built = buildProviderRequest({
    connection,
    kind,
    recipient: claimed.recipient_number ?? '',
    // Template variables are the order's own facts. Nothing free-text and nothing from a
    // provider payload ever reaches a template slot.
    variables: {
      '1': claimed.supplier?.name ?? '',
      '2': String(claimed.order?.number ?? ''),
      '3': claimed.order?.expected_date ?? '',
    },
    statusCallbackUrl: configuration.statusCallbackUrl,
  });
  if (!built.ok) {
    await admin.rpc('fail_whatsapp_order_message', {
      p_message_id: claimed.message_id,
      p_error_code: built.reason,
      p_error_message: 'לא ניתן היה להרכיב את בקשת השליחה מול ספק ההודעות',
    });
    return json({ error: built.reason }, 409, cors);
  }

  let httpStatus = 0;
  let payload: { sid?: string; code?: string | number; message?: string } | null = null;
  let reachedProvider = false;
  try {
    const response = await fetch(built.url, {
      method: built.method,
      headers: {
        // Basic auth over the tenant's own account identity. Built here and nowhere else, so the
        // credential never enters a value that could be logged or returned.
        Authorization: `Basic ${btoa(`${connection.providerAccountId}:${connectionRow?.credential ?? ''}`)}`,
        'Content-Type': built.contentType,
      },
      body: built.body,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    reachedProvider = true;
    httpStatus = response.status;
    payload = await response.json().catch(() => null);
  } catch {
    reachedProvider = false;
  }

  const outcome = reachedProvider
    ? classifyProviderOutcome(httpStatus, payload)
    : {
      outcome: 'ambiguous' as const,
      errorCode: 'provider_unreachable',
      errorMessage: 'לא התקבלה תשובה חד-משמעית מספק ההודעות',
    };

  if (outcome.outcome === 'accepted') {
    const settled = await admin.rpc('complete_whatsapp_order_message', {
      p_message_id: claimed.message_id,
      p_meta_message_id: outcome.providerMessageId,
    });
    if (settled.error) {
      console.error('whatsapp-sender settlement failed', settled.error.code);
      return json({ error: 'settlement_failed' }, 500, cors);
    }
    return json({ ok: true, state: 'accepted' }, 200, cors);
  }

  if (outcome.outcome === 'failed') {
    await admin.rpc('fail_whatsapp_order_message', {
      p_message_id: claimed.message_id,
      p_error_code: outcome.errorCode,
      p_error_message: outcome.errorMessage,
    });
    return json({ ok: false, state: 'failed', errorCode: outcome.errorCode }, 502, cors);
  }

  // Ambiguous: freeze for human reconciliation rather than risk a duplicate supplier message.
  await admin.rpc('mark_whatsapp_message_ambiguous', {
    p_message_id: claimed.message_id,
    p_error_code: outcome.errorCode,
    p_error_message: outcome.errorMessage,
    p_meta_message_id: null,
  });
  return json({ ok: false, state: 'unknown', errorCode: outcome.errorCode }, 502, cors);
});

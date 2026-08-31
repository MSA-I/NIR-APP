// billing-webhook -- the signed door for provider billing events.
//
// 0157 built the storage, the idempotency, the attribution and the audit and said what remained:
// "a signature check and a parser". Both now exist -- the signature check in
// _shared/billing-adapter.ts, implemented from Paddle's published contract (read 23.08.2026,
// https://developer.paddle.com/webhooks/about/signature-verification/), and the decision in
// ./core.ts, which is where every test points. This file is wiring and nothing else: it must never
// read, parse or reformat the request body, because the bytes that are verified have to be the
// bytes that arrived. core.test.ts asserts that as a property of this source.
//
// verify_jwt = false, and for a concrete reason rather than by habit. There is no user here and no
// Authorization header to check: the credential IS the provider's signature over the body, the
// tenant-export and supplier-portal shape. A JWT gate in front of this function would reject every
// genuine delivery and secure nothing.
//
// WHAT THIS FUNCTION CANNOT DO. Per OPEN-DECISIONS #213 Paddle is
// SELECTED / ACCOUNT_NOT_PROVEN / KYC_NOT_PROVEN / ISRAEL_PAYOUT_NOT_PROVEN / NOT_INTEGRATED, and
// 0187 seeds every provider disabled with no function able to enable one. So even a perfectly
// signed, perfectly attributed event changes no entitlement today: it is recorded, dead-lettered
// with `provider_not_enabled`, and visible in the reconciliation reads. Deploying this function is
// not billing activation.
//
// Required environment (supabase secrets set ...):
//   BILLING_PROVIDER          -- which provider this deployment serves; 'paddle'
//   PADDLE_WEBHOOK_SECRET     -- the notification destination's endpoint secret (pdl_ntfset_...)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY -- injected by the platform
// Optional, and only for the activation email (0268). Absent, events are still processed and the
// owed email simply waits in the ledger:
//   RESEND_API_KEY / INVITE_FROM_EMAIL / APP_BASE_URL
// Optional, for OUTBOUND Paddle calls this function does not make today:
//   PADDLE_API_KEY / PADDLE_ENVIRONMENT ('sandbox' | 'production', no default)
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';
import { billingAdapterFor } from '../_shared/billing-adapter.ts';
import { renderActivationEmail, type ActivationLocale } from '../_shared/activation-email.ts';
import { SUPPORT_REPLY_TO } from '../_shared/reply-to.ts';
import { handleWebhook, type WebhookPorts } from './core.ts';

const EMAIL_PROVIDER_TIMEOUT_MS = 15_000;

/**
 * Sends at most ONE owed activation email, then returns.
 *
 * WHY THIS IS SAFE TO CALL FROM A WEBHOOK. It never throws and never changes the response: the
 * provider is told whether its EVENT was held, and an email that failed to send is a separate
 * fact with its own row and its own retry. A webhook that answered 500 because a mail server was
 * slow would make Paddle redeliver an event it has already applied.
 *
 * WHY IT CANNOT SEND TWICE. The claim takes a lease inside the database (0268), and the ledger is
 * keyed on the organization, so the debt exists at most once in the first place. Resend's
 * Idempotency-Key is a second belt covering a retry inside twenty-four hours; the primary key is
 * what covers the three days Paddle keeps redelivering for.
 *
 * WHY IT DOES NOTHING TODAY. 0187 seeds Paddle disabled, so no activation transition runs, so no
 * row is ever owed and `service_claim_subscription_activation_email` always answers `idle`.
 */
async function sendOwedActivationEmail(admin: SupabaseClient): Promise<void> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('INVITE_FROM_EMAIL');
  const appBaseUrl = Deno.env.get('APP_BASE_URL');
  // Not an error: a deployment that only receives events and sends no mail is a real state, and
  // the debt simply waits in the ledger for one that can.
  if (!resendKey || !fromEmail || !appBaseUrl) return;

  const claim = await admin.rpc('service_claim_subscription_activation_email');
  if (claim.error) {
    console.error('activation email claim failed', claim.error.code);
    return;
  }
  const claimed = claim.data as {
    state?: string; org_id?: string; to_email?: string;
    plan_label?: string; locale?: string; attempt?: number;
  } | null;
  if (!claimed || claimed.state !== 'claimed') return;
  if (!claimed.org_id || !claimed.to_email || !claimed.plan_label) {
    console.error('activation email claim was incomplete');
    return;
  }

  const rendered = renderActivationEmail(
    (claimed.locale === 'en' ? 'en' : 'he') as ActivationLocale,
    { planLabel: claimed.plan_label, appUrl: appBaseUrl.replace(/\/+$/, '') },
  );

  let providerMessageId: string | null = null;
  let errorCode: string | null = null;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `inplace-activation/${claimed.org_id}/${claimed.attempt ?? 1}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [claimed.to_email],
        // InPlace speaking on its own behalf, so a reply reaches a human here (_shared/reply-to.ts).
        reply_to: SUPPORT_REPLY_TO,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
      signal: AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error('resend rejected the activation email, status', response.status);
      errorCode = `provider_${response.status}`;
    } else {
      const payload = await response.json().catch(() => null) as { id?: string } | null;
      providerMessageId = payload?.id ?? null;
    }
  } catch {
    errorCode = 'provider_unreachable';
  }

  const settled = await admin.rpc('service_settle_subscription_activation_email', {
    p_org_id: claimed.org_id,
    p_outcome: errorCode === null ? 'sent' : 'failed',
    p_provider_message_id: providerMessageId,
    p_error_code: errorCode,
  });
  if (settled.error) console.error('activation email settlement failed', settled.error.code);
}

Deno.serve((incoming) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'refused' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const provider = Deno.env.get('BILLING_PROVIDER') ?? 'paddle';
  const resolved = billingAdapterFor(provider, (name) => Deno.env.get(name));
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const ports: WebhookPorts = {
    adapter: resolved.ok ? resolved.value : null,
    providerName: provider,
    adapterRefusal: resolved.ok ? undefined : { code: resolved.code, detail: resolved.detail },

    // 0157's ingestion door. It resolves the organization from the provider-customer link we wrote
    // ourselves and never from the payload, which is why nothing but the customer id is passed.
    recordEvent: async (event) => {
      const { data, error } = await admin.rpc('service_record_billing_event', {
        p_provider: event.provider,
        p_provider_event_id: event.providerEventId,
        p_event_type: event.eventType,
        p_provider_customer_id: event.providerCustomerId,
        p_payload: event.payload,
      });
      if (error) {
        console.error('billing-webhook record failed', error.code);
        return { ok: false, detail: error.code ?? 'record_failed' };
      }
      const outcome = data as { status?: string; idempotent?: boolean } | null;
      return { ok: true, status: outcome?.status, idempotent: outcome?.idempotent };
    },

    // 0187's dispatcher. Everything it refuses becomes a dead letter with a reason; nothing it
    // refuses changes entitlement.
    applyEvent: async (providerEventId, eventProvider) => {
      const { data, error } = await admin.rpc('service_apply_billing_event', {
        p_provider: eventProvider,
        p_provider_event_id: providerEventId,
      });
      if (error) {
        console.error('billing-webhook apply failed', error.code);
        return { ok: false, detail: error.code ?? 'apply_failed' };
      }
      const outcome = data as
        { status?: string; applied?: boolean; idempotent?: boolean; reason_code?: string } | null;
      return {
        ok: true,
        status: outcome?.status,
        applied: outcome?.applied,
        idempotent: outcome?.idempotent,
        reasonCode: outcome?.reason_code,
      };
    },

    // Counted, never stored: private.billing_events uniques on the event id the request CLAIMS, so
    // writing an unverified one would let an attacker pre-register an identifier and make the
    // genuine delivery look like a replay. The counter holds no caller-supplied value at all.
    recordRejection: async (rejectedProvider, reasonCode) => {
      const { error } = await admin.rpc('service_record_billing_ingress_rejection', {
        p_provider: rejectedProvider,
        p_reason_code: reasonCode,
      });
      if (error) console.error('billing-webhook rejection counter failed', error.code);
    },
  };

  // The email runs AFTER the decision, never inside it. core.ts owns what the provider is told,
  // and core.test.ts pins that this file adds no logic to that answer; sending mail is a separate
  // consequence with its own ledger, and it must not be able to change a status code.
  return handleWebhook(incoming, ports).then(async (response) => {
    if (response.status === 200) {
      await sendOwedActivationEmail(admin).catch(() => {});
    }
    return response;
  });
});

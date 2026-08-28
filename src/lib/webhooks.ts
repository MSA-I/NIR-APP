// Owner-managed webhooks — client side of supabase/migrations/0198_owner_webhook_verification.sql
// and supabase/functions/webhook-verify (#98 / #253).
//
// Two things this file is careful about.
//
// 1. It is NOT the security boundary and must not read as one. `webhookUrlRejection` exists so
//    the owner learns "that address is not reachable from here" while typing, instead of after a
//    round trip. The refusal that counts is `private.webhook_url_rejection` inside the command,
//    and the one that closes DNS rebinding is the connect-time guard in the Edge helper — the
//    browser cannot resolve a name and does not pretend to. The corpus in webhooks.spec.ts is
//    the same table as the SQL suite and the Deno suite, so a drift between the three shows up
//    as a failing row rather than as a quietly weaker form.
//
// 2. It never shows a raw server string. #98 forbids raw delivery errors on this surface, and a
//    Postgres message can name an internal relation or an upstream host. Every code the owner
//    can provoke has a Hebrew sentence; everything else collapses to one honest fallback.

import { supabase } from './supabase';
import type { TKey } from './i18n/t.ts';
import { fmtDateTime, fmtNum } from './format';

/** Mirrors the projection of `public.read_webhook_subscriptions()`. No secret, no error text. */
export interface WebhookSubscription {
  id: string;
  target: string;
  url: string;
  event_types: string[];
  active: boolean;
  description: string | null;
  verification_state: 'verified' | 'pending' | 'unverified';
  verified_at: string | null;
  verification_expires_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  pending_count: number;
  failed_attempt_count: number;
  dead_letter_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * An invented guardrail, not a business rule (the #90/#96/#97 precedent): the signing secret is
 * the only thing standing between a receiver and a forged delivery, and the server refuses
 * anything shorter. Documented in 0198 and reported for an OPEN-DECISIONS row.
 */
export const MIN_WEBHOOK_SECRET_LENGTH = 32;
export const MAX_WEBHOOK_SECRET_LENGTH = 200;

/**
 * The event taxonomy, copied from `private.domain_event_map` (0063). It is duplicated here
 * because the map is a private table the browser cannot read — and duplication is only
 * acceptable because `p76_owner_webhook_verification.sql` asserts every value below still exists
 * in that table. Add an event there and this list stays legal; rename one and the suite fails.
 */
export const WEBHOOK_EVENT_CHOICES: ReadonlyArray<{ value: string; labelKey: TKey }> = [
  { value: 'supplier.created', labelKey: 'webhooks.eventSupplierCreated' },
  { value: 'supplier.updated', labelKey: 'webhooks.eventSupplierUpdated' },
  { value: 'supplier.bank_details_changed', labelKey: 'webhooks.eventSupplierBankDetailsChanged' },
  { value: 'product.created', labelKey: 'webhooks.eventProductCreated' },
  { value: 'supplier_price.updated', labelKey: 'webhooks.eventSupplierPriceUpdated' },
  { value: 'supplier_price_list.submitted', labelKey: 'webhooks.eventSupplierPriceListSubmitted' },
  { value: 'purchase_order.created', labelKey: 'webhooks.eventPurchaseOrderCreated' },
  { value: 'purchase_order.approved', labelKey: 'webhooks.eventPurchaseOrderApproved' },
  { value: 'purchase_order.sent', labelKey: 'webhooks.eventPurchaseOrderSent' },
  { value: 'goods_receipt.completed', labelKey: 'webhooks.eventGoodsReceiptCompleted' },
  { value: 'invoice.created', labelKey: 'webhooks.eventInvoiceCreated' },
  { value: 'invoice.approved', labelKey: 'webhooks.eventInvoiceApproved' },
  { value: 'invoice.review_required', labelKey: 'webhooks.eventInvoiceReviewRequired' },
  { value: 'credit.created', labelKey: 'webhooks.eventCreditCreated' },
  { value: 'payment_request.created', labelKey: 'webhooks.eventPaymentRequestCreated' },
  { value: 'payment_request.approved', labelKey: 'webhooks.eventPaymentRequestApproved' },
  { value: 'payment.executed', labelKey: 'webhooks.eventPaymentExecuted' },
  { value: 'bank_transaction.imported', labelKey: 'webhooks.eventBankTransactionImported' },
  { value: 'reconciliation.completed', labelKey: 'webhooks.eventReconciliationCompleted' },
  { value: 'document.uploaded', labelKey: 'webhooks.eventDocumentUploaded' },
  { value: 'document.processing_completed', labelKey: 'webhooks.eventDocumentProcessingCompleted' },
  { value: 'document.processing_failed', labelKey: 'webhooks.eventDocumentProcessingFailed' },
  { value: 'month_export.sent', labelKey: 'webhooks.eventMonthExportSent' },
  { value: 'user.access_changed', labelKey: 'webhooks.eventUserAccessChanged' },
];

/* ---------- the client-side URL hint ---------- */

const LOCAL_SUFFIXES = [
  'localhost', 'local', 'internal', 'intranet', 'lan', 'corp', 'home',
  'home.arpa', 'in-addr.arpa', 'ip6.arpa', 'arpa', 'test', 'invalid', 'example',
];

/** inet_aton spellings: `0x7f.1`, `0177.0.0.1` and `2130706433` are all 127.0.0.1. */
function looksLikeAddressLiteral(host: string): boolean {
  const labels = host.split('.');
  if (labels.length === 0 || labels.length > 4) return false;
  return labels.every((label) => /^([0-9]+|0[xX][0-9a-fA-F]+)$/.test(label));
}

/** `null` when the URL may be submitted; otherwise the same code the server would answer with. */
export function webhookUrlRejection(value: string): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '' || trimmed.length > 2000) return 'webhook_url_invalid';

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'webhook_url_invalid';
  }
  if (url.protocol !== 'https:') return 'webhook_url_scheme_rejected';
  if (url.username !== '' || url.password !== '') return 'webhook_url_credentials_rejected';
  if (url.port !== '' && url.port !== '443') return 'webhook_url_port_rejected';

  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (host === '') return 'webhook_url_invalid';
  if (host.includes(':')) return 'webhook_url_ip_literal_rejected';
  if (looksLikeAddressLiteral(host)) return 'webhook_url_ip_literal_rejected';
  if (LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return 'webhook_url_local_name_rejected';
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return 'webhook_url_host_not_dns';
  }
  return null;
}

export function webhookSecretRejection(secret: string): string | null {
  const length = (secret ?? '').length;
  return length < MIN_WEBHOOK_SECRET_LENGTH || length > MAX_WEBHOOK_SECRET_LENGTH
    ? 'webhook_secret_invalid'
    : null;
}

/* ---------- refusals, in Hebrew, never in Postgres ---------- */

/**
 * Every refusal this screen may show, as KEYS rather than sentences (the `errors.ts` precedent).
 * The map is keyed by the SERVER's code, which is what actually arrives, and the constant is
 * renamed from `WEBHOOK_ERROR` so no reader could keep compiling while printing a key.
 */
const WEBHOOK_ERROR_KEYS: Record<string, TKey> = {
  webhook_url_invalid: 'webhooks.urlInvalid',
  webhook_url_scheme_rejected: 'webhooks.urlSchemeRejected',
  webhook_url_credentials_rejected: 'webhooks.urlCredentialsRejected',
  webhook_url_port_rejected: 'webhooks.urlPortRejected',
  webhook_url_ip_literal_rejected: 'webhooks.urlIpLiteralRejected',
  webhook_url_local_name_rejected: 'webhooks.urlLocalNameRejected',
  webhook_url_host_not_dns: 'webhooks.urlHostNotDns',
  webhook_url_private_address: 'webhooks.urlPrivateAddress',
  webhook_url_unresolvable: 'webhooks.urlUnresolvable',
  webhook_secret_invalid: 'webhooks.secretInvalid',
  webhook_event_types_invalid: 'webhooks.eventTypesInvalid',
  webhook_subscription_invalid: 'webhooks.subscriptionInvalid',
  webhook_subscription_unknown: 'webhooks.subscriptionUnknown',
  webhook_not_authorized: 'webhooks.notAuthorized',
  webhook_organization_read_only: 'webhooks.organizationReadOnly',
  webhook_verification_required: 'webhooks.verificationRequired',
  webhook_verification_unknown: 'webhooks.verificationUnknown',
  webhook_verification_settled: 'webhooks.verificationSettled',
  webhook_verification_expired: 'webhooks.verificationExpired',
  webhook_verification_already_dispatched: 'webhooks.verificationAlreadyDispatched',
  webhook_verification_endpoint_changed: 'webhooks.verificationEndpointChanged',
  webhook_verification_challenge_mismatch: 'webhooks.verificationChallengeMismatch',
  webhook_verification_challenge_absent: 'webhooks.verificationChallengeAbsent',
  webhook_verification_succeeded: 'webhooks.verificationSucceeded',
  webhook_verification_failed: 'webhooks.verificationFailed',
  webhook_verification_unavailable: 'webhooks.verificationUnavailable',
  webhook_secret_unresolved: 'webhooks.secretUnresolved',
  webhook_header_invalid: 'webhooks.headerInvalid',
  webhook_connect_failed: 'webhooks.connectFailed',
  webhook_response_invalid: 'webhooks.responseInvalid',
  webhook_response_timeout: 'webhooks.responseTimeout',
  fresh_authentication_required: 'webhooks.freshAuthenticationRequired',
};

const FALLBACK: TKey = 'webhooks.fallback';

/** What `webhookErrorCode` answers when nothing known is in the text. Never the text itself. */
export const WEBHOOK_UNMAPPED = 'webhook_unmapped';

/** A refusal the screen can render, and the numbers it needs — never a server sentence. */
export interface WebhookRefusal {
  key: TKey;
  vars?: Record<string, string | number>;
}

/**
 * The CODE a failure resolves to, sanitised. Anything unrecognised becomes `WEBHOOK_UNMAPPED` —
 * never the raw text, which is the whole point: a Postgres message on this screen can name an
 * internal relation, and a delivery error can carry an upstream response body (#98, #99).
 *
 * Split out of the refusal below so a rethrow can carry the code across a boundary instead of a
 * finished sentence. It had to be: `runWebhookVerification` used to rethrow the HEBREW, and the
 * screen then looked for a code inside it, found none, and showed the generic fallback. The
 * specific refusal was being thrown away by the very function that resolved it.
 */
export function webhookErrorCode(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  const status = /webhook_verification_status_\d{3}/.exec(text);
  if (status) return status[0];
  return Object.keys(WEBHOOK_ERROR_KEYS).find((key) => text.includes(key)) ?? WEBHOOK_UNMAPPED;
}

/** The same decision, as a key the reader's own language resolves. */
export function webhookErrorRefusal(raw: unknown): WebhookRefusal {
  const code = webhookErrorCode(raw);
  const status = /^webhook_verification_status_(\d{3})$/.exec(code);
  if (status) return { key: 'webhooks.verificationStatus', vars: { status: status[1] } };
  if (code === 'webhook_secret_invalid') {
    return {
      key: 'webhooks.secretInvalid',
      vars: { min: MIN_WEBHOOK_SECRET_LENGTH, max: MAX_WEBHOOK_SECRET_LENGTH },
    };
  }
  return { key: WEBHOOK_ERROR_KEYS[code] ?? FALLBACK };
}

/* ---------- what the screen is allowed to show ---------- */

export interface WebhookHealth {
  lastSuccess: string;
  lastFailure: string;
  pending: string;
  failed: string;
  deadLettered: string;
}

/**
 * The honesty rule (CLAUDE.md): a measure with no data shows —, never 0.
 *
 * The two halves are different kinds of statement and are treated differently on purpose.
 * "Last successful delivery" with no value means NOTHING HAS EVER BEEN DELIVERED, and printing
 * a zero or an epoch date there would be a claim about reality that the data does not support.
 * The counts are the opposite: the query looked and found none, so `0` is the measurement.
 */
export function webhookHealth(row: WebhookSubscription): WebhookHealth {
  return {
    lastSuccess: row.last_success_at ? fmtDateTime(row.last_success_at) : '—',
    lastFailure: row.last_failure_at ? fmtDateTime(row.last_failure_at) : '—',
    pending: fmtNum(row.pending_count),
    failed: fmtNum(row.failed_attempt_count),
    deadLettered: fmtNum(row.dead_letter_count),
  };
}

/* ---------- the server calls ---------- */

export async function readWebhookSubscriptions(): Promise<WebhookSubscription[]> {
  const { data, error } = await supabase.rpc('read_webhook_subscriptions');
  if (error) throw new Error(error.message);
  return (data ?? []) as WebhookSubscription[];
}

/** Creates an INACTIVE, UNVERIFIED subscription. The secret goes to Vault and never comes back. */
export async function registerWebhookSubscription(input: {
  url: string;
  eventTypes: string[];
  secret: string;
  description: string | null;
  reason: string;
}): Promise<{ id: string; target: string }> {
  const { data, error } = await supabase.rpc('register_webhook_subscription', {
    p_url: input.url,
    p_event_types: input.eventTypes,
    p_secret: input.secret,
    p_description: input.description,
    p_reason: input.reason,
  });
  if (error) throw new Error(error.message);
  return data as { id: string; target: string };
}

/** Authorizes ONE outbound handshake. Owner + step-up + reason are enforced server-side. */
export async function requestWebhookVerification(
  subscriptionId: string,
  reason: string,
): Promise<{ verification_id: string; expires_at: string }> {
  const { data, error } = await supabase.rpc('request_webhook_verification', {
    p_subscription_id: subscriptionId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
  return data as { verification_id: string; expires_at: string };
}

/** Runs the handshake through the Edge helper, which holds the only SSRF-guarded transport. */
export async function runWebhookVerification(
  verificationId: string,
): Promise<{ verified: boolean; code: string }> {
  const { data, error } = await supabase.functions.invoke('webhook-verify', {
    body: { verificationId },
  });
  // The CODE, not the sentence: the screen resolves it in the reader’s language, and a
  // server string still cannot cross this line.
  if (error) throw new Error(webhookErrorCode(error));
  const outcome = data as { verified?: boolean; code?: string } | null;
  return {
    verified: outcome?.verified === true,
    code: outcome?.code ?? 'webhook_verification_unavailable',
  };
}

/** Activation AND revocation: one command, one audit action, one security event (0066 + 0198). */
export async function setWebhookSubscriptionActive(
  subscriptionId: string,
  active: boolean,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('set_webhook_subscription_active', {
    p_subscription_id: subscriptionId,
    p_active: active,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
}

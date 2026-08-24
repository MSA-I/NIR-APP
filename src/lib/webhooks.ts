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
export const WEBHOOK_EVENT_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'supplier.created', label: 'ספק נוצר' },
  { value: 'supplier.updated', label: 'ספק עודכן' },
  { value: 'supplier.bank_details_changed', label: 'פרטי בנק של ספק שונו' },
  { value: 'product.created', label: 'מוצר נוצר' },
  { value: 'supplier_price.updated', label: 'מחיר ספק עודכן' },
  { value: 'supplier_price_list.submitted', label: 'מחירון ספק הוגש' },
  { value: 'purchase_order.created', label: 'הזמנת רכש נוצרה' },
  { value: 'purchase_order.approved', label: 'הזמנת רכש אושרה' },
  { value: 'purchase_order.sent', label: 'הזמנת רכש נשלחה' },
  { value: 'goods_receipt.completed', label: 'קבלת סחורה הושלמה' },
  { value: 'invoice.created', label: 'חשבונית נוצרה' },
  { value: 'invoice.approved', label: 'חשבונית אושרה' },
  { value: 'invoice.review_required', label: 'חשבונית דורשת בדיקה' },
  { value: 'credit.created', label: 'זיכוי נוצר' },
  { value: 'payment_request.created', label: 'בקשת תשלום נוצרה' },
  { value: 'payment_request.approved', label: 'בקשת תשלום אושרה' },
  { value: 'payment.executed', label: 'תשלום בוצע' },
  { value: 'bank_transaction.imported', label: 'תנועת בנק יובאה' },
  { value: 'reconciliation.completed', label: 'התאמה בנקאית הושלמה' },
  { value: 'document.uploaded', label: 'מסמך הועלה' },
  { value: 'document.processing_completed', label: 'עיבוד מסמך הושלם' },
  { value: 'document.processing_failed', label: 'עיבוד מסמך נכשל' },
  { value: 'month_export.sent', label: 'ייצוא חודשי נשלח' },
  { value: 'user.access_changed', label: 'הרשאות משתמש שונו' },
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

const WEBHOOK_ERROR: Record<string, string> = {
  webhook_url_invalid: 'הכתובת אינה תקינה. יש להזין כתובת HTTPS מלאה.',
  webhook_url_scheme_rejected: 'רק כתובת HTTPS מתקבלת. כתובת HTTP או פרוטוקול אחר אינם נתמכים.',
  webhook_url_credentials_rejected: 'אין להטמיע שם משתמש או סיסמה בכתובת. הזדהות נעשית בחתימה.',
  webhook_url_port_rejected: 'רק פורט 443 מתקבל.',
  webhook_url_ip_literal_rejected: 'יש להזין שם מארח, לא כתובת IP.',
  webhook_url_local_name_rejected: 'הכתובת מצביעה על רשת פנימית ואינה מתקבלת.',
  webhook_url_host_not_dns: 'שם המארח אינו שם דומיין תקין.',
  webhook_url_private_address: 'שם המארח נפתר לכתובת ברשת פנימית, ולכן הפנייה נחסמה.',
  webhook_url_unresolvable: 'לא ניתן היה לפתור את שם המארח.',
  webhook_secret_invalid:
    `סוד החתימה חייב להיות באורך ${MIN_WEBHOOK_SECRET_LENGTH}–${MAX_WEBHOOK_SECRET_LENGTH} תווים.`,
  webhook_event_types_invalid: 'רשימת סוגי האירועים אינה תקינה.',
  webhook_subscription_invalid: 'חסר שדה חובה. יש למלא סיבה לפעולה.',
  webhook_subscription_unknown: 'המנוי לא נמצא.',
  webhook_not_authorized: 'רק בעל העסק רשאי לנהל חיבורי webhook.',
  webhook_organization_read_only: 'חשבון העסק במצב קריאה בלבד ולא ניתן לשנות חיבורים.',
  webhook_verification_required: 'יש להשלים אימות בעלות על נקודת הקצה לפני הפעלה.',
  webhook_verification_unknown: 'בקשת האימות לא נמצאה. יש להתחיל אימות חדש.',
  webhook_verification_settled: 'בקשת האימות כבר הוכרעה. יש להתחיל אימות חדש.',
  webhook_verification_expired: 'תוקף בקשת האימות פג. יש להתחיל אימות חדש.',
  webhook_verification_already_dispatched: 'בקשת האימות כבר נשלחה. יש להתחיל אימות חדש.',
  webhook_verification_endpoint_changed: 'הכתובת השתנתה במהלך האימות. יש להתחיל אימות חדש.',
  webhook_verification_challenge_mismatch: 'נקודת הקצה לא החזירה את קוד האימות שנשלח אליה.',
  webhook_verification_challenge_absent: 'נקודת הקצה לא החזירה את כותרת קוד האימות.',
  webhook_verification_succeeded: 'האימות הושלם.',
  webhook_verification_failed: 'האימות נכשל.',
  webhook_verification_unavailable: 'האימות לא הושלם. אפשר לנסות שוב בעוד רגע.',
  webhook_secret_unresolved: 'סוד החתימה של המנוי אינו זמין. יש לפנות לתמיכה.',
  webhook_header_invalid: 'האימות לא נשלח בשל כותרת בקשה לא תקינה.',
  webhook_connect_failed: 'לא ניתן היה ליצור חיבור לנקודת הקצה.',
  webhook_response_invalid: 'נקודת הקצה החזירה תשובה שאינה תקינה.',
  webhook_response_timeout: 'נקודת הקצה לא הגיבה בזמן.',
  fresh_authentication_required: 'הפעולה דורשת אימות סיסמה טרי. יש לאשר את הזהות ולנסות שוב.',
};

const FALLBACK = 'הפעולה לא הושלמה. אפשר לנסות שוב, ואם התקלה חוזרת יש לפנות לתמיכה.';

/**
 * Codes to Hebrew. Anything unmapped becomes the fallback — never the raw text, which is the
 * whole point: a Postgres message on this screen can name an internal relation, and a delivery
 * error can carry an upstream response body (#98, #99).
 */
export function webhookErrorMessage(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  const status = /webhook_verification_status_(\d{3})/.exec(text);
  if (status) return `נקודת הקצה החזירה סטטוס ${status[1]} ולכן האימות לא הושלם.`;
  const code = Object.keys(WEBHOOK_ERROR).find((key) => text.includes(key));
  return code ? WEBHOOK_ERROR[code] : FALLBACK;
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
  if (error) throw new Error(webhookErrorMessage(error));
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

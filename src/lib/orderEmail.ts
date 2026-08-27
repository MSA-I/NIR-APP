import { supabase } from './supabase';
import type { StatusMeta } from './status';

// Tenant-side surface of email order delivery (0168), extended by 0190 with what the provider
// learned AFTER acceptance: supplier communication preferences, the one email thread per order,
// the send action (via the email-sender Edge Function, which claims/sends/settles), the delivery
// channel state, and the owner's manual reset of a dead thread.

export type CommunicationChannel = 'manual' | 'email' | 'whatsapp' | 'both';
export type CommunicationLocale = 'he' | 'en';

export interface SupplierCommunicationPreferences {
  org_id: string;
  supplier_id: string;
  channel: CommunicationChannel;
  locale: CommunicationLocale;
  email_override: string | null;
  whatsapp_override: string | null;
  reminders_allowed: boolean;
  created_at: string;
  updated_at: string;
}

export type EmailMessageStatus =
  | 'queued' | 'sending' | 'unknown' | 'accepted' | 'delivered' | 'bounced' | 'failed';

/**
 * The tenant-facing email channel state (#238), read from the STORED GENERATED column 0190 added
 * to `email_order_messages`. It is derived from `status` in the database, so the screen and the
 * ledger cannot drift apart: there is one stored fact, not two.
 *
 * `delivery_failed` covers both a send that never left (`failed`) and a message the receiving
 * server returned (`bounced`). They are different provider facts with one business consequence:
 * the supplier does not have the order, and a resend is the next action. The order itself stays
 * `sent` throughout — the provider accepted it, and that is what "נשלחה" means (#187).
 */
export type EmailChannelState =
  | 'pending' | 'accepted' | 'delivered' | 'delivery_failed' | 'unknown';

/** Hebrew claims for the channel state. Kept here rather than in `status.ts` because this
 *  vocabulary belongs to #238's channel, not to the stored provider status ladder — and the tone
 *  is a claim: `delivered` is the only state that may read as done. */
export const EMAIL_CHANNEL_STATE: Record<EmailChannelState, StatusMeta> = {
  pending: { key: 'emailChannel_pending', tone: 'idle' },
  accepted: { key: 'emailChannel_accepted', tone: 'info' },
  delivered: { key: 'emailChannel_delivered', tone: 'done' },
  delivery_failed: { key: 'emailChannel_delivery_failed', tone: 'alert' },
  unknown: { key: 'emailChannel_unknown', tone: 'alert' },
};

/** The statuses a resend may be offered from. `accepted`/`delivered` are already with the
 *  provider and `sending` is in flight — re-sending either would duplicate a supplier email.
 *  `unknown` is the 0168 freeze: it needs a human's clarification and an owner reset, not a
 *  button (#188). `bounced` is the state 0190 made reachable, and it is exactly where #238 says
 *  a resend must be offered. */
export const EMAIL_RETRYABLE_STATUSES: readonly EmailMessageStatus[] = [
  'queued', 'failed', 'bounced',
];

/** The bounded reason vocabulary 0190 CHECKs, turned into one Hebrew sentence each. The provider's
 *  own sentence is passed through separately as secondary detail: it is length-capped in the
 *  database and is evidence, not the explanation the business reads. */
const DELIVERY_REASON: Record<string, string> = {
  bounce_permanent:
    'שרת הדואר של הנמען דחה את ההודעה סופית — סביר שכתובת המייל שגויה, נסגרה או חסומה.',
  bounce_transient:
    'שרת הדואר של הנמען דחה את ההודעה זמנית — למשל תיבה מלאה או עומס אצל הנמען.',
  bounce_undetermined:
    'ההודעה הוחזרה משרת הדואר של הנמען, וספק המייל לא הצליח לקבוע אם הסיבה קבועה או זמנית.',
  bounce_unclassified:
    'ההודעה הוחזרה משרת הדואר של הנמען מסיבה שספק המייל לא סיווג.',
  lease_expired:
    'השליחה נקטעה לפני שהתקבלה תשובה מספק המייל, ולכן לא ידוע אם ההודעה יצאה.',
};

const SEND_FAILED = 'ספק המייל לא קיבל את ההודעה לטיפול, ולכן היא מעולם לא יצאה לנמען.';

export interface EmailDeliveryReason {
  /** The one Hebrew sentence the business reads. */
  sentence: string;
  /** The provider's own wording, capped by the database. Evidence, shown as secondary detail. */
  providerDetail: string | null;
}

/** Explains a failed email channel in Hebrew, or answers null when there is nothing to explain.
 *  An unrecognized code falls back to a generic sentence rather than showing a raw code to a
 *  business user — and never invents a diagnosis the provider did not give. */
export function emailDeliveryReason(message: EmailOrderMessage): EmailDeliveryReason | null {
  if (message.delivery_state !== 'delivery_failed' && message.status !== 'unknown') return null;
  const code = message.error_code ?? '';
  const sentence = DELIVERY_REASON[code]
    ?? (message.status === 'bounced' ? DELIVERY_REASON.bounce_unclassified : SEND_FAILED);
  const detail = (message.error_message ?? '').trim();
  return { sentence, providerDetail: detail && detail !== sentence ? detail : null };
}

export interface EmailOrderMessage {
  id: string;
  org_id: string;
  order_id: string;
  supplier_id: string;
  link_id: string | null;
  kind: 'order';
  status: EmailMessageStatus;
  /** 0190, stored generated: the #238 channel vocabulary, derived from `status` in the database. */
  delivery_state: EmailChannelState;
  to_email: string;
  locale: CommunicationLocale;
  template_name: string;
  template_version: number;
  provider_message_id: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export async function fetchSupplierCommunicationPreferences(
  supplierId: string,
): Promise<SupplierCommunicationPreferences | null> {
  const res = await supabase.from('supplier_communication_preferences')
    .select('*')
    .eq('supplier_id', supplierId)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  return res.data as SupplierCommunicationPreferences | null;
}

export interface PreferencesInput {
  channel: CommunicationChannel;
  locale: CommunicationLocale;
  emailOverride: string | null;
  whatsappOverride: string | null;
  remindersAllowed: boolean;
  reason: string;
}

export async function setSupplierCommunicationPreferences(
  supplierId: string,
  input: PreferencesInput,
): Promise<void> {
  const res = await supabase.rpc('set_supplier_communication_preferences', {
    p_supplier_id: supplierId,
    p_channel: input.channel,
    p_locale: input.locale,
    p_email_override: input.emailOverride,
    p_whatsapp_override: input.whatsappOverride,
    p_reminders_allowed: input.remindersAllowed,
    p_reason: input.reason,
  });
  if (res.error) throw new Error(res.error.message);
}

export async function fetchOrderEmailMessage(orderId: string): Promise<EmailOrderMessage | null> {
  const res = await supabase.from('email_order_messages')
    .select('*')
    .eq('order_id', orderId)
    .eq('kind', 'order')
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  return res.data as EmailOrderMessage | null;
}

export interface SendOrderEmailResult {
  ok: boolean;
  state: string;
  status?: string | null;
  attempt?: number;
  deliveryLimited?: boolean;
  error?: string;
}

/** Sends the order through the email-sender Edge Function. The Edge claims (authorization and
 *  the attempt ceiling live in SQL), mails via the provider, and settles — including stamping
 *  the order `sent` on provider acceptance. This wrapper only translates the outcome. */
export async function sendOrderEmail(orderId: string, reason: string): Promise<SendOrderEmailResult> {
  const res = await supabase.functions.invoke('email-sender', {
    body: { action: 'send_order', orderId, reason },
  });
  if (res.error) {
    // The function answers non-2xx with {error: code}; surface the Hebrew sentence.
    const context = res.error as { context?: { body?: unknown } };
    let code = res.error.message ?? 'send_failed';
    const body = context.context?.body;
    if (typeof body === 'string') {
      try {
        code = (JSON.parse(body) as { error?: string }).error ?? code;
      } catch { /* keep message */ }
    } else if (body && typeof body === 'object' && 'error' in body) {
      code = String((body as { error: unknown }).error);
    }
    // The code travels; EmailOrderCard resolves it when it draws the toast.
    return { ok: false, state: 'error', error: code };
  }
  return res.data as SendOrderEmailResult;
}

export async function resetOrderEmailMessage(messageId: string, reason: string): Promise<void> {
  const res = await supabase.rpc('reset_email_order_message', {
    p_message_id: messageId,
    p_reason: reason,
  });
  if (res.error) throw new Error(res.error.message);
}

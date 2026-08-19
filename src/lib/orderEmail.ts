import { supabase } from './supabase';
import { toHebrewError } from './errors';

// Tenant-side surface of email order delivery (0168): supplier communication preferences,
// the one email thread per order, the send action (via the email-sender Edge Function, which
// claims/sends/settles), and the owner's manual reset of a dead thread.

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

export interface EmailOrderMessage {
  id: string;
  org_id: string;
  order_id: string;
  supplier_id: string;
  link_id: string | null;
  kind: 'order';
  status: EmailMessageStatus;
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
  if (res.error) throw new Error(toHebrewError(res.error.message));
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
  if (res.error) throw new Error(toHebrewError(res.error.message));
}

export async function fetchOrderEmailMessage(orderId: string): Promise<EmailOrderMessage | null> {
  const res = await supabase.from('email_order_messages')
    .select('*')
    .eq('order_id', orderId)
    .eq('kind', 'order')
    .maybeSingle();
  if (res.error) throw new Error(toHebrewError(res.error.message));
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
    return { ok: false, state: 'error', error: toHebrewError(code) };
  }
  return res.data as SendOrderEmailResult;
}

export async function resetOrderEmailMessage(messageId: string, reason: string): Promise<void> {
  const res = await supabase.rpc('reset_email_order_message', {
    p_message_id: messageId,
    p_reason: reason,
  });
  if (res.error) throw new Error(toHebrewError(res.error.message));
}

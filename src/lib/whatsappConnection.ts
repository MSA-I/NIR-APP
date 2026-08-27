import { supabase } from './supabase';

/**
 * Tenant-side surface of the WhatsApp provider connection (0191 over 0028/0029).
 *
 * #240 (owner, 22.08.2026): every organization connects its OWN sender through the provider;
 * there is no central InPlace number. The credential lives per tenant in Supabase Vault and is
 * written only by `configure_whatsapp_provider_connection`, which is owner-only, demands a fresh
 * password and a reason, and never returns the credential or its Vault reference. Nothing in
 * this module can read a credential, because no server surface exposes one to a browser role.
 *
 * #239: the chosen provider is Twilio and its status is SELECTED / ACCOUNT_NOT_PROVEN /
 * CREDENTIALS_NOT_CONFIGURED / NOT_INTEGRATED. A connection configured here is stored, not
 * activated: no message has ever been sent through it.
 *
 * The display labels below live here rather than in `src/lib/status.ts` because they are new
 * vocabulary owned by this surface. Moving them into the shared status map is a follow-up, not a
 * silent edit of a file three other screens read.
 */

export type WhatsAppProvider = 'meta_cloud' | 'twilio';
export type WhatsAppConnectionStatus = 'pending' | 'active' | 'disabled' | 'error';

export interface WhatsAppConnectionView {
  configured: boolean;
  provider: WhatsAppProvider | null;
  status: WhatsAppConnectionStatus | null;
  /** Server-side masked form. The unmasked sender is never sent to a browser. */
  maskedSender: string | null;
  credentialConfigured: boolean;
  orderTemplateName: string | null;
  reminderTemplateName: string | null;
  languageCode: string | null;
  configuredAt: string | null;
}

export interface WhatsAppConnectionInput {
  provider: WhatsAppProvider;
  providerAccountId: string;
  providerSenderId: string;
  displayNumber: string;
  credential: string;
  orderTemplateName: string;
  reminderTemplateName: string;
  languageCode: string;
  reason: string;
}

export const WHATSAPP_PROVIDER_LABEL: Record<WhatsAppProvider, string> = {
  twilio: 'Twilio',
  meta_cloud: 'Meta Cloud API',
};

export const WHATSAPP_CONNECTION_STATUS_LABEL: Record<WhatsAppConnectionStatus, string> = {
  pending: 'הוגדר, טרם הופעל',
  active: 'פעיל',
  disabled: 'מושבת',
  error: 'תקלה בחיבור',
};

/**
 * The card renders this, and only this. A field the server did not send becomes `—`, never a
 * zero and never an invented default: an unknown is a statement about our knowledge, not about
 * the business.
 */
export interface WhatsAppConnectionSummary {
  configured: boolean;
  providerLabel: string;
  statusLabel: string;
  maskedSender: string;
  credentialLabel: string;
  languageLabel: string;
  /** True only when the tenant's own provider channel can actually carry an order. */
  providerDeliveryAvailable: boolean;
  /** The manual wa.me share is always available and is always labelled as manual. */
  manualShareAvailable: true;
}

const EMPTY = '—';

export function summarizeConnection(view: WhatsAppConnectionView | null): WhatsAppConnectionSummary {
  if (!view || !view.configured) {
    return {
      configured: false,
      providerLabel: EMPTY,
      statusLabel: 'לא מחובר',
      maskedSender: EMPTY,
      credentialLabel: EMPTY,
      languageLabel: EMPTY,
      providerDeliveryAvailable: false,
      manualShareAvailable: true,
    };
  }
  return {
    configured: true,
    providerLabel: view.provider ? WHATSAPP_PROVIDER_LABEL[view.provider] : EMPTY,
    statusLabel: view.status ? WHATSAPP_CONNECTION_STATUS_LABEL[view.status] : EMPTY,
    maskedSender: view.maskedSender ?? EMPTY,
    credentialLabel: view.credentialConfigured ? 'שמור בכספת, אינו ניתן לצפייה' : EMPTY,
    languageLabel: view.languageCode === 'he'
      ? 'עברית'
      : view.languageCode === 'en'
        ? 'אנגלית'
        : view.languageCode ?? EMPTY,
    providerDeliveryAvailable: view.status === 'active' && view.credentialConfigured,
    manualShareAvailable: true,
  };
}

interface ConnectionStatusPayload {
  configured?: boolean;
  provider?: WhatsAppProvider | null;
  status?: WhatsAppConnectionStatus | null;
  masked_sender?: string | null;
  credential_configured?: boolean;
  order_template_name?: string | null;
  reminder_template_name?: string | null;
  language_code?: string | null;
  configured_at?: string | null;
}

export function toConnectionView(payload: ConnectionStatusPayload | null): WhatsAppConnectionView {
  return {
    configured: payload?.configured === true,
    provider: payload?.provider ?? null,
    status: payload?.status ?? null,
    maskedSender: payload?.masked_sender ?? null,
    credentialConfigured: payload?.credential_configured === true,
    orderTemplateName: payload?.order_template_name ?? null,
    reminderTemplateName: payload?.reminder_template_name ?? null,
    languageCode: payload?.language_code ?? null,
    configuredAt: payload?.configured_at ?? null,
  };
}

export async function fetchWhatsAppConnection(): Promise<WhatsAppConnectionView> {
  const res = await supabase.rpc('get_whatsapp_connection_status');
  if (res.error) throw new Error(res.error.message);
  return toConnectionView(res.data as ConnectionStatusPayload | null);
}

/**
 * The owner's connection wizard. The role, the fresh password and the reason are all enforced
 * on the SERVER; the component's checks only decide what to render.
 */
export async function configureWhatsAppConnection(
  input: WhatsAppConnectionInput,
): Promise<WhatsAppConnectionView> {
  const res = await supabase.rpc('configure_whatsapp_provider_connection', {
    p_provider: input.provider,
    p_provider_account_id: input.providerAccountId,
    p_provider_sender_id: input.providerSenderId,
    p_display_number: input.displayNumber,
    p_credential: input.credential,
    p_order_template_name: input.orderTemplateName,
    p_reminder_template_name: input.reminderTemplateName,
    p_language_code: input.languageCode,
    p_reason: input.reason,
  });
  if (res.error) throw new Error(res.error.message);
  return toConnectionView(res.data as ConnectionStatusPayload | null);
}

export async function setWhatsAppConnectionEnabled(
  enabled: boolean,
  reason: string,
): Promise<WhatsAppConnectionView> {
  const res = await supabase.rpc('set_whatsapp_provider_connection_enabled', {
    p_enabled: enabled,
    p_reason: reason,
  });
  if (res.error) throw new Error(res.error.message);
  return toConnectionView(res.data as ConnectionStatusPayload | null);
}

export async function revokeWhatsAppConnection(reason: string): Promise<WhatsAppConnectionView> {
  const res = await supabase.rpc('revoke_whatsapp_provider_connection', { p_reason: reason });
  if (res.error) throw new Error(res.error.message);
  return toConnectionView(res.data as ConnectionStatusPayload | null);
}

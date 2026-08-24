// whatsapp-sender/core -- the outbound provider adapter, pure and importable.
//
// PROVIDER CONTRACT, VERIFIED (read 2026-08-23):
//
//   https://www.twilio.com/docs/messaging/api/message-resource
//     Create a message with POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
//     encoded as application/x-www-form-urlencoded. `To` is the recipient in E.164 or a channel
//     address; a channel address is "whatsapp:+<E.164>". `From` is the sender (or a Messaging
//     Service SID). `StatusCallback` is the webhook that receives delivery status.
//
//   https://www.twilio.com/docs/content/send-templates-created-with-the-content-template-builder
//     A business-initiated WhatsApp message must be a pre-registered template. Send it with
//     `ContentSid` plus `ContentVariables` (a JSON string of placeholder substitutions), and
//     the documentation is explicit: "Exclude Body and MediaUrl. ContentSid replaces both."
//
//   https://www.twilio.com/docs/whatsapp/api
//     Both addresses carry the whatsapp: prefix; business-initiated notifications must be
//     templated and pre-registered.
//
//   IDEMPOTENCY, MEASURED AND NEGATIVE: Twilio publishes an Idempotency-Key for configuration
//   operations, but the Messages create endpoint documents NO idempotency key and no built-in
//   de-duplication. So this adapter invents none. Duplicate suppression is the database's
//   claim-with-lease, attempt ceiling and `unknown` freeze (0028/0029) -- the same mechanism
//   that already protects the Meta path. `core.test.ts` asserts the absence, so a future edit
//   cannot quietly add a header that the provider does not honour.
//
// STATUS: Twilio is SELECTED / ACCOUNT_NOT_PROVEN / CREDENTIALS_NOT_CONFIGURED / NOT_INTEGRATED
// (#239). No account, no credential, no live or sandbox call exists. This is the shape only.
//
// The database and the UI never learn Twilio's vocabulary: everything vendor-specific stops
// here. `meta_cloud` stays representable and stays unimplemented -- it is refused by name rather
// than being sent as if it were Twilio.

export type SupportedProvider = 'twilio';

export interface ProviderConnection {
  provider: SupportedProvider;
  providerAccountId: string;
  providerSenderId: string;
  orderTemplateName: string;
  reminderTemplateName: string;
  languageCode: string;
}

export type MessageKind = 'order' | 'reminder';

export interface ProviderRequestInput {
  connection: ProviderConnection;
  kind: MessageKind;
  recipient: string;
  variables: Record<string, string>;
  statusCallbackUrl: string;
}

export type BuiltProviderRequest =
  | {
    ok: true;
    method: 'POST';
    url: string;
    contentType: 'application/x-www-form-urlencoded';
    body: string;
    /** Deliberately empty: see the idempotency note above. */
    extraHeaders?: Record<string, string>;
  }
  | { ok: false; reason: 'provider_not_implemented' | 'recipient_unreachable' | 'template_missing' | 'sender_missing' };

/**
 * A channel address is `whatsapp:` over a full E.164 number. A value we cannot turn into one is
 * refused, because "send it somewhere close enough" is not a delivery guarantee.
 */
export function toChannelAddress(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const withoutPrefix = raw.startsWith('whatsapp:') ? raw.slice('whatsapp:'.length) : raw;
  const digits = withoutPrefix.startsWith('+') ? withoutPrefix.slice(1) : withoutPrefix;
  if (!/^[0-9]{8,15}$/.test(digits)) return null;
  return `whatsapp:+${digits}`;
}

export function buildProviderRequest(input: ProviderRequestInput): BuiltProviderRequest {
  if (input.connection.provider !== 'twilio') return { ok: false, reason: 'provider_not_implemented' };

  const to = toChannelAddress(input.recipient);
  if (!to) return { ok: false, reason: 'recipient_unreachable' };
  const from = toChannelAddress(input.connection.providerSenderId);
  if (!from) return { ok: false, reason: 'sender_missing' };

  const template = (input.kind === 'order'
    ? input.connection.orderTemplateName
    : input.connection.reminderTemplateName ?? '').trim();
  if (!template) return { ok: false, reason: 'template_missing' };

  const accountSid = input.connection.providerAccountId.trim();
  if (!accountSid) return { ok: false, reason: 'sender_missing' };

  const form = new URLSearchParams();
  form.set('To', to);
  form.set('From', from);
  form.set('ContentSid', template);
  form.set('ContentVariables', JSON.stringify(input.variables ?? {}));
  form.set('StatusCallback', input.statusCallbackUrl);

  return {
    ok: true,
    method: 'POST',
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    contentType: 'application/x-www-form-urlencoded',
    body: form.toString(),
    extraHeaders: {},
  };
}

export type SenderConfiguration =
  | { state: 'ready'; statusCallbackUrl: string }
  | {
    state: 'misconfigured';
    reason: 'app_base_url_missing' | 'credential_missing' | 'connection_not_active';
    /** The manual wa.me share stays available and stays labelled as manual. */
    manualShareAvailable: true;
    /** Never true here: a manual share is not, and can never be presented as, provider delivery. */
    providerDelivery: false;
  };

/**
 * Fail closed. A connection that is pending, disabled or in error, an absent credential or an
 * unknown application base URL all produce `misconfigured` -- an answer, not an attempt. The
 * caller renders the manual channel, separately labelled, and stamps nothing.
 */
export function resolveSenderConfiguration(input: {
  status: string;
  appBaseUrl: string;
  credential: string;
}): SenderConfiguration {
  const appBaseUrl = (input.appBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!appBaseUrl) {
    return { state: 'misconfigured', reason: 'app_base_url_missing', manualShareAvailable: true, providerDelivery: false };
  }
  if (!(input.credential ?? '').trim()) {
    return { state: 'misconfigured', reason: 'credential_missing', manualShareAvailable: true, providerDelivery: false };
  }
  if (input.status !== 'active') {
    return { state: 'misconfigured', reason: 'connection_not_active', manualShareAvailable: true, providerDelivery: false };
  }
  return { state: 'ready', statusCallbackUrl: `${appBaseUrl}/functions/v1/whatsapp-webhook` };
}

export type ProviderOutcome =
  | { outcome: 'accepted'; providerMessageId: string }
  | { outcome: 'failed'; errorCode: string; errorMessage: string }
  /** The send may or may not have happened. The ledger freezes it as `unknown` (0028/0029)
   * rather than guessing, because a wrong guess either loses an order or duplicates one. */
  | { outcome: 'ambiguous'; errorCode: string; errorMessage: string };

/** The database CHECK caps this at 500 characters, so it is capped here rather than refused there. */
function boundedMessage(value: unknown): string {
  const raw = typeof value === 'string' && value.trim()
    ? value.trim()
    : 'ספק ההודעות דחה את הבקשה';
  return raw.slice(0, 500);
}

function boundedCode(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!/^[0-9]{1,20}$/.test(raw)) return 'twilio_unknown';
  return `twilio_${raw}`.slice(0, 100);
}

export function classifyProviderOutcome(
  httpStatus: number,
  payload: { sid?: string; code?: string | number; message?: string; status?: string } | null,
): ProviderOutcome {
  if (httpStatus >= 200 && httpStatus < 300) {
    const sid = (payload?.sid ?? '').trim();
    // A 2xx with no provider identifier settles nothing: there is no id to match a callback
    // against, so claiming acceptance would be a business fact we cannot evidence.
    if (!sid) {
      return {
        outcome: 'ambiguous',
        errorCode: 'provider_response_incomplete',
        errorMessage: 'ספק ההודעות אישר ללא מזהה הודעה',
      };
    }
    return { outcome: 'accepted', providerMessageId: sid };
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    const message = boundedMessage(payload?.message);
    return {
      outcome: 'failed',
      errorCode: boundedCode(payload?.code),
      errorMessage: message.length > 500 ? message.slice(0, 500) : message,
    };
  }
  return {
    outcome: 'ambiguous',
    errorCode: 'provider_unavailable',
    errorMessage: 'לא התקבלה תשובה חד-משמעית מספק ההודעות',
  };
}

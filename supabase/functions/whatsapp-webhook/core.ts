// whatsapp-webhook/core -- the provider callback contract, pure and importable.
//
// PROVIDER CONTRACT, VERIFIED (read 2026-08-23). Nothing in this file is written from memory:
//
//   https://www.twilio.com/docs/usage/security
//     The request-validation algorithm, verbatim: (1) take the full request URL "from the
//     protocol (https...) through the end of the query string"; (2) "Sort all the POST
//     parameters alphabetically (using Unix-style case-sensitive sorting order)"; (3) "Append
//     the variable name and value (with no delimiters) to the end of the URL string"; (4) "Sign
//     the resulting string with HMAC-SHA1 using your AuthToken as the key"; (5) "Base64-encode
//     the resulting hash value"; (6) compare with the X-Twilio-Signature header. The same page
//     publishes the worked example this file's known-answer test pins.
//     CAVEAT the same page states: Twilio drops any username/password from the URL before
//     signing, and port handling differs between HTTP and HTTPS callbacks -- so the URL must be
//     RECONSTRUCTED from what the provider actually called, not from what a proxy handed us.
//
//   https://www.twilio.com/docs/usage/webhooks/webhooks-security
//     The URL passed to validation must include scheme, host, non-standard port, path and the
//     COMPLETE query string, and query parameters must never be extracted and passed separately.
//     For an application/json body Twilio "appends a bodySHA256 query parameter to your webhook
//     URL"; validation then checks the SHA-256 of the RAW body against that parameter and signs
//     the URL (which already contains it). A load balancer that rewrites scheme or host breaks
//     the reconstruction, which is why the deployed URL is configuration, not a guess.
//
//   https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
//     Status callbacks are POST, application/x-www-form-urlencoded, carrying MessageSid,
//     MessageStatus, AccountSid, From, To, and ErrorCode when the status is failed or
//     undelivered. Channel callbacks add ChannelInstallSid / ChannelStatusMessage /
//     ChannelPrefix, and EventType carries READ for read receipts on channels that support it.
//
//   https://www.twilio.com/docs/messaging/api/message-resource
//     The outbound status vocabulary: queued, accepted, scheduled, sending, sent, delivered,
//     undelivered, failed, canceled, read. receiving/received are INBOUND states.
//
// #241 (owner, 22.08.2026) said inbound text and media are not ingested at launch. #321 (owner,
// 31.08.2026) REVERSED HALF OF THAT, and the halves are not symmetric:
//
//   MEDIA is ingested. An image or PDF sent to a tenant's number becomes an inbox document.
//   TEXT is not, and is answered by nobody. That half of #241 stands untouched, which is why
//   `inbound_text` remains a verdict here rather than becoming a parse.
//
// The asymmetry is the point. A photographed invoice is a document a business wants; a sentence
// is a conversation this product does not have, and replying to one would be a promise nobody
// decided to make.
//
// TWO RULES THIS FILE ENFORCES BECAUSE NOTHING DOWNSTREAM CAN:
//
//   THE ROUTING KEY COMES FROM `To`, NEVER FROM `From`. On an outbound status callback `From`
//   is our number; on an INBOUND message it is the supplier's, and `To` is ours. Reusing the
//   outbound rule here would look up a connection by the phone of whoever sent the message --
//   which is to say, a stranger could select which tenant their file lands in. #319 makes the
//   same point for email: association is derived only from the address WE issued.
//
//   NOTHING HERE HAS A SIDE EFFECT. Twilio's HMAC is computed over PARSED parameters and the
//   credential is chosen by a value inside the request, so a lookup necessarily precedes
//   verification -- the one place the universal "raw bytes, then verify, then parse" rule
//   cannot be applied literally. What survives is the invariant that matters: parsing to
//   choose a candidate key is pure, and no write, no counter, no log line and no network call
//   happens before the signature is checked.

/** The internal delivery vocabulary. Mirrors the `whatsapp_message_status` values a callback
 * is allowed to assert; the ladder itself is enforced in SQL, not here. */
export type InternalDeliveryStatus = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed';

export type WebhookClassification =
  | {
    kind: 'delivery_status';
    providerMessageId: string;
    providerSenderId: string;
    status: InternalDeliveryStatus;
    errorCode: string | null;
  }
  | {
    kind: 'inbound_media';
    providerMessageId: string;
    /** OUR number, from `To`. The tenant is chosen by the address we issued, never by the sender. */
    providerSenderId: string;
    /** `AccountSid`, so the connection can be required to belong to the account that signed. */
    providerAccountId: string;
    /** The sender, already masked. The full number never leaves this function. */
    maskedSender: string;
    media: InboundMedia[];
    /** #322: a forwarded invoice is weaker evidence and must not look identical to a direct one. */
    forwarded: boolean;
    frequentlyForwarded: boolean;
  }
  | { kind: 'inbound'; reason: 'inbound_message' | 'inbound_media' | 'inbound_status' }
  | { kind: 'unsupported'; reason: string };

/** One attachment as the provider describes it. The URL is fetched through `guardedDownload`
 * against an exact host allowlist -- signed by Twilio is not the same as safe to dial. */
export interface InboundMedia {
  index: number;
  url: string;
  /** The provider's CLAIM about the type. The bytes decide; this is kept only to compare. */
  declaredContentType: string;
}

const TEXT = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The signed string: the full URL, then every POST parameter as name immediately followed by
 * value, in byte-wise ascending name order. `Array.prototype.sort` with no comparator sorts by
 * UTF-16 code unit, which is the case-sensitive Unix ordering the contract specifies -- a
 * locale-aware comparison would silently reorder mixed-case names and never validate.
 */
export function buildSignatureBase(url: string, params: Record<string, string>): string {
  const names = Object.keys(params).sort();
  let base = url;
  for (const name of names) base += name + params[name];
  return base;
}

export async function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    TEXT.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, TEXT.encode(buildSignatureBase(url, params)));
  return toBase64(new Uint8Array(signature));
}

/**
 * Fixed-length comparison with no early return: every byte of the longer input is visited, and
 * a length mismatch is folded into the accumulator rather than short-circuiting.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = TEXT.encode(left);
  const b = TEXT.encode(right);
  let difference = a.length ^ b.length;
  const span = Math.max(a.length, b.length);
  for (let index = 0; index < span; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export async function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null | undefined,
): Promise<boolean> {
  // A missing header is a rejection, never a skip: "unsigned" must not be a way in.
  if (!authToken || !signature) return false;
  return constantTimeEquals(await computeTwilioSignature(authToken, url, params), signature);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The application/json variant. Two checks, both required: the raw body must hash to the
 * bodySHA256 the URL advertises, and the URL (which carries that parameter) must carry a valid
 * signature. The raw body string is used verbatim -- re-serializing parsed JSON would change
 * bytes and fail for the wrong reason.
 */
export async function verifyTwilioJsonSignature(
  authToken: string,
  url: string,
  rawBody: string,
  signature: string | null | undefined,
): Promise<boolean> {
  if (!authToken || !signature) return false;
  let advertised: string | null = null;
  try {
    advertised = new URL(url).searchParams.get('bodySHA256');
  } catch {
    return false;
  }
  if (!advertised) return false;
  if (!constantTimeEquals(await sha256Hex(rawBody), advertised.toLowerCase())) return false;
  return verifyTwilioSignature(authToken, url, {}, signature);
}

const OUTBOUND_STATUS: Record<string, InternalDeliveryStatus> = {
  // Queued/accepted/scheduled/sending all mean the provider has the message and we do not.
  queued: 'accepted',
  accepted: 'accepted',
  scheduled: 'accepted',
  sending: 'accepted',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  // INHERITED ASSUMPTION -- NOT A DECISION. Mapping `undelivered` (a delivery receipt saying
  // the message did NOT arrive, after Twilio already reported `sent`) onto `failed` follows
  // decision #238. But #238 decided the EMAIL case: an order that was accepted and then bounced
  // keeps order status `sent`, the mail channel becomes `delivery_failed`, and a resend is
  // offered. **#238 does not decide the WhatsApp case.** The owner DEFERRED the WhatsApp
  // question on 23.08.2026, explicitly until a Twilio account exists and the real status
  // sequence can be observed -- because what Twilio actually emits, and in what order, is not
  // something we can responsibly guess from documentation.
  //
  // So this line is a borrowed default that happens to be tested, not a settled rule. Do NOT
  // cite it as decided WhatsApp behaviour, and do not remove this marker to tidy the map: the
  // test below pins the behaviour, and only this comment records that nobody chose it yet.
  undelivered: 'failed',
  failed: 'failed',
  canceled: 'failed',
};

const INBOUND_STATUS = new Set(['receiving', 'received']);

/** null means "not an outbound status we recognize" -- including the inbound ones. */
export function mapTwilioStatus(status: string | null | undefined): InternalDeliveryStatus | null {
  if (!status) return null;
  return OUTBOUND_STATUS[status.trim().toLowerCase()] ?? null;
}

/**
 * A short enumerated code the database CHECK accepts (`^[a-z0-9_]+$`, at most 100 characters).
 * An unexpected value collapses rather than travelling verbatim into a stored column.
 */
export function normalizeProviderErrorCode(code: string | number | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const raw = String(code).trim();
  if (!raw) return null;
  if (!/^[0-9]{1,20}$/.test(raw)) return 'twilio_unknown';
  return `twilio_${raw}`;
}

/**
 * THE CANONICAL FORM OF A SENDER ID, decided here rather than left to whoever writes a row.
 *
 * Twilio puts a CHANNEL prefix on its addresses: `whatsapp:+14155238886`. The prefix says which
 * transport carried the message, not who the party is -- the same number can serve SMS and
 * WhatsApp -- and `whatsapp_connections.provider_sender_id` is deliberately provider-neutral
 * (0191 made it carry a Meta phone_number_id and a Twilio number in the same column). A
 * transport prefix inside a provider-neutral identity column is a category error, and it is the
 * kind that shows up as two rows for one number.
 *
 * So the canonical form is BARE E.164: `+14155238886`. The prefix is stripped on the way in, a
 * CHECK refuses a stored value containing `:`, and a test proves `whatsapp:+972...` and
 * `+972...` resolve to one row rather than two.
 *
 * Returns null for anything that is not an E.164 number, which the caller must treat as an
 * unroutable message rather than as a number with odd punctuation.
 */
export function normalizeWhatsAppAddress(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return null;
  // Case-insensitive, because the prefix is documented lower-case and nobody should depend on it.
  const withoutChannel = trimmed.replace(/^[a-z]+:/i, '');
  if (!/^\+[1-9][0-9]{6,14}$/.test(withoutChannel)) return null;
  return withoutChannel;
}

/**
 * A sender's number is personal data about a person, so what is STORED is masked: the country
 * code, then a fixed run of dots, then the final two digits. Enough for a human to recognise
 * their own supplier, not enough to be a phone directory of a tenant's contacts if the row
 * leaks. #322 keeps `WaId` under the same rule, and `ProfileName` -- a person's chosen display
 * name -- is not carried out of this function at all.
 */
export function maskWhatsAppNumber(e164: string | null | undefined): string {
  const normalized = normalizeWhatsAppAddress(e164);
  if (normalized === null) return 'unknown';
  const digits = normalized.slice(1);
  // Country codes are 1-3 digits and cannot be derived from the number alone without a table;
  // two is the conservative split -- it never reveals MORE than a full table would.
  const head = digits.slice(0, 3);
  const tail = digits.slice(-2);
  return `+${head}\u2026${tail}`;
}

/** Twilio accepts at most ten media per message; anything past that is a malformed payload. */
export const MAX_INBOUND_MEDIA = 10;

/**
 * The attachments, read positionally as the provider numbers them.
 *
 * A gap is not skipped quietly: `NumMedia` is the provider's own count and every index below it
 * must produce a URL, or the payload is malformed and the whole message is refused. Silently
 * ingesting two of three attachments is the failure this product exists to prevent -- the third
 * invoice would simply never exist, and nobody would be told.
 */
export function parseInboundMedia(
  params: Record<string, string>,
): { ok: true; media: InboundMedia[] } | { ok: false; reason: string } {
  const declared = Number.parseInt(params.NumMedia ?? '', 10);
  if (!Number.isFinite(declared) || declared <= 0) return { ok: false, reason: 'media_count_missing' };
  if (declared > MAX_INBOUND_MEDIA) return { ok: false, reason: 'media_count_exceeded' };

  const media: InboundMedia[] = [];
  for (let index = 0; index < declared; index += 1) {
    const url = (params[`MediaUrl${index}`] ?? '').trim();
    const declaredContentType = (params[`MediaContentType${index}`] ?? '').trim().toLowerCase();
    if (url === '') return { ok: false, reason: 'media_url_missing' };
    media.push({ index, url, declaredContentType });
  }
  return { ok: true, media };
}

/** Twilio spells booleans as the strings 'true'/'false'; anything else is absence, not truth. */
function flag(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

/**
 * Decide what a callback IS before deciding what to do with it. Inbound gets its own verdict so
 * the handler can refuse it by name; an unrecognized shape is `unsupported`, never a default.
 */
export function classifyTwilioWebhook(params: Record<string, string>): WebhookClassification {
  const messageSid = (params.MessageSid ?? params.SmsSid ?? '').trim();
  const from = (params.From ?? '').trim();
  const to = (params.To ?? '').trim();
  const rawStatus = (params.MessageStatus ?? params.SmsStatus ?? '').trim().toLowerCase();
  const numMedia = Number.parseInt(params.NumMedia ?? '', 10);

  if (Number.isFinite(numMedia) && numMedia > 0) {
    // THE ROUTING KEY IS `To`. On an inbound message `From` is the supplier and `To` is the
    // number the tenant was given, so the outbound rule (`from || to`) would hand the choice of
    // tenant to whoever sent the message.
    const providerSenderId = normalizeWhatsAppAddress(to);
    if (!messageSid) return { kind: 'unsupported', reason: 'message_sid_missing' };
    if (providerSenderId === null) return { kind: 'unsupported', reason: 'recipient_missing' };
    const accountSid = (params.AccountSid ?? '').trim();
    if (accountSid === '') return { kind: 'unsupported', reason: 'account_sid_missing' };
    const parsed = parseInboundMedia(params);
    if (!parsed.ok) return { kind: 'unsupported', reason: parsed.reason };
    return {
      kind: 'inbound_media',
      providerMessageId: messageSid,
      providerSenderId,
      providerAccountId: accountSid,
      // Masked here, once, so no caller has to remember to do it. `ProfileName` is read by
      // nothing in this file.
      maskedSender: maskWhatsAppNumber(from),
      media: parsed.media,
      forwarded: flag(params.Forwarded),
      frequentlyForwarded: flag(params.FrequentlyForwarded),
    };
  }
  if (typeof params.Body === 'string' && params.Body.length > 0) {
    // #321 left this half of #241 exactly where it was: text triggers nothing and is answered by
    // nobody. It is a verdict, not a parse -- no field of it survives this line.
    return { kind: 'inbound', reason: 'inbound_message' };
  }
  if (INBOUND_STATUS.has(rawStatus)) return { kind: 'inbound', reason: 'inbound_status' };

  if (!messageSid) return { kind: 'unsupported', reason: 'message_sid_missing' };
  if (!rawStatus) return { kind: 'unsupported', reason: 'status_missing' };
  const status = mapTwilioStatus(rawStatus);
  if (!status) return { kind: 'unsupported', reason: 'status_unrecognized' };

  // The tenant is resolved by the SENDER address. On an outbound status callback that is `From`;
  // `To` is the supplier and must never select a connection.
  const providerSenderId = from || to;
  if (!providerSenderId) return { kind: 'unsupported', reason: 'sender_missing' };

  // EventType READ is the channel-level read receipt; it may arrive with a coarser MessageStatus.
  const eventType = (params.EventType ?? '').trim().toUpperCase();
  const effective: InternalDeliveryStatus = eventType === 'READ' ? 'read' : status;

  return {
    kind: 'delivery_status',
    providerMessageId: messageSid,
    providerSenderId,
    status: effective,
    errorCode: effective === 'failed' ? normalizeProviderErrorCode(params.ErrorCode) : null,
  };
}

/** Form-encoded body -> the flat parameter map the signature algorithm signs. */
export function formParams(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(body)) params[name] = value;
  return params;
}

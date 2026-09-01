// Contract tests for the WhatsApp provider webhook.
//
// The signature algorithm is not implemented from memory: every property asserted here comes
// from Twilio's published contract, read 2026-08-23:
//   https://www.twilio.com/docs/usage/security
//   https://www.twilio.com/docs/usage/webhooks/webhooks-security
//   https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
//   https://www.twilio.com/docs/messaging/api/message-resource
// The known-answer vector below is the worked example published on the first of those pages.
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1';
import {
  buildSignatureBase,
  classifyTwilioWebhook,
  computeTwilioSignature,
  constantTimeEquals,
  mapTwilioStatus,
  normalizeProviderErrorCode,
  verifyTwilioJsonSignature,
  verifyTwilioSignature,
  maskWhatsAppNumber,
  normalizeWhatsAppAddress,
  parseInboundMedia,
  MAX_INBOUND_MEDIA,
} from './core.ts';

// The example exactly as Twilio publishes it (read 2026-08-23).
const DOC_URL = 'https://example.com/myapp.php?foo=1&bar=2';
const DOC_TOKEN = '12345';
const DOC_PARAMS: Record<string, string> = {
  Digits: '1234',
  To: '+18005551212',
  From: '+14158675310',
  Caller: '+14158675310',
  CallSid: 'CA1234567890ABCDE',
};
const DOC_SIGNATURE = 'L/OH5YylLD5NRKLltdqwSvS0BnU=';

Deno.test('the documented concatenation is URL then alphabetically sorted name+value, no delimiters', () => {
  assertEquals(
    buildSignatureBase(DOC_URL, DOC_PARAMS),
    'https://example.com/myapp.php?foo=1&bar=2'
      + 'CallSidCA1234567890ABCDE'
      + 'Caller+14158675310'
      + 'Digits1234'
      + 'From+14158675310'
      + 'To+18005551212',
  );
});

Deno.test('the published known-answer vector reproduces byte for byte', async () => {
  assertEquals(await computeTwilioSignature(DOC_TOKEN, DOC_URL, DOC_PARAMS), DOC_SIGNATURE);
});

Deno.test('a valid signature is accepted', async () => {
  assert(await verifyTwilioSignature(DOC_TOKEN, DOC_URL, DOC_PARAMS, DOC_SIGNATURE));
});

Deno.test('a wrong signature is rejected', async () => {
  assertFalse(await verifyTwilioSignature(DOC_TOKEN, DOC_URL, DOC_PARAMS, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='));
});

Deno.test('a missing signature header is rejected rather than skipped', async () => {
  assertFalse(await verifyTwilioSignature(DOC_TOKEN, DOC_URL, DOC_PARAMS, null));
  assertFalse(await verifyTwilioSignature(DOC_TOKEN, DOC_URL, DOC_PARAMS, ''));
});

Deno.test('a tampered parameter invalidates the signature', async () => {
  const tampered = { ...DOC_PARAMS, To: '+18005551213' };
  assertFalse(await verifyTwilioSignature(DOC_TOKEN, DOC_URL, tampered, DOC_SIGNATURE));
});

Deno.test('an added parameter invalidates the signature', async () => {
  const extra = { ...DOC_PARAMS, Extra: 'x' };
  assertFalse(await verifyTwilioSignature(DOC_TOKEN, DOC_URL, extra, DOC_SIGNATURE));
});

Deno.test('a different URL invalidates the signature -- the URL is part of the signed string', async () => {
  assertFalse(await verifyTwilioSignature(
    DOC_TOKEN, 'https://example.com/myapp.php?foo=1&bar=3', DOC_PARAMS, DOC_SIGNATURE));
});

Deno.test('the wrong auth token invalidates the signature', async () => {
  assertFalse(await verifyTwilioSignature('54321', DOC_URL, DOC_PARAMS, DOC_SIGNATURE));
});

Deno.test('parameter sorting is byte-wise and case sensitive, not locale aware', () => {
  const base = buildSignatureBase('https://x.test/hook', { a: '1', B: '2', A: '3' });
  assertEquals(base, 'https://x.test/hookA3B2a1');
});

Deno.test('the constant-time compare answers false for unequal lengths without throwing', () => {
  assertFalse(constantTimeEquals('abc', 'abcd'));
  assertFalse(constantTimeEquals('', 'a'));
  assert(constantTimeEquals('abc', 'abc'));
  assert(constantTimeEquals('', ''));
});

Deno.test('the JSON body variant signs the URL carrying bodySHA256 and hashes the raw body', async () => {
  const rawBody = JSON.stringify({ MessageSid: 'SM1', MessageStatus: 'delivered' });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const url = `https://x.test/hook?bodySHA256=${hex}`;
  const signature = await computeTwilioSignature(DOC_TOKEN, url, {});
  assert(await verifyTwilioJsonSignature(DOC_TOKEN, url, rawBody, signature));
  // A body that does not match the advertised digest is refused even when the HMAC is right.
  assertFalse(await verifyTwilioJsonSignature(DOC_TOKEN, url, `${rawBody} `, signature));
  // A URL with no bodySHA256 cannot be validated as a JSON callback.
  assertFalse(await verifyTwilioJsonSignature(DOC_TOKEN, 'https://x.test/hook', rawBody, signature));
});

Deno.test('a status callback is classified as a delivery status and carries the provider ids', () => {
  const classified = classifyTwilioWebhook({
    MessageSid: 'SM123',
    MessageStatus: 'delivered',
    AccountSid: 'AC1',
    From: 'whatsapp:+972500000001',
    To: 'whatsapp:+972501234567',
  });
  assertEquals(classified.kind, 'delivery_status');
  if (classified.kind !== 'delivery_status') throw new Error('unreachable');
  assertEquals(classified.providerMessageId, 'SM123');
  assertEquals(classified.providerSenderId, 'whatsapp:+972500000001');
  assertEquals(classified.status, 'delivered');
  assertEquals(classified.errorCode, null);
});

Deno.test('a failed status callback carries the bounded, normalized provider error code', () => {
  const classified = classifyTwilioWebhook({
    MessageSid: 'SM123',
    MessageStatus: 'undelivered',
    From: 'whatsapp:+972500000001',
    ErrorCode: '63016',
  });
  if (classified.kind !== 'delivery_status') throw new Error('expected a delivery status');
  assertEquals(classified.status, 'failed');
  assertEquals(classified.errorCode, 'twilio_63016');
});

Deno.test('an inbound message is classified inbound and never as a handled event (#241)', () => {
  const inbound = classifyTwilioWebhook({
    MessageSid: 'SM999',
    SmsStatus: 'received',
    From: 'whatsapp:+972501234567',
    To: 'whatsapp:+972500000001',
    Body: 'שלום, מאשר את ההזמנה',
    NumMedia: '0',
  });
  assertEquals(inbound.kind, 'inbound');
  if (inbound.kind !== 'inbound') throw new Error('unreachable');
  // Nothing derived from the message content survives classification.
  assertFalse(JSON.stringify(inbound).includes('שלום'));
});

// This test used to assert that inbound MEDIA was refused as `inbound`, which is what #241
// decided on 22.08.2026. #321 reversed that half on 31.08.2026: media is ingested, text is not.
// The assertion changed because the DECISION changed, and the registry says so -- not because
// the code stopped agreeing with it.
Deno.test('inbound media is classified as media, keyed on To, with the sender masked', () => {
  const inbound = classifyTwilioWebhook({
    MessageSid: 'SM998',
    AccountSid: 'AC00000000000000000000000000000001',
    From: 'whatsapp:+972501234567',
    To: 'whatsapp:+972500000001',
    ProfileName: 'Dana from the bakery',
    WaId: '972501234567',
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/SM998/Media/ME1',
    MediaContentType0: 'image/jpeg',
  });
  assertEquals(inbound.kind, 'inbound_media');
  if (inbound.kind !== 'inbound_media') throw new Error('unreachable');

  // THE ROUTING KEY IS OUR NUMBER. Keying on `From` would let whoever sent the message choose
  // which tenant it lands in, which is the whole failure this product exists to prevent.
  assertEquals(inbound.providerSenderId, '+972500000001');
  assertEquals(inbound.providerAccountId, 'AC00000000000000000000000000000001');
  assertEquals(inbound.media.length, 1);
  assertEquals(inbound.media[0].declaredContentType, 'image/jpeg');

  // A person's chosen display name is not carried out of classification, and their number is
  // masked before it can be. Asserted over the WHOLE object, so a field added later that
  // reintroduces either one turns this red.
  const serialized = JSON.stringify(inbound);
  assertFalse(serialized.includes('Dana'));
  assertFalse(serialized.includes('972501234567'));
  assertEquals(inbound.maskedSender, '+972\u202667');
});

Deno.test('inbound media without an AccountSid or a recipient is unsupported, not ingested', () => {
  // Both fields are what tie the message to a connection that belongs to the account that signed
  // it. Missing either one means we cannot say whose document this is, and a document whose
  // tenant is a guess is worse than a document that never arrived.
  const noAccount = classifyTwilioWebhook({
    MessageSid: 'SM1', From: 'whatsapp:+972501234567', To: 'whatsapp:+972500000001',
    NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/ME1',
  });
  assertEquals(noAccount.kind, 'unsupported');

  const noRecipient = classifyTwilioWebhook({
    MessageSid: 'SM1', AccountSid: 'AC1', From: 'whatsapp:+972501234567',
    NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/ME1',
  });
  assertEquals(noRecipient.kind, 'unsupported');
});

Deno.test('a declared media count with a missing URL is refused, never partially ingested', () => {
  // Three invoices announced, two delivered. Taking the two would mean the third simply never
  // existed and nobody was told -- the exact silence this product is built to remove.
  const gap = classifyTwilioWebhook({
    MessageSid: 'SM1', AccountSid: 'AC1',
    From: 'whatsapp:+972501234567', To: 'whatsapp:+972500000001',
    NumMedia: '3',
    MediaUrl0: 'https://api.twilio.com/media/ME1',
    MediaUrl2: 'https://api.twilio.com/media/ME3',
  });
  assertEquals(gap.kind, 'unsupported');
  if (gap.kind !== 'unsupported') throw new Error('unreachable');
  assertEquals(gap.reason, 'media_url_missing');
});

Deno.test('the forwarding flags survive classification, because a forward is weaker evidence', () => {
  // #322: an invoice a supplier FORWARDED is not the same claim as one they sent directly, and
  // the two must not look identical on screen.
  const forwarded = classifyTwilioWebhook({
    MessageSid: 'SM1', AccountSid: 'AC1',
    From: 'whatsapp:+972501234567', To: 'whatsapp:+972500000001',
    NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/ME1',
    Forwarded: 'true', FrequentlyForwarded: 'false',
  });
  assertEquals(forwarded.kind, 'inbound_media');
  if (forwarded.kind !== 'inbound_media') throw new Error('unreachable');
  assert(forwarded.forwarded);
  assertFalse(forwarded.frequentlyForwarded);
});

Deno.test('the canonical sender id is bare E.164, so one number cannot become two rows', () => {
  // The measured risk: `whatsapp_connections.provider_sender_id` is provider-neutral and unique,
  // so a channel prefix stored in it produces a SECOND row for a number that already has one --
  // and a lookup then silently misses the tenant that exists.
  assertEquals(normalizeWhatsAppAddress('whatsapp:+972500000001'), '+972500000001');
  assertEquals(normalizeWhatsAppAddress('WhatsApp:+972500000001'), '+972500000001');
  assertEquals(normalizeWhatsAppAddress('  +972500000001  '), '+972500000001');
  assertEquals(
    normalizeWhatsAppAddress('whatsapp:+972500000001'),
    normalizeWhatsAppAddress('+972500000001'),
    'the prefixed and bare forms must be the same identity',
  );

  // And what is NOT a number is not a number with odd punctuation.
  for (const bad of ['', '   ', 'whatsapp:', '+0123456789', '972500000001', '+97250000000x',
                     'whatsapp:not-a-number', '+1']) {
    assertEquals(normalizeWhatsAppAddress(bad), null, `${JSON.stringify(bad)} must not normalize`);
  }
});

Deno.test('a masked number identifies a supplier without becoming a phone directory', () => {
  assertEquals(maskWhatsAppNumber('whatsapp:+972501234567'), '+972\u202667');
  assertEquals(maskWhatsAppNumber('+14155238886'), '+141\u202686');
  assertEquals(maskWhatsAppNumber('nonsense'), 'unknown');
  assertEquals(maskWhatsAppNumber(null), 'unknown');
  // The middle is gone: the mask must not be reversible into the original.
  assertFalse(maskWhatsAppNumber('+972501234567').includes('50123'));
});

Deno.test('media parsing is bounded, because a count is a claim by the caller', () => {
  const tooMany: Record<string, string> = { NumMedia: String(MAX_INBOUND_MEDIA + 1) };
  for (let i = 0; i <= MAX_INBOUND_MEDIA; i += 1) tooMany[`MediaUrl${i}`] = `https://x.test/${i}`;
  const over = parseInboundMedia(tooMany);
  assertFalse(over.ok);

  assertFalse(parseInboundMedia({ NumMedia: '0' }).ok);
  assertFalse(parseInboundMedia({}).ok);
  assertFalse(parseInboundMedia({ NumMedia: 'lots' }).ok);

  const ok = parseInboundMedia({
    NumMedia: '2',
    MediaUrl0: 'https://x.test/0', MediaContentType0: 'application/pdf',
    MediaUrl1: 'https://x.test/1', MediaContentType1: 'IMAGE/PNG',
  });
  assert(ok.ok);
  if (!ok.ok) throw new Error('unreachable');
  assertEquals(ok.media.map((m) => m.index), [0, 1]);
  // The declared type is lower-cased for comparison but never trusted -- the bytes decide.
  assertEquals(ok.media[1].declaredContentType, 'image/png');
});

Deno.test('inbound TEXT is still refused, and #321 did not change that half', () => {
  const text = classifyTwilioWebhook({
    MessageSid: 'SM1', AccountSid: 'AC1',
    From: 'whatsapp:+972501234567', To: 'whatsapp:+972500000001',
    Body: 'can you send me the price list',
  });
  assertEquals(text.kind, 'inbound');
  if (text.kind !== 'inbound') throw new Error('unreachable');
  assertEquals(text.reason, 'inbound_message');
  // No field derived from the message content survives -- the same rule #241 set.
  assertFalse(JSON.stringify(text).includes('price list'));
});

Deno.test('an inbound MessageStatus value is treated as inbound, never mapped to a state', () => {
  assertEquals(mapTwilioStatus('received'), null);
  assertEquals(mapTwilioStatus('receiving'), null);
  const classified = classifyTwilioWebhook({
    MessageSid: 'SM997', MessageStatus: 'received', From: 'whatsapp:+972501234567',
  });
  assertEquals(classified.kind, 'inbound');
});

Deno.test('a payload with no recognizable shape is unsupported, not silently accepted', () => {
  assertEquals(classifyTwilioWebhook({}).kind, 'unsupported');
  assertEquals(classifyTwilioWebhook({ MessageStatus: 'delivered' }).kind, 'unsupported');
  assertEquals(classifyTwilioWebhook({ MessageSid: 'SM1', From: 'whatsapp:+1' }).kind, 'unsupported');
});

Deno.test('every documented outbound status maps to exactly one internal state, monotonically', () => {
  // Twilio's published outbound vocabulary, read 2026-08-23 from the Message resource page.
  assertEquals(mapTwilioStatus('queued'), 'accepted');
  assertEquals(mapTwilioStatus('accepted'), 'accepted');
  assertEquals(mapTwilioStatus('scheduled'), 'accepted');
  // `sending` maps forward, never back: the internal `sending` state means "we are mid-attempt",
  // and a provider that has taken the message is already further along than that.
  assertEquals(mapTwilioStatus('sending'), 'accepted');
  assertEquals(mapTwilioStatus('sent'), 'sent');
  assertEquals(mapTwilioStatus('delivered'), 'delivered');
  assertEquals(mapTwilioStatus('read'), 'read');
  // Pins an INHERITED ASSUMPTION, not a decision: 'undelivered' -> 'failed' follows #238's
  // EMAIL rule; the WhatsApp question was deferred by the owner on 23.08.2026 until a Twilio
  // account exists (see the marker at this mapping in core.ts). Green here is not agreement.
  assertEquals(mapTwilioStatus('undelivered'), 'failed');
  assertEquals(mapTwilioStatus('failed'), 'failed');
  assertEquals(mapTwilioStatus('canceled'), 'failed');
  assertEquals(mapTwilioStatus('invented'), null);
  assertEquals(mapTwilioStatus('DELIVERED'), 'delivered');
});

Deno.test('provider error codes are bounded and normalized to the database vocabulary', () => {
  assertEquals(normalizeProviderErrorCode('63016'), 'twilio_63016');
  assertEquals(normalizeProviderErrorCode('  30008  '), 'twilio_30008');
  assertEquals(normalizeProviderErrorCode(null), null);
  assertEquals(normalizeProviderErrorCode(''), null);
  // Anything unexpected collapses to a safe enumerated code rather than travelling verbatim.
  assertEquals(normalizeProviderErrorCode('DROP TABLE x;'), 'twilio_unknown');
  // An absurdly long value collapses instead of travelling into a length-capped column.
  const long = normalizeProviderErrorCode('9'.repeat(200));
  assertEquals(long, 'twilio_unknown');
  assert((long ?? '').length <= 100 && /^[a-z0-9_]+$/.test(long ?? ''));
});

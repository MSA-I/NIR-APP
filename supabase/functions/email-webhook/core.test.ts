// email-webhook/core.test.ts -- the signed Resend delivery webhook contract, pinned.
//
// Runs with no Deno permissions and no Supabase stack: core.ts is pure by construction, so the
// signature scheme, the tolerance window, the event vocabulary and the bounded reason are all
// exercised here in milliseconds (the outbox-worker/core.test.ts precedent, including its
// node:test + node:assert imports so nothing is fetched at test time).
//
// The known-answer vector below was computed with Node's crypto -- a DIFFERENT implementation
// from the code under test -- so a refactor that changes the signed-content construction cannot
// pass by agreeing with itself.
//
// PROVIDER CONTRACT, read 2026-08-23:
//   https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests  (svix-id / svix-timestamp
//     / svix-signature; "use the raw request body")
//   https://docs.svix.com/receiving/verifying-payloads/how-manual        (signed content is
//     `${id}.${timestamp}.${body}`; secret is `whsec_` + base64; HMAC-SHA256; base64 signature;
//     header carries space-separated `v1,<sig>` entries; constant-time compare)
//   https://docs.svix.com/receiving/verifying-payloads/why               (+/- 5 minute tolerance)
//   https://resend.com/docs/webhooks/introduction                        (payload: `type`,
//     `created_at`, `data.email_id`, `data.message_id`, `data.bounce.{type,subType,message}`)
//   https://resend.com/docs/dashboard/webhooks/event-types               (the full event list)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSigningSecret,
  mapRecordOutcome,
  parseDeliveryEvent,
  parseSignatureHeader,
  readWebhookHeaders,
  REASON_MESSAGE_MAX,
  SIGNATURE_TOLERANCE_SECONDS,
  signedContent,
  verifyWebhookSignature,
} from './core.ts';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const EVENT_ID = 'msg_2ZbVjPcWiTjTKzYFqfCLxaXbCzN';
const TIMESTAMP = '1755900000';
const NOW = 1755900000;
// Deliberately carries Hebrew: the signature covers raw UTF-8 bytes, so a re-encode breaks it.
const DELIVERED_BODY = '{"type":"email.delivered","created_at":"2026-08-23T09:00:00.000Z","data":{"email_id":"56761188-7520-42d8-8898-ff6fc54ce618","message_id":"<111-222-333@email.example.com>","from":"InPlace <no-reply@inplace.digital>","to":["supplier@example.test"],"subject":"הזמנת רכש"}}';
const DELIVERED_SIGNATURE = 'nTGFfVudaMMynI6fTsSaKe9CDVuTEEPo+tggst4Xqww=';

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'svix-id': EVENT_ID,
    'svix-timestamp': TIMESTAMP,
    'svix-signature': `v1,${DELIVERED_SIGNATURE}`,
    ...extra,
  });
}

function verify(rawBody: string, request: Headers, now = NOW, secret = SECRET) {
  const parsed = readWebhookHeaders(request);
  assert.ok(parsed !== null, 'headers should parse for this fixture');
  return verifyWebhookSignature({ rawBody, headers: parsed, secret, nowSeconds: now });
}

test('the signed content is id.timestamp.rawBody, exactly', () => {
  assert.equal(
    signedContent(EVENT_ID, TIMESTAMP, DELIVERED_BODY),
    `${EVENT_ID}.${TIMESTAMP}.${DELIVERED_BODY}`,
  );
});

test('the signing secret is whsec_ + base64 and decodes to its raw key bytes', () => {
  const key = decodeSigningSecret(SECRET);
  assert.ok(key instanceof Uint8Array);
  assert.equal(key.length, 24);
  assert.equal(decodeSigningSecret('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw')?.length, 24);
  assert.equal(decodeSigningSecret('whsec_not base64 !!'), null);
  assert.equal(decodeSigningSecret(''), null);
  assert.equal(decodeSigningSecret(undefined), null);
});

test('a valid signature over the raw body is accepted (known-answer vector)', async () => {
  assert.deepEqual(await verify(DELIVERED_BODY, headers()), { ok: true, eventId: EVENT_ID });
});

test('the webhook- header aliases are accepted', () => {
  const aliased = new Headers({
    'webhook-id': EVENT_ID,
    'webhook-timestamp': TIMESTAMP,
    'webhook-signature': `v1,${DELIVERED_SIGNATURE}`,
  });
  assert.deepEqual(readWebhookHeaders(aliased), {
    id: EVENT_ID, timestamp: TIMESTAMP, signature: `v1,${DELIVERED_SIGNATURE}`,
  });
});

test('a wrong signature is rejected', async () => {
  const forged = 'AAAAfVudaMMynI6fTsSaKe9CDVuTEEPo+tggst4Xqww=';
  assert.deepEqual(
    await verify(DELIVERED_BODY, headers({ 'svix-signature': `v1,${forged}` })),
    { ok: false, reason: 'signature_mismatch' },
  );
});

test('missing signature headers are rejected before anything is parsed', async () => {
  assert.equal(readWebhookHeaders(new Headers()), null);
  assert.equal(readWebhookHeaders(new Headers({ 'svix-id': EVENT_ID })), null);
  assert.equal(
    readWebhookHeaders(new Headers({ 'svix-id': EVENT_ID, 'svix-timestamp': TIMESTAMP })),
    null,
  );
  assert.deepEqual(
    await verifyWebhookSignature({
      rawBody: DELIVERED_BODY,
      headers: { id: '', timestamp: TIMESTAMP, signature: `v1,${DELIVERED_SIGNATURE}` },
      secret: SECRET,
      nowSeconds: NOW,
    }),
    { ok: false, reason: 'missing_headers' },
  );
});

test('a tampered body with valid-looking headers is rejected', async () => {
  const tampered = DELIVERED_BODY.replace('email.delivered', 'email.bounced');
  assert.deepEqual(
    await verify(tampered, headers()),
    { ok: false, reason: 'signature_mismatch' },
  );
});

test('a stale or future timestamp outside the +/- 5 minute window is rejected', async () => {
  assert.equal(SIGNATURE_TOLERANCE_SECONDS, 300);
  assert.deepEqual(
    await verify(DELIVERED_BODY, headers(), NOW + SIGNATURE_TOLERANCE_SECONDS + 1),
    { ok: false, reason: 'timestamp_out_of_tolerance' },
  );
  assert.deepEqual(
    await verify(DELIVERED_BODY, headers(), NOW - SIGNATURE_TOLERANCE_SECONDS - 1),
    { ok: false, reason: 'timestamp_out_of_tolerance' },
  );
  assert.deepEqual(
    await verify(DELIVERED_BODY, headers(), NOW + SIGNATURE_TOLERANCE_SECONDS),
    { ok: true, eventId: EVENT_ID },
  );
  assert.deepEqual(
    await verify(DELIVERED_BODY, headers(), NOW - SIGNATURE_TOLERANCE_SECONDS),
    { ok: true, eventId: EVENT_ID },
  );
  assert.deepEqual(
    await verify(DELIVERED_BODY, headers({ 'svix-timestamp': 'not-a-number' })),
    { ok: false, reason: 'timestamp_out_of_tolerance' },
  );
});

test('a rotated multi-signature header is accepted when ANY version matches', async () => {
  const stale = 'BBBBfVudaMMynI6fTsSaKe9CDVuTEEPo+tggst4Xqww=';
  assert.deepEqual(
    parseSignatureHeader(`v1,${stale} v1,${DELIVERED_SIGNATURE}`),
    [stale, DELIVERED_SIGNATURE],
  );
  assert.deepEqual(
    await verify(DELIVERED_BODY, headers({ 'svix-signature': `v1,${stale} v1,${DELIVERED_SIGNATURE}` })),
    { ok: true, eventId: EVENT_ID },
  );
  assert.deepEqual(
    await verify(DELIVERED_BODY, headers({ 'svix-signature': `v1,${DELIVERED_SIGNATURE} v1,${stale}` })),
    { ok: true, eventId: EVENT_ID },
  );
  // An unknown scheme version is not a signature we can check, so it never grants acceptance.
  assert.deepEqual(parseSignatureHeader(`v9,${DELIVERED_SIGNATURE}`), []);
  assert.deepEqual(
    await verify(DELIVERED_BODY, headers({ 'svix-signature': `v9,${DELIVERED_SIGNATURE}` })),
    { ok: false, reason: 'signature_mismatch' },
  );
  // Header values arrive whitespace-stripped, so an all-blank signature reaches the verifier as
  // an empty string: no signature at all, not a mismatch.
  assert.deepEqual(
    await verifyWebhookSignature({
      rawBody: DELIVERED_BODY,
      headers: { id: EVENT_ID, timestamp: TIMESTAMP, signature: '   ' },
      secret: SECRET,
      nowSeconds: NOW,
    }),
    { ok: false, reason: 'missing_headers' },
  );
});

test('a misconfigured signing secret refuses rather than accepting anything', async () => {
  assert.deepEqual(
    await verify(DELIVERED_BODY, headers(), NOW, 'whsec_%%%'),
    { ok: false, reason: 'misconfigured_secret' },
  );
});

test('the four delivery event types parse to their bounded reason codes', () => {
  assert.deepEqual(parseDeliveryEvent(JSON.parse(DELIVERED_BODY)), {
    eventType: 'delivered',
    providerMessageId: '56761188-7520-42d8-8898-ff6fc54ce618',
    occurredAt: '2026-08-23T09:00:00.000Z',
    reasonCode: 'delivered',
    reasonMessage: null,
  });

  const bounced = parseDeliveryEvent({
    type: 'email.bounced',
    created_at: '2026-08-23T09:05:00.000Z',
    data: {
      email_id: 'aa000000-0000-4000-8000-00000000000a',
      bounce: {
        type: 'Permanent',
        subType: 'Suppressed',
        message: "The recipient's email address is on the suppression list.",
      },
    },
  });
  assert.equal(bounced?.eventType, 'bounced');
  assert.equal(bounced?.reasonCode, 'bounce_permanent');
  assert.equal(bounced?.reasonMessage, "The recipient's email address is on the suppression list.");

  assert.equal(
    parseDeliveryEvent({
      type: 'email.delivery_delayed',
      created_at: '2026-08-23T09:06:00.000Z',
      data: { email_id: 'aa000000-0000-4000-8000-00000000000a' },
    })?.reasonCode,
    'delivery_delayed',
  );
  assert.equal(
    parseDeliveryEvent({
      type: 'email.complained',
      created_at: '2026-08-23T09:07:00.000Z',
      data: { email_id: 'aa000000-0000-4000-8000-00000000000a' },
    })?.reasonCode,
    'complaint',
  );
});

test('an unclassified bounce keeps a code rather than borrowing a stronger one', () => {
  const cases: Array<[string | undefined, string]> = [
    ['Permanent', 'bounce_permanent'],
    ['Transient', 'bounce_transient'],
    ['Undetermined', 'bounce_undetermined'],
    ['SomethingResendAddedLater', 'bounce_unclassified'],
    [undefined, 'bounce_unclassified'],
  ];
  for (const [providerType, code] of cases) {
    const parsed = parseDeliveryEvent({
      type: 'email.bounced',
      created_at: '2026-08-23T09:05:00.000Z',
      data: {
        email_id: 'aa000000-0000-4000-8000-00000000000a',
        bounce: providerType === undefined ? {} : { type: providerType },
      },
    });
    assert.equal(parsed?.reasonCode, code, `bounce.type=${providerType}`);
  }
});

test('the stored reason is bounded: no raw payload, capped message', () => {
  const parsed = parseDeliveryEvent({
    type: 'email.bounced',
    created_at: '2026-08-23T09:05:00.000Z',
    data: {
      email_id: 'aa000000-0000-4000-8000-00000000000a',
      subject: 'a subject that must never be stored',
      to: ['supplier@example.test'],
      bounce: { type: 'Permanent', message: 'x'.repeat(REASON_MESSAGE_MAX + 250) },
    },
  });
  assert.equal(parsed?.reasonMessage?.length, REASON_MESSAGE_MAX);
  // The parse result is the WHOLE storable surface: five bounded fields, nothing provider-shaped.
  assert.deepEqual(
    Object.keys(parsed ?? {}).sort(),
    ['eventType', 'occurredAt', 'providerMessageId', 'reasonCode', 'reasonMessage'],
  );
});

test('an unknown or non-delivery event type is ignored explicitly', () => {
  for (const type of [
    'email.sent', 'email.opened', 'email.clicked', 'email.scheduled', 'email.failed',
    'email.received', 'email.suppressed', 'contact.created', 'domain.updated', 'nonsense', '',
  ]) {
    assert.equal(
      parseDeliveryEvent({
        type,
        created_at: '2026-08-23T09:00:00.000Z',
        data: { email_id: 'aa000000-0000-4000-8000-00000000000a' },
      }),
      null,
      type,
    );
  }
  assert.equal(parseDeliveryEvent(null), null);
  assert.equal(parseDeliveryEvent('email.delivered'), null);
  assert.equal(parseDeliveryEvent({ type: 'email.delivered' }), null);
  assert.equal(parseDeliveryEvent({ type: 'email.delivered', data: { email_id: '' } }), null);
});

test('every durably-handled outcome answers 2xx so the provider stops retrying', () => {
  // A webhook that answers non-2xx is retried for hours. Duplicate, unmatched and stale events
  // are all HANDLED -- the database decided, nothing is pending -- so they answer ok.
  assert.deepEqual(
    mapRecordOutcome({ state: 'applied', status: 'delivered', delivery_state: 'delivered' }),
    {
      status: 200,
      body: { ok: true, state: 'applied', status: 'delivered', delivery_state: 'delivered' },
    },
  );
  for (const state of ['duplicate', 'unmatched', 'stale', 'not_settled']) {
    const mapped = mapRecordOutcome({ state });
    assert.equal(mapped.status, 200, state);
    assert.equal(mapped.body.ok, true, state);
    assert.equal(mapped.body.state, state);
  }
  // A bounce settles the CHANNEL, never the order lifecycle: the reported surface has no order.
  const bounced = mapRecordOutcome({ state: 'applied', status: 'bounced', delivery_state: 'delivery_failed' });
  assert.equal(bounced.body.delivery_state, 'delivery_failed');
  assert.ok(!('order_status' in bounced.body));
  assert.ok(!('purchase_order' in bounced.body));
  // A missing/rubbish answer from the database is NOT a success -- it must be retried.
  assert.equal(mapRecordOutcome(null).status, 500);
  assert.equal(mapRecordOutcome({}).status, 500);
});

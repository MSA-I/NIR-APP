// Contract tests for the WhatsApp outbound sender.
//
// Every request property asserted here comes from Twilio's published contract, read 2026-08-23:
//   https://www.twilio.com/docs/messaging/api/message-resource
//   https://www.twilio.com/docs/content/send-templates-created-with-the-content-template-builder
//   https://www.twilio.com/docs/whatsapp/api
// Nothing here talks to a provider: Twilio is SELECTED / ACCOUNT_NOT_PROVEN /
// CREDENTIALS_NOT_CONFIGURED / NOT_INTEGRATED (#239).
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1';
import {
  buildProviderRequest,
  classifyProviderOutcome,
  resolveSenderConfiguration,
  toChannelAddress,
} from './core.ts';

const CONNECTION = {
  provider: 'twilio' as const,
  providerAccountId: 'ACtest0000000000000000000000000000',
  providerSenderId: 'whatsapp:+972500000001',
  orderTemplateName: 'HXtemplateorder0000000000000000000',
  reminderTemplateName: 'HXtemplatereminder00000000000000',
  languageCode: 'he',
};

Deno.test('a channel address always carries the whatsapp: prefix over E.164', () => {
  assertEquals(toChannelAddress('972501234567'), 'whatsapp:+972501234567');
  assertEquals(toChannelAddress('+972501234567'), 'whatsapp:+972501234567');
  assertEquals(toChannelAddress('whatsapp:+972501234567'), 'whatsapp:+972501234567');
  assertEquals(toChannelAddress('050-123-4567'), null);
  assertEquals(toChannelAddress(''), null);
});

Deno.test('the create-message request is the documented form POST, not JSON', () => {
  const request = buildProviderRequest({
    connection: CONNECTION,
    kind: 'order',
    recipient: '972501234567',
    variables: { '1': 'InPlace', '2': '1043' },
    statusCallbackUrl: 'https://app.test/functions/v1/whatsapp-webhook',
  });
  if (!request.ok) throw new Error('expected a buildable request');
  assertEquals(request.method, 'POST');
  assertEquals(
    request.url,
    `https://api.twilio.com/2010-04-01/Accounts/${CONNECTION.providerAccountId}/Messages.json`,
  );
  assertEquals(request.contentType, 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(request.body);
  assertEquals(form.get('To'), 'whatsapp:+972501234567');
  assertEquals(form.get('From'), 'whatsapp:+972500000001');
  assertEquals(form.get('ContentSid'), CONNECTION.orderTemplateName);
  assertEquals(form.get('ContentVariables'), JSON.stringify({ '1': 'InPlace', '2': '1043' }));
  assertEquals(form.get('StatusCallback'), 'https://app.test/functions/v1/whatsapp-webhook');
});

Deno.test('ContentSid replaces Body and MediaUrl -- the documented template rule', () => {
  const request = buildProviderRequest({
    connection: CONNECTION,
    kind: 'order',
    recipient: '972501234567',
    variables: {},
    statusCallbackUrl: 'https://app.test/hook',
  });
  if (!request.ok) throw new Error('expected a buildable request');
  const form = new URLSearchParams(request.body);
  assertFalse(form.has('Body'));
  assertFalse(form.has('MediaUrl'));
});

Deno.test('a reminder uses the reminder template, not the order template', () => {
  const request = buildProviderRequest({
    connection: CONNECTION,
    kind: 'reminder',
    recipient: '972501234567',
    variables: {},
    statusCallbackUrl: 'https://app.test/hook',
  });
  if (!request.ok) throw new Error('expected a buildable request');
  assertEquals(new URLSearchParams(request.body).get('ContentSid'), CONNECTION.reminderTemplateName);
});

Deno.test('the credential never appears in the built request -- it is applied at fetch time only', () => {
  const request = buildProviderRequest({
    connection: CONNECTION,
    kind: 'order',
    recipient: '972501234567',
    variables: { '1': 'x' },
    statusCallbackUrl: 'https://app.test/hook',
  });
  if (!request.ok) throw new Error('expected a buildable request');
  assertFalse(JSON.stringify(request).toLowerCase().includes('authorization'));
  assertFalse(JSON.stringify(request).toLowerCase().includes('authtoken'));
});

Deno.test('no Idempotency-Key is invented: Twilio documents none for message creation', () => {
  const request = buildProviderRequest({
    connection: CONNECTION,
    kind: 'order',
    recipient: '972501234567',
    variables: {},
    statusCallbackUrl: 'https://app.test/hook',
  });
  if (!request.ok) throw new Error('expected a buildable request');
  // Duplicate suppression is the database claim-with-lease (0028/0029), not a header we wish
  // the provider had. Asserting the absence keeps a future edit from quietly pretending.
  assertEquals(Object.keys(request.extraHeaders ?? {}), []);
});

Deno.test('an unreachable recipient refuses to build a request instead of sending somewhere', () => {
  const request = buildProviderRequest({
    connection: CONNECTION,
    kind: 'order',
    recipient: 'not-a-number',
    variables: {},
    statusCallbackUrl: 'https://app.test/hook',
  });
  assertFalse(request.ok);
  if (request.ok) throw new Error('unreachable');
  assertEquals(request.reason, 'recipient_unreachable');
});

Deno.test('a connection without a template refuses to build a request', () => {
  const request = buildProviderRequest({
    connection: { ...CONNECTION, orderTemplateName: '   ' },
    kind: 'order',
    recipient: '972501234567',
    variables: {},
    statusCallbackUrl: 'https://app.test/hook',
  });
  assertFalse(request.ok);
  if (request.ok) throw new Error('unreachable');
  assertEquals(request.reason, 'template_missing');
});

Deno.test('a provider we have not implemented refuses rather than sending as if it were Twilio', () => {
  const request = buildProviderRequest({
    connection: { ...CONNECTION, provider: 'meta_cloud' as unknown as 'twilio' },
    kind: 'order',
    recipient: '972501234567',
    variables: {},
    statusCallbackUrl: 'https://app.test/hook',
  });
  assertFalse(request.ok);
  if (request.ok) throw new Error('unreachable');
  assertEquals(request.reason, 'provider_not_implemented');
});

Deno.test('missing or disabled configuration returns misconfigured and attempts nothing', () => {
  assertEquals(
    resolveSenderConfiguration({ status: 'active', appBaseUrl: '', credential: 'x' }).state,
    'misconfigured',
  );
  assertEquals(
    resolveSenderConfiguration({ status: 'active', appBaseUrl: 'https://app.test', credential: '' }).state,
    'misconfigured',
  );
  assertEquals(
    resolveSenderConfiguration({ status: 'disabled', appBaseUrl: 'https://app.test', credential: 'x' }).state,
    'misconfigured',
  );
  assertEquals(
    resolveSenderConfiguration({ status: 'pending', appBaseUrl: 'https://app.test', credential: 'x' }).state,
    'misconfigured',
  );
  const ready = resolveSenderConfiguration({
    status: 'active', appBaseUrl: 'https://app.test/', credential: 'x',
  });
  assertEquals(ready.state, 'ready');
  if (ready.state !== 'ready') throw new Error('unreachable');
  assertEquals(ready.statusCallbackUrl, 'https://app.test/functions/v1/whatsapp-webhook');
});

Deno.test('misconfigured leaves the manual channel available and never claims a provider send', () => {
  const misconfigured = resolveSenderConfiguration({
    status: 'disabled', appBaseUrl: 'https://app.test', credential: 'x',
  });
  if (misconfigured.state !== 'misconfigured') throw new Error('unreachable');
  assert(misconfigured.manualShareAvailable);
  assertFalse(misconfigured.providerDelivery);
});

Deno.test('a 201 with a message sid is an acceptance; anything else is a bounded failure', () => {
  const accepted = classifyProviderOutcome(201, { sid: 'SM123', status: 'queued' });
  assertEquals(accepted.outcome, 'accepted');
  if (accepted.outcome !== 'accepted') throw new Error('unreachable');
  assertEquals(accepted.providerMessageId, 'SM123');

  const rejected = classifyProviderOutcome(400, { code: 63016, message: 'template not approved' });
  assertEquals(rejected.outcome, 'failed');
  if (rejected.outcome !== 'failed') throw new Error('unreachable');
  assertEquals(rejected.errorCode, 'twilio_63016');
  assert(rejected.errorMessage.length <= 500);

  // A 2xx with no sid is NOT success: without a provider identifier there is nothing to settle
  // against, and claiming delivery would be a fabricated business fact.
  const sidless = classifyProviderOutcome(201, { status: 'queued' });
  assertEquals(sidless.outcome, 'ambiguous');

  const serverError = classifyProviderOutcome(503, null);
  assertEquals(serverError.outcome, 'ambiguous');
});

Deno.test('a bounded failure code always matches the database CHECK vocabulary', () => {
  const rejected = classifyProviderOutcome(400, { code: 'nonsense', message: 'x'.repeat(4000) });
  if (rejected.outcome !== 'failed') throw new Error('unreachable');
  assert(/^[a-z0-9_]+$/.test(rejected.errorCode));
  assert(rejected.errorCode.length <= 100);
  assertEquals(rejected.errorMessage.length, 500);
});

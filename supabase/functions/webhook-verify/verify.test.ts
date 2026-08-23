// webhook-verify/verify.test.ts — the handshake orchestration.
//
// The properties under test are all refusals: what the worker does when the endpoint answers
// wrong, redirects, resolves privately, or says nothing. The one success case exists to prove
// the challenge echo actually reaches the settle call.

import assert from 'node:assert/strict';
import test from 'node:test';
import { CHALLENGE_HEADER, runVerification, type BeginEnvelope, type VerifyRpc } from './verify.ts';
import type { DialDeps, GuardedConnection } from './ssrf.ts';

const PUBLIC_ADDRESS = '93.184.216.34';
const VERIFICATION_ID = '9b000000-0000-4000-8000-000000000001';

function envelope(overrides: Partial<BeginEnvelope> = {}): BeginEnvelope {
  return {
    subscription_id: 'a8000000-0000-4000-8000-000000000001',
    url: 'https://hooks.example.com/inplace',
    body: '{"type":"webhook.verification","challenge":"NONCE"}',
    timestamp: '1754400000',
    signature: 'deadbeef',
    correlation_id: VERIFICATION_ID,
    ...overrides,
  };
}

interface Harness {
  rpc: VerifyRpc;
  settles: Array<{ echo: string | null; failureCode: string | null }>;
  deps: DialDeps;
  written: () => string;
}

function harness(options: {
  response?: string;
  answers?: string[];
  beginError?: string;
  verified?: boolean;
  completeCode?: string;
}): Harness {
  const settles: Harness['settles'] = [];
  let written = '';

  const connection: GuardedConnection = (() => {
    const bytes = new TextEncoder().encode(
      options.response ??
        `HTTP/1.1 200 OK\r\n${CHALLENGE_HEADER}: NONCE\r\n\r\n`,
    );
    let offset = 0;
    return {
      write(chunk: Uint8Array): Promise<number> {
        written += new TextDecoder().decode(chunk);
        return Promise.resolve(chunk.length);
      },
      read(buffer: Uint8Array): Promise<number | null> {
        if (offset >= bytes.length) return Promise.resolve(null);
        const slice = bytes.subarray(offset, offset + buffer.length);
        buffer.set(slice);
        offset += slice.length;
        return Promise.resolve(slice.length);
      },
      close(): void {},
    };
  })();

  return {
    settles,
    written: () => written,
    deps: {
      resolve: () => Promise.resolve(options.answers ?? [PUBLIC_ADDRESS]),
      connect: () => Promise.resolve(connection),
    },
    rpc: {
      begin() {
        if (options.beginError) {
          return Promise.resolve({ data: null, error: { message: options.beginError } });
        }
        return Promise.resolve({ data: envelope(), error: null });
      },
      complete(_id, echo, failureCode) {
        settles.push({ echo, failureCode });
        const verified = options.verified ?? (echo === 'NONCE' && failureCode === null);
        return Promise.resolve({
          data: { verified, code: verified ? undefined : (options.completeCode ?? failureCode ?? 'x') },
          error: null,
        });
      },
    },
  };
}

test('a correct echo verifies, and the signed body is posted verbatim', async () => {
  const h = harness({});
  const outcome = await runVerification(VERIFICATION_ID, h.rpc, h.deps);
  assert.deepEqual(outcome, { verified: true, code: 'webhook_verification_succeeded' });
  assert.deepEqual(h.settles, [{ echo: 'NONCE', failureCode: null }]);
  // Verbatim: the database signed exactly these bytes, so a re-serialization would break the
  // receiver's HMAC check.
  assert.ok(h.written().endsWith('\r\n\r\n{"type":"webhook.verification","challenge":"NONCE"}'));
  assert.match(h.written(), /\r\nx-supplyflow-signature: sha256=deadbeef\r\n/);
  assert.match(h.written(), /\r\nx-supplyflow-timestamp: 1754400000\r\n/);
});

test('a 2xx without the challenge header is not a verification', async () => {
  const h = harness({ response: 'HTTP/1.1 204 No Content\r\nserver: nginx\r\n\r\n' });
  const outcome = await runVerification(VERIFICATION_ID, h.rpc, h.deps);
  assert.equal(outcome.verified, false);
  assert.deepEqual(h.settles, [
    { echo: null, failureCode: 'webhook_verification_challenge_absent' },
  ]);
});

test('a redirect is a failure code, never a followed hop', async () => {
  const h = harness({
    response: 'HTTP/1.1 302 Found\r\nlocation: https://169.254.169.254/\r\n\r\n',
  });
  const outcome = await runVerification(VERIFICATION_ID, h.rpc, h.deps);
  assert.equal(outcome.verified, false);
  assert.deepEqual(h.settles, [{ echo: null, failureCode: 'webhook_verification_status_302' }]);
});

test('a non-2xx status is reported by code, not by body', async () => {
  const h = harness({ response: 'HTTP/1.1 500 Internal Server Error\r\n\r\nstack trace here' });
  const outcome = await runVerification(VERIFICATION_ID, h.rpc, h.deps);
  assert.deepEqual(h.settles, [{ echo: null, failureCode: 'webhook_verification_status_500' }]);
  assert.equal(outcome.code, 'webhook_verification_status_500');
  assert.equal(outcome.code.includes('stack'), false);
});

test('a host that resolves privately settles as a rejection and never connects', async () => {
  let connects = 0;
  const h = harness({ answers: ['169.254.169.254'] });
  const deps: DialDeps = {
    resolve: h.deps.resolve,
    connect: (options) => {
      connects += 1;
      return h.deps.connect(options);
    },
  };
  const outcome = await runVerification(VERIFICATION_ID, h.rpc, deps);
  assert.equal(connects, 0);
  assert.equal(outcome.verified, false);
  assert.deepEqual(h.settles, [{ echo: null, failureCode: 'webhook_url_private_address' }]);
});

test('every failure code satisfies the shape the database enforces', async () => {
  for (const response of [
    'HTTP/1.1 302 Found\r\n\r\n',
    'HTTP/1.1 418 I am a teapot\r\n\r\n',
    'HTTP/1.1 204 No Content\r\n\r\n',
  ]) {
    const h = harness({ response });
    await runVerification(VERIFICATION_ID, h.rpc, h.deps);
    assert.match(h.settles[0].failureCode ?? '', /^[a-z0-9_]{1,100}$/);
  }
});

test('a database refusal is mapped to a named code and never settled', async () => {
  const h = harness({ beginError: 'webhook_verification_already_dispatched' });
  const outcome = await runVerification(VERIFICATION_ID, h.rpc, h.deps);
  assert.deepEqual(outcome, {
    verified: false,
    code: 'webhook_verification_already_dispatched',
  });
  assert.equal(h.settles.length, 0, 'an attempt we could not begin is not ours to settle');
});

test('an unrecognised database message never reaches the caller', async () => {
  const h = harness({
    beginError:
      'permission denied for relation private.webhook_verification_attempts at 10.0.3.7',
  });
  const outcome = await runVerification(VERIFICATION_ID, h.rpc, h.deps);
  assert.equal(outcome.code, 'webhook_verification_unavailable');
  assert.equal(outcome.code.includes('10.0.3.7'), false);
  assert.equal(outcome.code.includes('permission'), false);
});

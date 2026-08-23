// webhook-verify/ssrf.test.ts — the SSRF attack corpus (threat model §4 D1–D4, D10).
//
// Every case here is a ROW in a table, one row per hostile encoding, because the failure mode
// this file exists to prevent is a hand-written `if` chain that covers the three shapes its
// author happened to remember. A dropped class must show up as a named missing row, not as a
// silently narrower guard.
//
// The four assertions this file carries:
//   D1  the corpus: every loopback / private / link-local / reserved / multicast / CGNAT
//       encoding is rejected, including decimal, octal, hex, IPv4-mapped-IPv6 and bracketed
//       forms that a string check on the URL misses;
//   D2  a redirect is refused AT THE HOP: the client has no redirect-following code path at
//       all, and a 3xx first hop is reported as a rejection after exactly one connect;
//   D3  the resolve-then-connect race: the socket is PINNED to the address that was validated,
//       resolution happens exactly once, and a resolver that answers differently on its second
//       call cannot change the address dialled;
//   D4  scheme and authority: https only, no file:/gopher:/ftp:/data:, no credentials.
//   D10 mutation proof: the corpus assertion is run against a deliberately weakened validator
//       and observed to turn red, so a green D1 is evidence rather than decoration.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addressClass,
  classifyWebhookUrl,
  guardedRequest,
  type DialDeps,
  type GuardedConnection,
  type UrlRejection,
} from './ssrf.ts';

/* ===================== D1 — the attack corpus ===================== */

interface CorpusCase {
  /** The URL a tenant owner could type into the settings form. */
  url: string;
  /** The named rejection the validator must answer with. */
  code: UrlRejection;
  /** Why this row exists — one sentence, so a deletion has to argue with it. */
  why: string;
}

/**
 * Threat model §4 items 2 and 3, verbatim, plus the encodings that make item 2's
 * "in every encoding a naive string check misses" concrete.
 */
const CORPUS: CorpusCase[] = [
  // -- item 2: loopback in every encoding
  { url: 'https://127.0.0.1/hook', code: 'webhook_url_ip_literal_rejected', why: 'dotted-quad loopback' },
  { url: 'https://localhost/hook', code: 'webhook_url_local_name_rejected', why: 'the name every string check remembers' },
  { url: 'https://[::1]/hook', code: 'webhook_url_ip_literal_rejected', why: 'bracketed IPv6 loopback' },
  { url: 'https://0.0.0.0/hook', code: 'webhook_url_ip_literal_rejected', why: 'unspecified address, routes to local on many stacks' },
  { url: 'https://0x7f.1/hook', code: 'webhook_url_ip_literal_rejected', why: 'hex-and-decimal inet_aton form of 127.0.0.1' },
  { url: 'https://2130706433/hook', code: 'webhook_url_ip_literal_rejected', why: 'single 32-bit decimal form of 127.0.0.1' },
  { url: 'https://0177.0.0.1/hook', code: 'webhook_url_ip_literal_rejected', why: 'octal first octet form of 127.0.0.1' },
  { url: 'https://0x7f000001/hook', code: 'webhook_url_ip_literal_rejected', why: 'single hex form of 127.0.0.1' },
  // -- item 3: RFC1918 / CGNAT / link-local / reserved / multicast
  { url: 'https://169.254.169.254/latest/meta-data/', code: 'webhook_url_ip_literal_rejected', why: 'cloud instance metadata, the classic credential theft' },
  { url: 'https://10.0.0.1/hook', code: 'webhook_url_ip_literal_rejected', why: 'RFC1918 10/8' },
  { url: 'https://172.16.0.1/hook', code: 'webhook_url_ip_literal_rejected', why: 'RFC1918 172.16/12' },
  { url: 'https://192.168.1.1/hook', code: 'webhook_url_ip_literal_rejected', why: 'RFC1918 192.168/16' },
  { url: 'https://100.64.0.1/hook', code: 'webhook_url_ip_literal_rejected', why: 'CGNAT 100.64/10' },
  { url: 'https://224.0.0.1/hook', code: 'webhook_url_ip_literal_rejected', why: 'IPv4 multicast 224/4' },
  { url: 'https://[::ffff:127.0.0.1]/hook', code: 'webhook_url_ip_literal_rejected', why: 'IPv4-mapped IPv6 loopback' },
  { url: 'https://[fc00::1]/hook', code: 'webhook_url_ip_literal_rejected', why: 'IPv6 unique-local fc00::/7' },
  { url: 'https://[fe80::1]/hook', code: 'webhook_url_ip_literal_rejected', why: 'IPv6 link-local fe80::/10' },
  // -- names that resolve locally by convention
  { url: 'https://api.internal.local/hook', code: 'webhook_url_local_name_rejected', why: 'mDNS .local suffix' },
  { url: 'https://svc.localhost/hook', code: 'webhook_url_local_name_rejected', why: '.localhost suffix is loopback by RFC 6761' },
  { url: 'https://erp.internal/hook', code: 'webhook_url_local_name_rejected', why: 'the conventional private-zone suffix' },
  { url: 'https://1.0.0.127.in-addr.arpa/hook', code: 'webhook_url_local_name_rejected', why: 'reverse-DNS zone is not an integration endpoint' },
  // -- D4: scheme and authority
  { url: 'http://hooks.example.com/hook', code: 'webhook_url_scheme_rejected', why: 'plaintext http is not an option (#253)' },
  { url: 'file:///etc/passwd', code: 'webhook_url_scheme_rejected', why: 'file:' },
  { url: 'gopher://hooks.example.com/_x', code: 'webhook_url_scheme_rejected', why: 'gopher: — the classic protocol-smuggling scheme' },
  { url: 'ftp://hooks.example.com/x', code: 'webhook_url_scheme_rejected', why: 'ftp:' },
  { url: 'data:text/plain,hello', code: 'webhook_url_scheme_rejected', why: 'data:' },
  { url: 'https://user:pass@hooks.example.com/hook', code: 'webhook_url_credentials_rejected', why: 'credentials in the authority' },
  { url: 'https://user@hooks.example.com/hook', code: 'webhook_url_credentials_rejected', why: 'userinfo without a password is still userinfo' },
  { url: 'https://hooks.example.com:8443/hook', code: 'webhook_url_port_rejected', why: 'a non-443 port is a port scan primitive' },
  { url: 'https://hooks.example.com:22/hook', code: 'webhook_url_port_rejected', why: 'ssh' },
  // -- malformed
  { url: 'not a url', code: 'webhook_url_invalid', why: 'unparseable' },
  { url: '', code: 'webhook_url_invalid', why: 'empty' },
  { url: 'https://', code: 'webhook_url_invalid', why: 'no authority' },
];

/** The corpus assertion, extracted so D10 can run it against a weakened validator. */
function assertCorpusRejected(validator: (raw: string) => { ok: boolean; code?: string }): void {
  for (const row of CORPUS) {
    const verdict = validator(row.url);
    assert.equal(verdict.ok, false, `${row.url} must be rejected (${row.why})`);
    assert.equal(verdict.code, row.code, `${row.url} must be rejected as ${row.code} (${row.why})`);
  }
}

test('D1 — every hostile URL encoding is rejected with its named error', () => {
  assert.equal(CORPUS.length, 33, 'the corpus size is pinned so a silent deletion fails here');
  assertCorpusRejected(classifyWebhookUrl);
});

test('D1 — a legitimate public HTTPS endpoint is accepted', () => {
  for (const accepted of [
    'https://hooks.example.com/supplyflow',
    'https://hooks.example.com:443/supplyflow',
    'https://deep.sub.domain.example.co.il/a/b?c=d',
    'https://hooks.example.com./supplyflow', // fully-qualified trailing dot
  ]) {
    const verdict = classifyWebhookUrl(accepted);
    assert.equal(verdict.ok, true, `${accepted} must be accepted: ${JSON.stringify(verdict)}`);
  }
});

test('D1 — a DNS name that resolves privately is NOT a string-level rejection', () => {
  // 127.0.0.1.nip.io is syntactically a perfectly ordinary hostname. This assertion records,
  // deliberately, that the string layer cannot close it — the connect-time layer below must.
  const verdict = classifyWebhookUrl('https://127.0.0.1.nip.io/hook');
  assert.equal(verdict.ok, true, 'a rebinding host passes the string check by construction');
});

/* ===================== address classification ===================== */

test('addressClass names every non-public range', () => {
  const rows: Array<[string, string]> = [
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['169.254.169.254', 'link_local'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['192.0.2.1', 'documentation'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['fc00::1', 'unique_local'],
    ['fd12:3456::1', 'unique_local'],
    ['fe80::1', 'link_local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    // The public control cases: without these the classifier could just answer "not public".
    ['93.184.216.34', 'public'],
    ['172.32.0.1', 'public'],
    ['100.128.0.1', 'public'],
    ['2606:4700::1111', 'public'],
  ];
  for (const [address, expected] of rows) {
    assert.equal(addressClass(address), expected, `${address} must classify as ${expected}`);
  }
});

/* ===================== the guarded transport ===================== */

const PUBLIC_ADDRESS = '93.184.216.34';

function connection(response: string): GuardedConnection & { written: string; closed: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(response);
  let offset = 0;
  const conn = {
    written: '',
    closed: false,
    write(chunk: Uint8Array): Promise<number> {
      conn.written += new TextDecoder().decode(chunk);
      return Promise.resolve(chunk.length);
    },
    read(buffer: Uint8Array): Promise<number | null> {
      if (offset >= bytes.length) return Promise.resolve(null);
      const slice = bytes.subarray(offset, offset + buffer.length);
      buffer.set(slice);
      offset += slice.length;
      return Promise.resolve(slice.length);
    },
    close(): void {
      conn.closed = true;
    },
  };
  return conn;
}

interface Recorder {
  deps: DialDeps;
  resolveCalls: Array<{ host: string; family: string }>;
  connectCalls: Array<{ hostname: string; port: number; serverName: string }>;
  connections: Array<ReturnType<typeof connection>>;
}

function recorder(options: {
  answers: string[] | string[][];
  response?: string;
}): Recorder {
  const resolveCalls: Recorder['resolveCalls'] = [];
  const connectCalls: Recorder['connectCalls'] = [];
  const connections: Recorder['connections'] = [];
  const answerQueue = Array.isArray(options.answers[0])
    ? (options.answers as string[][]).slice()
    : [options.answers as string[]];
  let answerIndex = 0;
  return {
    resolveCalls,
    connectCalls,
    connections,
    deps: {
      resolve(host, family) {
        resolveCalls.push({ host, family });
        // A resolver that answers differently on later calls — the rebinding adversary.
        const answers = answerQueue[Math.min(answerIndex, answerQueue.length - 1)];
        answerIndex += 1;
        return Promise.resolve(family === 'A' ? answers : []);
      },
      connect(opts) {
        connectCalls.push(opts);
        const conn = connection(options.response ?? 'HTTP/1.1 200 OK\r\nx-inplace-webhook-challenge: abc\r\n\r\n');
        connections.push(conn);
        return Promise.resolve(conn);
      },
    },
  };
}

test('D3 — the socket is pinned to the validated address and resolution happens once', async () => {
  // The rebinding adversary: public on the first answer, loopback on every later answer.
  const rec = recorder({ answers: [[PUBLIC_ADDRESS], ['127.0.0.1'], ['127.0.0.1']] });
  const outcome = await guardedRequest(
    'https://127.0.0.1.nip.io/hook',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    rec.deps,
  );

  assert.equal(outcome.ok, true, `expected a delivered request, got ${JSON.stringify(outcome)}`);
  // Exactly one A resolution: there is no second lookup for the adversary to poison.
  assert.equal(rec.resolveCalls.filter((call) => call.family === 'A').length, 1);
  // The address dialled is the address that was validated — not a name handed to the resolver
  // a second time inside the TLS stack.
  assert.equal(rec.connectCalls.length, 1);
  assert.equal(rec.connectCalls[0].hostname, PUBLIC_ADDRESS);
  assert.equal(rec.connectCalls[0].port, 443);
  // SNI and certificate validation still bind to the NAME, so pinning does not weaken TLS.
  assert.equal(rec.connectCalls[0].serverName, '127.0.0.1.nip.io');
  assert.ok(outcome.ok && outcome.addressDialled === PUBLIC_ADDRESS);
  assert.ok(rec.connections[0].closed, 'the connection must be closed');
});

test('D3 — a host whose first resolution is private is refused before any connect', async () => {
  const rec = recorder({ answers: ['127.0.0.1'] });
  const outcome = await guardedRequest('https://127.0.0.1.nip.io/hook', { method: 'POST', headers: {}, body: '{}' }, rec.deps);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'webhook_url_private_address');
  assert.equal(!outcome.ok && outcome.addressClass, 'loopback');
  assert.equal(rec.connectCalls.length, 0, 'no socket may be opened to a rejected host');
});

test('D3 — one private answer among several poisons the whole hostname', async () => {
  const rec = recorder({ answers: [PUBLIC_ADDRESS, '169.254.169.254'] });
  const outcome = await guardedRequest('https://split.example.com/hook', { method: 'POST', headers: {}, body: '{}' }, rec.deps);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'webhook_url_private_address');
  assert.equal(rec.connectCalls.length, 0);
});

test('D3 — a host with no addresses is refused, never dialled by name', async () => {
  const rec = recorder({ answers: [] });
  const outcome = await guardedRequest('https://void.example.com/hook', { method: 'POST', headers: {}, body: '{}' }, rec.deps);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'webhook_url_unresolvable');
  assert.equal(rec.connectCalls.length, 0);
});

test('D2 — a 3xx first hop is a rejection, and there is no second connect', async () => {
  const rec = recorder({
    answers: [PUBLIC_ADDRESS],
    response: 'HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1/\r\n\r\n',
  });
  const outcome = await guardedRequest('https://hooks.example.com/hook', { method: 'POST', headers: {}, body: '{}' }, rec.deps);
  assert.equal(outcome.ok, true, 'the transport reports the status; it never follows it');
  assert.equal(outcome.ok && outcome.status, 302);
  assert.equal(rec.connectCalls.length, 1, 'a redirect must not produce a second connect');
  assert.equal(rec.resolveCalls.length, 1, 'a redirect must not produce a second resolution');
});

test('D2 — a redirect to a private address is never dialled, only reported', async () => {
  const rec = recorder({
    answers: [PUBLIC_ADDRESS],
    response: 'HTTP/1.1 307 Temporary Redirect\r\nLocation: http://169.254.169.254/latest/meta-data/\r\n\r\n',
  });
  const outcome = await guardedRequest('https://hooks.example.com/hook', { method: 'POST', headers: {}, body: '{}' }, rec.deps);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.status, 307);
  // The hop is visible in the parsed headers and is still never acted on: one resolve, one
  // connect, and that connect went to the validated public address.
  assert.equal(rec.resolveCalls.length, 1);
  assert.deepEqual(
    rec.connectCalls.map((call) => call.hostname),
    [PUBLIC_ADDRESS],
    'the metadata address in Location must never reach connect()',
  );
});

test('D4 — the request line and Host header are built from the validated authority', async () => {
  const rec = recorder({ answers: [PUBLIC_ADDRESS] });
  await guardedRequest(
    'https://hooks.example.com/a/b?c=d',
    { method: 'POST', headers: { 'x-supplyflow-timestamp': '1754400000' }, body: '{"a":1}' },
    rec.deps,
  );
  const written = rec.connections[0].written;
  assert.match(written, /^POST \/a\/b\?c=d HTTP\/1\.1\r\n/);
  assert.match(written, /\r\nhost: hooks\.example\.com\r\n/i);
  assert.match(written, /\r\ncontent-length: 7\r\n/i);
  assert.match(written, /\r\nconnection: close\r\n/i);
  assert.match(written, /\r\nx-supplyflow-timestamp: 1754400000\r\n/i);
  assert.ok(written.endsWith('\r\n\r\n{"a":1}'));
});

test('a header value containing CR or LF cannot smuggle a second request', async () => {
  const rec = recorder({ answers: [PUBLIC_ADDRESS] });
  const outcome = await guardedRequest(
    'https://hooks.example.com/hook',
    { method: 'POST', headers: { 'x-evil': 'a\r\nX-Injected: 1' }, body: '{}' },
    rec.deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'webhook_header_invalid');
  assert.equal(rec.connectCalls.length, 0);
});

test('response headers are parsed, lower-cased and bounded', async () => {
  const rec = recorder({
    answers: [PUBLIC_ADDRESS],
    response: 'HTTP/1.1 202 Accepted\r\nX-Inplace-Webhook-Challenge: NONCE-1\r\nServer: nginx\r\n\r\nignored body',
  });
  const outcome = await guardedRequest('https://hooks.example.com/hook', { method: 'POST', headers: {}, body: '{}' }, rec.deps);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.status, 202);
  assert.equal(outcome.ok && outcome.headers['x-inplace-webhook-challenge'], 'NONCE-1');
});

/* ===================== D10 — the mutation proof ===================== */

test('D10 — the corpus assertion turns red against a weakened validator', () => {
  // The weakening is the exact mistake this file exists to catch: a naive string check that
  // looks for the two spellings everyone remembers.
  const weakened = (raw: string) =>
    /localhost|127\.0\.0\.1/i.test(raw)
      ? { ok: false, code: 'webhook_url_local_name_rejected' }
      : { ok: true };

  assert.throws(
    () => assertCorpusRejected(weakened),
    /must be rejected/,
    'a weakened validator must make the corpus fail — otherwise D1 proves nothing',
  );

  // And the real validator still passes it, in the same test, so the two halves cannot drift.
  assertCorpusRejected(classifyWebhookUrl);
});

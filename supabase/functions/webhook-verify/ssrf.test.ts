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
//   D5-D9, D11 the download layer -- see its own header further down. They live in this file
//       because they are the same three layers with a body attached, and splitting them would
//       let one file's corpus drift from the other's.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addressClass,
  classifyWebhookUrl,
  guardedDownload,
  guardedRequest,
  sniffMediaType,
  type DialDeps,
  type GuardedConnection,
  type SniffedMediaType,
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

/* ===================== the download layer ===================== */
//
// `guardedDownload` is the first code in the repo that reads a remote body, and it exists
// because `guardedFetch` provably cannot: it answers `new Response(null, ...)`. Reading a body
// adds two risks the probe never carried -- an unbounded stream, and a redirect that hands the
// destination back to the remote side -- so the assertions below are about those two and about
// the third thing a document store must never do, which is believe a Content-Type.
//
//   D5  the allowlist is EXACT: a subdomain of an allowed host is refused, and so is a name
//       that merely ends with it.
//   D6  a redirect is re-validated from scratch at every hop -- allowlist, string layer,
//       address class -- and bounded in count.
//   D7  the cap is a refusal, never a truncation, and an oversized DECLARED length is refused
//       before the body is drained.
//   D8  the media type comes from the bytes. A header that disagrees loses.
//   D9  the declared length must match what arrived; chunked is decoded; a body with neither
//       is refused by name rather than read on trust.
//   D11 mutation proof: relax the allowlist from exact to suffix and D5 must turn red, so a
//       green D5 is evidence rather than decoration.


const PDF_BYTES = new Uint8Array([...ASCII_BYTES('%PDF-1.7'), 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const HTML_BYTES = new Uint8Array(ASCII_BYTES('<!doctype html><html><body>nope</body></html>'));

function ASCII_BYTES(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

/** A raw HTTP/1.1 response as bytes, so a binary body survives the harness intact. */
function rawResponse(head: string, body?: Uint8Array): Uint8Array {
  const headBytes = new TextEncoder().encode(`${head}\r\n\r\n`);
  const bodyBytes = body ?? new Uint8Array(0);
  const out = new Uint8Array(headBytes.length + bodyBytes.length);
  out.set(headBytes, 0);
  out.set(bodyBytes, headBytes.length);
  return out;
}

function fileResponse(mime: string, body: Uint8Array): Uint8Array {
  return rawResponse(`HTTP/1.1 200 OK\r\ncontent-type: ${mime}\r\ncontent-length: ${body.length}`, body);
}

function byteConnection(response: Uint8Array): GuardedConnection & { closed: boolean } {
  let offset = 0;
  const conn = {
    closed: false,
    write(chunk: Uint8Array): Promise<number> {
      return Promise.resolve(chunk.length);
    },
    read(buffer: Uint8Array): Promise<number | null> {
      if (offset >= response.length) return Promise.resolve(null);
      const slice = response.subarray(offset, offset + buffer.length);
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

interface HopRecorder {
  deps: DialDeps;
  connectCalls: Array<{ hostname: string; port: number; serverName: string }>;
  resolveCalls: Array<{ host: string; family: string }>;
  connections: Array<ReturnType<typeof byteConnection>>;
}

/**
 * One queued response per connect, so a redirect chain is expressed as the chain it is. A
 * per-host answer map lets a hop resolve to a different address class than the one before it,
 * which is the whole point of re-validating every hop.
 */
function hops(options: {
  responses: Uint8Array[];
  answers?: Record<string, string[]>;
  defaultAnswer?: string[];
}): HopRecorder {
  const connectCalls: HopRecorder['connectCalls'] = [];
  const resolveCalls: HopRecorder['resolveCalls'] = [];
  const connections: HopRecorder['connections'] = [];
  const queue = options.responses.slice();
  return {
    connectCalls,
    resolveCalls,
    connections,
    deps: {
      resolve(host, family) {
        resolveCalls.push({ host, family });
        if (family !== 'A') return Promise.resolve([]);
        return Promise.resolve(options.answers?.[host] ?? options.defaultAnswer ?? [PUBLIC_ADDRESS]);
      },
      connect(opts) {
        connectCalls.push(opts);
        const conn = byteConnection(queue.shift() ?? rawResponse('HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0'));
        connections.push(conn);
        return Promise.resolve(conn);
      },
    },
  };
}

const PDF_ONLY: readonly SniffedMediaType[] = ['application/pdf'];
const MEDIA: readonly SniffedMediaType[] = ['application/pdf', 'image/png', 'image/jpeg'];

/* ---------- D5: the allowlist is exact ---------- */

interface AllowlistCase {
  url: string;
  allowed: string[];
  admitted: boolean;
  why: string;
}

const ALLOWLIST_CORPUS: AllowlistCase[] = [
  { url: 'https://api.twilio.com/Media/1', allowed: ['api.twilio.com'], admitted: true, why: 'the exact registered host' },
  { url: 'https://API.Twilio.COM/Media/1', allowed: ['api.twilio.com'], admitted: true, why: 'the host is compared case-folded, as DNS is' },
  { url: 'https://evil.api.twilio.com/Media/1', allowed: ['api.twilio.com'], admitted: false, why: 'a subdomain the provider may let anyone register is not the provider' },
  { url: 'https://api.twilio.com.attacker-owned.com/Media/1', allowed: ['api.twilio.com'], admitted: false, why: 'the allowed name as a LABEL PREFIX of a hostile one' },
  { url: 'https://notapi.twilio.com/Media/1', allowed: ['api.twilio.com'], admitted: false, why: 'a name that merely ends with the allowed suffix' },
  { url: 'https://media.twiliocdn.com/x', allowed: ['api.twilio.com'], admitted: false, why: 'a real provider host that this call did not authorise' },
];

test('D5 — the download allowlist matches whole hosts, never suffixes', async () => {
  for (const row of ALLOWLIST_CORPUS) {
    const rec = hops({ responses: [fileResponse('application/pdf', PDF_BYTES)] });
    const outcome = await guardedDownload(
      row.url,
      { allowedHosts: row.allowed, maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
      rec.deps,
    );
    if (row.admitted) {
      assert.equal(outcome.ok, true, `${row.url} must be admitted (${row.why}), got ${JSON.stringify(outcome)}`);
    } else {
      assert.equal(outcome.ok, false, `${row.url} must be refused (${row.why})`);
      assert.equal(!outcome.ok && outcome.code, 'download_host_not_allowed', row.why);
      assert.equal(rec.connectCalls.length, 0, `no socket may be opened for ${row.url}`);
      assert.equal(rec.resolveCalls.length, 0, `a refused host is never even resolved: ${row.url}`);
    }
  }
});

test('D11 — the exact-match rule is the ONLY thing keeping the hostile hosts off the socket', async () => {
  // D10's discipline, applied to the allowlist. A corpus that passes for the wrong reason --
  // because the string layer happened to catch the row, say -- is decoration. So each hostile
  // row is run twice: once against the real allowlist, where it must never reach a connect, and
  // once against an allowlist that has been WIDENED to contain that very host, where it must
  // reach one. The second run is the mutation: it turns the refusal off, and if the row still
  // refuses then the row was never testing the allowlist at all.
  //
  // Widening to the literal host is the honest mutation for `endsWith` too -- a suffix check on
  // 'api.twilio.com' admits 'evil.api.twilio.com' and 'notapi.twilio.com', which is exactly the
  // membership the widened list grants.
  const hostile = ALLOWLIST_CORPUS.filter((row) => !row.admitted);
  assert.ok(hostile.length >= 4, 'the corpus must carry the hostile shapes, not just the happy one');

  let mutationsObserved = 0;
  for (const row of hostile) {
    const host = new URL(row.url).hostname.toLowerCase();

    const strict = hops({ responses: [fileResponse('application/pdf', PDF_BYTES)] });
    const refused = await guardedDownload(
      row.url,
      { allowedHosts: row.allowed, maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
      strict.deps,
    );
    assert.equal(refused.ok, false, `${host} must be refused under exact matching`);
    assert.equal(strict.connectCalls.length, 0, `${host} must never reach a socket`);

    const widened = hops({ responses: [fileResponse('application/pdf', PDF_BYTES)] });
    const admitted = await guardedDownload(
      row.url,
      { allowedHosts: [...row.allowed, host], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
      widened.deps,
    );
    if (widened.connectCalls.length > 0) {
      // The mutation took: this row's refusal came from the allowlist and nowhere else.
      assert.equal(admitted.ok, true, `${host} should download once it is on the list`);
      assert.equal(widened.connectCalls[0].serverName, host);
      mutationsObserved += 1;
    } else {
      // The row is refused even when allowlisted, which means an EARLIER layer owns it. That is
      // a stronger guarantee, not a weaker one -- but it must be a deliberate, named one.
      assert.equal(admitted.ok, false, `${host} is refused by an earlier layer, so it must stay refused`);
      assert.match(
        String(!admitted.ok && admitted.code),
        /^webhook_url_/,
        `${host} must be refused by a NAMED string- or address-layer code, not by accident`,
      );
    }
  }
  assert.ok(
    mutationsObserved >= 3,
    'at least three hostile rows must owe their refusal to the allowlist alone, or D5 is testing something else',
  );
});

/* ---------- D6: every redirect hop is re-validated ---------- */

test('D6 — a redirect is followed, and the second hop is a full fresh validation', async () => {
  const rec = hops({
    responses: [
      rawResponse('HTTP/1.1 307 Temporary Redirect\r\nlocation: https://media.twiliocdn.com/a/b\r\ncontent-length: 0'),
      fileResponse('application/octet-stream', PDF_BYTES),
    ],
    answers: { 'api.twilio.com': [PUBLIC_ADDRESS], 'media.twiliocdn.com': ['93.184.216.35'] },
  });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com', 'media.twiliocdn.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.ok(outcome.ok && outcome.redirects === 1);
  // The bytes came from the SECOND host, and the report says so rather than naming the first.
  assert.equal(outcome.ok && outcome.hostDialled, 'media.twiliocdn.com');
  assert.equal(outcome.ok && outcome.addressDialled, '93.184.216.35');
  assert.equal(rec.connectCalls.length, 2);
  assert.equal(rec.connectCalls[1].serverName, 'media.twiliocdn.com');
  // Each hop resolves for itself: there is no cached verdict carried across a redirect.
  assert.equal(rec.resolveCalls.filter((call) => call.family === 'A').length, 2);
  assert.ok(rec.connections.every((conn) => conn.closed), 'every hop socket must be closed');
});

test('D6 — a redirect off the allowlist is refused, and never dialled', async () => {
  const rec = hops({
    responses: [rawResponse('HTTP/1.1 302 Found\r\nlocation: https://attacker-owned.com/steal\r\ncontent-length: 0')],
  });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'download_host_not_allowed');
  assert.equal(rec.connectCalls.length, 1, 'the second hop must never be opened');
});

test('D6 — a redirect to an address literal is refused by the string layer, not followed', async () => {
  const rec = hops({
    responses: [rawResponse('HTTP/1.1 302 Found\r\nlocation: https://169.254.169.254/latest/meta-data/\r\ncontent-length: 0')],
  });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com', '169.254.169.254'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  // Even with the metadata address deliberately ON the allowlist, the string layer refuses it
  // first: an allowlist is not a way to opt back in to an IP literal.
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'download_redirect_invalid');
  assert.equal(rec.connectCalls.length, 1);
});

test('D6 — an allowlisted hop that resolves privately is refused before its connect', async () => {
  const rec = hops({
    responses: [rawResponse('HTTP/1.1 302 Found\r\nlocation: https://media.twiliocdn.com/a\r\ncontent-length: 0')],
    answers: { 'api.twilio.com': [PUBLIC_ADDRESS], 'media.twiliocdn.com': ['169.254.169.254'] },
  });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com', 'media.twiliocdn.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'webhook_url_private_address');
  assert.equal(!outcome.ok && outcome.addressClass, 'link_local');
  assert.equal(rec.connectCalls.length, 1, 'the private hop must not be dialled');
});

test('D6 — a relative Location resolves against the hop that sent it', async () => {
  const rec = hops({
    responses: [
      rawResponse('HTTP/1.1 302 Found\r\nlocation: /redirected/file.pdf\r\ncontent-length: 0'),
      fileResponse('application/pdf', PDF_BYTES),
    ],
  });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(rec.connectCalls.length, 2);
});

test('D6 — a redirect loop stops at the configured hop count', async () => {
  const selfRedirect = rawResponse('HTTP/1.1 302 Found\r\nlocation: https://api.twilio.com/again\r\ncontent-length: 0');
  const rec = hops({ responses: [selfRedirect, selfRedirect, selfRedirect, selfRedirect, selfRedirect] });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY, maxRedirects: 2 },
    rec.deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'download_redirect_limit');
  // maxRedirects: 2 means the original plus two hops -- three connects, not four.
  assert.equal(rec.connectCalls.length, 3);
});

test('D6 — a 3xx with no Location is a refusal, not a silent success', async () => {
  const rec = hops({ responses: [rawResponse('HTTP/1.1 302 Found\r\ncontent-length: 0')] });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'download_redirect_invalid');
});

/* ---------- D7: the cap is a refusal, not a truncation ---------- */

test('D7 — a body of exactly maxBytes is accepted', async () => {
  const body = new Uint8Array(1024);
  body.set(PDF_BYTES, 0);
  const rec = hops({ responses: [fileResponse('application/pdf', body)] });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 1024, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.ok && outcome.bytes.length, 1024);
});

test('D7 — one byte over the cap is refused, and no shorter file is returned', async () => {
  const body = new Uint8Array(1025);
  body.set(PDF_BYTES, 0);
  const rec = hops({ responses: [fileResponse('application/pdf', body)] });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 1024, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, false, 'a file over the cap must not come back truncated');
  assert.equal(!outcome.ok && outcome.code, 'download_length_declared_too_large');
});

test('D7 — an oversized declared length is refused without draining the body', async () => {
  // The head promises 50MB; the connection would happily deliver it. The refusal must come off
  // the DECLARATION, so the transfer is never paid for.
  const rec = hops({
    responses: [rawResponse('HTTP/1.1 200 OK\r\ncontent-type: application/pdf\r\ncontent-length: 52428800', PDF_BYTES)],
  });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 10 * 1024 * 1024, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'download_length_declared_too_large');
});

test('D7 — an undeclared stream that runs past the ceiling is abandoned, not buffered', async () => {
  // No content-length, chunked frames that never terminate: the shape with nothing but our own
  // ceiling between the provider and this process.
  const frames: number[] = [];
  const chunk = new Array(4096).fill(0x41);
  for (let index = 0; index < 40; index += 1) {
    frames.push(...ASCII_BYTES('1000\r\n'), ...chunk, 0x0d, 0x0a);
  }
  const rec = hops({
    responses: [rawResponse('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked', new Uint8Array(frames))],
  });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 32 * 1024, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'download_too_large');
});

/* ---------- D8: the bytes decide the media type ---------- */

test('D8 — a Content-Type that disagrees with the bytes loses', async () => {
  const rec = hops({ responses: [fileResponse('application/pdf', HTML_BYTES)] });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, false, 'HTML labelled as PDF must not be stored as a PDF');
  assert.equal(!outcome.ok && outcome.code, 'download_media_type_unrecognized');
});

test('D8 — a real PDF served as octet-stream is accepted on its bytes', async () => {
  const rec = hops({ responses: [fileResponse('application/octet-stream', PDF_BYTES)] });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.ok && outcome.mediaType, 'application/pdf');
});

test('D8 — a recognised type outside the caller allowlist is refused BY NAME', async () => {
  const rec = hops({ responses: [fileResponse('image/png', PNG_BYTES)] });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'download_media_type_rejected');
  // The caller has to be able to tell the tenant WHAT arrived, not just that something did.
  assert.equal(!outcome.ok && outcome.mediaType, 'image/png');
});

test('D8 — the sniffer reads the signature table, including the container caveats', () => {
  const rows: Array<[Uint8Array, SniffedMediaType | null, string]> = [
    [PDF_BYTES, 'application/pdf', '%PDF-'],
    [PNG_BYTES, 'image/png', 'the eight-byte PNG signature'],
    [new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg', 'JFIF'],
    [new Uint8Array(ASCII_BYTES('GIF89a....')), 'image/gif', 'GIF89a'],
    [new Uint8Array([...ASCII_BYTES('RIFF'), 0, 0, 0, 0, ...ASCII_BYTES('WEBP')]), 'image/webp', 'RIFF....WEBP'],
    [new Uint8Array([0, 0, 0, 0x18, ...ASCII_BYTES('ftypheic')]), 'image/heic', 'ISO-BMFF brand heic'],
    [new Uint8Array([0, 0, 0, 0x18, ...ASCII_BYTES('ftypavif')]), 'image/avif', 'ISO-BMFF brand avif'],
    [new Uint8Array([0, 0, 0, 0x18, ...ASCII_BYTES('ftypmif1')]), 'image/heif', 'ISO-BMFF brand mif1'],
    [new Uint8Array([0x49, 0x49, 0x2a, 0x00]), 'image/tiff', 'little-endian TIFF'],
    // A container signature is answered as the container, never as the member inside it.
    [new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'application/zip', 'xlsx and docx are both this'],
    [new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'application/x-ole-storage', 'legacy xls and doc'],
    [HTML_BYTES, null, 'HTML has no signature we act on'],
    [new Uint8Array(ASCII_BYTES('name,price\\n')), null, 'CSV has no signature at all'],
    [new Uint8Array([0x50, 0x4b]), null, 'a bare PK prefix is too weak to act on'],
    [new Uint8Array(0), null, 'no bytes is not a media type'],
    [new Uint8Array([0, 0, 0, 0x18, ...ASCII_BYTES('ftypqt  ')]), null, 'an ISO-BMFF brand we do not store'],
  ];
  for (const [bytes, expected, why] of rows) {
    assert.equal(sniffMediaType(bytes), expected, `${why} must sniff as ${expected}`);
  }
});

/* ---------- D9: length integrity and transfer encoding ---------- */

test('D9 — a content-length that disagrees with the bytes is refused', async () => {
  const rec = hops({
    responses: [rawResponse('HTTP/1.1 200 OK\r\ncontent-type: application/pdf\r\ncontent-length: 999', PDF_BYTES)],
  });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'download_length_mismatch');
});

test('D9 — a chunked body is decoded and accepted', async () => {
  const frames = new Uint8Array([
    ...ASCII_BYTES(`${PDF_BYTES.length.toString(16)}\r\n`),
    ...PDF_BYTES,
    ...ASCII_BYTES('\r\n0\r\n\r\n'),
  ]);
  const rec = hops({ responses: [rawResponse('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked', frames)] });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.ok && Array.from(outcome.bytes), Array.from(PDF_BYTES));
});

test('D9 — a body with neither a length nor chunking is refused by name', async () => {
  const rec = hops({ responses: [rawResponse('HTTP/1.1 200 OK\r\ncontent-type: application/pdf', PDF_BYTES)] });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    rec.deps,
  );
  assert.equal(outcome.ok, false, 'close-delimited is legal HTTP and is still not read on trust');
  assert.equal(!outcome.ok && outcome.code, 'download_encoding_unsupported');
});

test('D9 — a provider error status is reported with its number, not as a download', async () => {
  const rec = hops({ responses: [rawResponse('HTTP/1.1 404 Not Found\r\ncontent-length: 0')] });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: MEDIA },
    rec.deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'download_status_rejected');
  assert.equal(!outcome.ok && outcome.status, 404);
});

/* ---------- the configuration mistakes that must not read as "allow all" ---------- */

test('an empty allowlist is a refusal, never an open door', async () => {
  const rec = hops({ responses: [fileResponse('application/pdf', PDF_BYTES)] });
  for (const init of [
    { allowedHosts: [], maxBytes: 4096, allowedMediaTypes: PDF_ONLY },
    { allowedHosts: ['api.twilio.com'], maxBytes: 4096, allowedMediaTypes: [] as SniffedMediaType[] },
  ]) {
    const outcome = await guardedDownload('https://api.twilio.com/Media/1', init, rec.deps);
    assert.equal(outcome.ok, false, `${JSON.stringify(init)} must refuse`);
    assert.equal(!outcome.ok && outcome.code, 'download_host_not_allowed');
  }
  assert.equal(rec.connectCalls.length, 0);
});

test('a non-positive or absurd byte cap is refused rather than normalised', async () => {
  const rec = hops({ responses: [fileResponse('application/pdf', PDF_BYTES)] });
  for (const maxBytes of [0, -1, 1.5, 1024 * 1024 * 1024]) {
    const outcome = await guardedDownload(
      'https://api.twilio.com/Media/1',
      { allowedHosts: ['api.twilio.com'], maxBytes, allowedMediaTypes: PDF_ONLY },
      rec.deps,
    );
    assert.equal(outcome.ok, false, `maxBytes=${maxBytes} must refuse`);
    assert.equal(!outcome.ok && outcome.code, 'download_too_large');
  }
  assert.equal(rec.connectCalls.length, 0);
});

test('a header carrying CR, LF or NUL is refused before any socket exists', async () => {
  const rec = hops({ responses: [fileResponse('application/pdf', PDF_BYTES)] });
  const outcome = await guardedDownload(
    'https://api.twilio.com/Media/1',
    {
      allowedHosts: ['api.twilio.com'],
      maxBytes: 4096,
      allowedMediaTypes: PDF_ONLY,
      headers: { authorization: 'Basic abc\r\nx-injected: 1' },
    },
    rec.deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'webhook_header_invalid');
  assert.equal(rec.connectCalls.length, 0);
});

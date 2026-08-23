// webhook-verify/ssrf.ts — the outbound trust boundary for customer-registered webhooks.
//
// #253 lets a tenant owner name any HTTPS endpoint and have the product post to it, from our
// network, repeatedly, and then read a signal about the outcome. That is a server-side request
// forgery primitive handed to the customer by design, so the guard here is not a formality: the
// legitimate, authenticated, paying owner IS the attacker this module defends against.
//
// Three layers, because each one alone is bypassable:
//
//   1. `classifyWebhookUrl` — the STRING layer. https only, no userinfo, port 443 only, and no
//      address literal in any encoding (dotted quad, single decimal, octal, hex, mixed
//      inet_aton, bracketed IPv6, IPv4-mapped IPv6). It also refuses names that are loopback or
//      private by convention. This layer cannot close DNS rebinding and does not pretend to:
//      `127.0.0.1.nip.io` is a syntactically ordinary hostname and passes it.
//
//   2. `addressClass` — the ADDRESS layer. One function, one table of ranges, so a missing range
//      is a missing row rather than a missing branch.
//
//   3. `guardedRequest` — the CONNECT layer, which is the only one that closes the
//      resolve-then-connect race. It resolves exactly ONCE, refuses the whole hostname if ANY
//      answer is non-public, and then dials that VALIDATED ADDRESS directly with the hostname
//      carried only as SNI. There is no second name resolution for a hostile resolver to answer
//      differently, and no code path that acts on a redirect: a 3xx is reported to the caller as
//      a status and nothing more.
//
// Everything is dependency-injected (`DialDeps`) so the corpus, the rebinding race and the
// redirect hop are exercised in ssrf.test.ts without a network.

/* ===================== rejection vocabulary ===================== */

export type UrlRejection =
  | 'webhook_url_invalid'
  | 'webhook_url_scheme_rejected'
  | 'webhook_url_credentials_rejected'
  | 'webhook_url_port_rejected'
  | 'webhook_url_ip_literal_rejected'
  | 'webhook_url_local_name_rejected'
  | 'webhook_url_host_not_dns';

export type TransportRejection =
  | UrlRejection
  | 'webhook_header_invalid'
  | 'webhook_url_unresolvable'
  | 'webhook_url_private_address'
  | 'webhook_connect_failed'
  | 'webhook_response_invalid'
  | 'webhook_response_timeout';

/** Named ranges, so a report can say WHICH boundary was crossed without echoing the address. */
export type AddressClass =
  | 'public'
  | 'loopback'
  | 'unspecified'
  | 'private'
  | 'cgnat'
  | 'link_local'
  | 'multicast'
  | 'reserved'
  | 'unique_local'
  | 'documentation';

/* ===================== 1. the string layer ===================== */

export interface UrlClassification {
  /** Punycode, lower-case, trailing dot removed. */
  host: string;
  port: number;
  /** Path plus query, exactly as it goes on the request line. */
  requestTarget: string;
}

/**
 * inet_aton semantics, deliberately: `0x7f.1`, `0177.0.0.1`, `2130706433` and `0x7f000001` are
 * all 127.0.0.1 to a C resolver, and a validator that only understands dotted quads hands the
 * attacker three spellings of loopback for free.
 */
function parseIpv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^[0-9]+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    values.push(value);
  }
  const last = values[values.length - 1];
  const leading = values.slice(0, -1);
  if (leading.some((value) => value > 0xff)) return null;
  if (last >= 2 ** (8 * (4 - leading.length))) return null;
  let result = last;
  for (let index = 0; index < leading.length; index += 1) {
    result += leading[index] * 2 ** (8 * (3 - index));
  }
  return result >>> 0;
}

/** Returns the 16 bytes of an IPv6 address, including the `::ffff:1.2.3.4` embedded form. */
function parseIpv6(host: string): Uint8Array | null {
  if (!host.includes(':')) return null;
  const [beforeCompression, afterCompression, ...extra] = host.split('::');
  if (extra.length > 0) return null;
  const compressed = host.includes('::');

  const expand = (segment: string): string[] | null => {
    if (segment === '') return [];
    const pieces = segment.split(':');
    const out: string[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece.includes('.')) {
        // Only legal as the final element: the embedded IPv4 form.
        if (index !== pieces.length - 1) return null;
        const embedded = parseIpv4(piece);
        if (embedded === null || !/^\d+\.\d+\.\d+\.\d+$/.test(piece)) return null;
        out.push(((embedded >>> 16) & 0xffff).toString(16));
        out.push((embedded & 0xffff).toString(16));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(piece);
    }
    return out;
  };

  const head = expand(beforeCompression ?? '');
  const tail = compressed ? expand(afterCompression ?? '') : [];
  if (head === null || tail === null) return null;
  if (!compressed && head.length !== 8) return null;
  if (compressed && head.length + tail.length > 7) return null;

  const groups = compressed
    ? [...head, ...new Array(8 - head.length - tail.length).fill('0'), ...tail]
    : head;
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const value = Number.parseInt(groups[index], 16);
    bytes[index * 2] = (value >> 8) & 0xff;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

const IPV4_RANGES: Array<{ cidr: string; bits: number; label: AddressClass }> = [
  { cidr: '0.0.0.0', bits: 8, label: 'unspecified' },
  { cidr: '10.0.0.0', bits: 8, label: 'private' },
  { cidr: '100.64.0.0', bits: 10, label: 'cgnat' },
  { cidr: '127.0.0.0', bits: 8, label: 'loopback' },
  { cidr: '169.254.0.0', bits: 16, label: 'link_local' },
  { cidr: '172.16.0.0', bits: 12, label: 'private' },
  { cidr: '192.0.0.0', bits: 24, label: 'reserved' },
  { cidr: '192.0.2.0', bits: 24, label: 'documentation' },
  { cidr: '192.168.0.0', bits: 16, label: 'private' },
  { cidr: '198.18.0.0', bits: 15, label: 'reserved' },
  { cidr: '198.51.100.0', bits: 24, label: 'documentation' },
  { cidr: '203.0.113.0', bits: 24, label: 'documentation' },
  { cidr: '224.0.0.0', bits: 4, label: 'multicast' },
  { cidr: '240.0.0.0', bits: 4, label: 'reserved' },
];

function classifyIpv4(value: number): AddressClass {
  for (const range of IPV4_RANGES) {
    const base = parseIpv4(range.cidr);
    if (base === null) continue;
    const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
    if ((value & mask) >>> 0 === (base & mask) >>> 0) return range.label;
  }
  return 'public';
}

function classifyIpv6(bytes: Uint8Array): AddressClass {
  const allZero = bytes.every((byte) => byte === 0);
  if (allZero) return 'unspecified';
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return 'loopback';

  const prefixIsZero = bytes.slice(0, 10).every((byte) => byte === 0);
  // ::ffff:0:0/96 (IPv4-mapped) and 64:ff9b::/96 (NAT64) both carry a v4 address in the tail.
  const mapped = prefixIsZero && bytes[10] === 0xff && bytes[11] === 0xff;
  const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b;
  if (mapped || nat64) {
    const embedded = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
    return classifyIpv4(embedded);
  }
  if (bytes[0] === 0xff) return 'multicast';
  if ((bytes[0] & 0xfe) === 0xfc) return 'unique_local';
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'link_local';
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return 'documentation';
  }
  if (bytes[0] === 0x01 && bytes.slice(1, 8).every((byte) => byte === 0)) return 'reserved';
  return 'public';
}

/** The address layer: `'public'` or the name of the boundary the address crosses. */
export function addressClass(address: string): AddressClass {
  const bare = address.replace(/^\[/, '').replace(/\]$/, '').split('%')[0];
  const ipv4 = parseIpv4(bare);
  if (ipv4 !== null && /^[0-9.]+$/.test(bare)) return classifyIpv4(ipv4);
  const ipv6 = parseIpv6(bare);
  if (ipv6 !== null) return classifyIpv6(ipv6);
  if (ipv4 !== null) return classifyIpv4(ipv4);
  // An unparseable answer is never treated as routable: fail closed.
  return 'reserved';
}

/** Names that are loopback or private by convention rather than by address. */
const LOCAL_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'corp',
  'home',
  'home.arpa',
  'in-addr.arpa',
  'ip6.arpa',
  'arpa',
  'test',
  'invalid',
  'example',
];

const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function classifyWebhookUrl(
  raw: string,
): { ok: true; value: UrlClassification } | { ok: false; code: UrlRejection } {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed.length > 2000) return { ok: false, code: 'webhook_url_invalid' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, code: 'webhook_url_invalid' };
  }

  if (parsed.protocol !== 'https:') return { ok: false, code: 'webhook_url_scheme_rejected' };
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, code: 'webhook_url_credentials_rejected' };
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    return { ok: false, code: 'webhook_url_port_rejected' };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return { ok: false, code: 'webhook_url_invalid' };

  const bare = host.replace(/^\[/, '').replace(/\]$/, '');
  if (bare.includes(':') || parseIpv6(bare) !== null) {
    return { ok: false, code: 'webhook_url_ip_literal_rejected' };
  }
  if (parseIpv4(bare) !== null) return { ok: false, code: 'webhook_url_ip_literal_rejected' };

  if (LOCAL_SUFFIXES.some((suffix) => bare === suffix || bare.endsWith(`.${suffix}`))) {
    return { ok: false, code: 'webhook_url_local_name_rejected' };
  }
  if (!DNS_NAME.test(bare)) return { ok: false, code: 'webhook_url_host_not_dns' };

  return {
    ok: true,
    value: { host: bare, port: 443, requestTarget: `${parsed.pathname}${parsed.search}` },
  };
}

/* ===================== 3. the connect layer ===================== */

export interface GuardedConnection {
  write(chunk: Uint8Array): Promise<number>;
  read(buffer: Uint8Array): Promise<number | null>;
  close(): void;
}

export interface DialDeps {
  /** Answers for ONE record type. Called at most twice per request, never per hop. */
  resolve(host: string, family: 'A' | 'AAAA'): Promise<string[]>;
  /** `hostname` is an ADDRESS, already validated; `serverName` is the name TLS binds to. */
  connect(options: {
    hostname: string;
    port: number;
    serverName: string;
  }): Promise<GuardedConnection>;
}

export interface GuardedRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
}

export type GuardedOutcome =
  | { ok: true; status: number; headers: Record<string, string>; addressDialled: string }
  | { ok: false; code: TransportRejection; addressClass?: AddressClass; addressDialled?: string };

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const MAX_RESPONSE_HEAD_BYTES = 16 * 1024;

function headersAreSafe(headers: Record<string, string>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) return false;
    // A CR or LF in a value is request smuggling; a NUL is a truncation trick.
    if (/[\r\n\0]/.test(value)) return false;
  }
  return true;
}

function parseResponseHead(head: string): { status: number; headers: Record<string, string> } | null {
  const lines = head.split('\r\n');
  const statusLine = lines.shift();
  if (!statusLine) return null;
  const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine);
  if (!match) return null;
  const headers: Record<string, string> = {};
  for (const line of lines) {
    if (line === '') break;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { status: Number.parseInt(match[1], 10), headers };
}

/**
 * One request, to one validated address, over TLS bound to the registered hostname.
 *
 * The properties that matter, in order:
 *   * name resolution happens ONCE, before any socket exists;
 *   * a single non-public answer disqualifies the entire hostname — a mixed answer set is
 *     treated as hostile, not as "pick the good one";
 *   * the address handed to `connect` is re-checked immediately before the dial;
 *   * the dial targets that address, so the TLS stack never performs its own lookup;
 *   * a 3xx is data. This function returns it and stops. Nothing here consumes the hop.
 */
export async function guardedRequest(
  rawUrl: string,
  init: GuardedRequestInit,
  deps: DialDeps,
): Promise<GuardedOutcome> {
  const classified = classifyWebhookUrl(rawUrl);
  if (!classified.ok) return { ok: false, code: classified.code };
  if (!headersAreSafe(init.headers)) return { ok: false, code: 'webhook_header_invalid' };

  const { host, port, requestTarget } = classified.value;

  let answers: string[] = [];
  try {
    answers = await deps.resolve(host, 'A');
    if (answers.length === 0) answers = await deps.resolve(host, 'AAAA');
  } catch {
    return { ok: false, code: 'webhook_url_unresolvable' };
  }
  if (answers.length === 0) return { ok: false, code: 'webhook_url_unresolvable' };

  for (const answer of answers) {
    const verdict = addressClass(answer);
    if (verdict !== 'public') {
      return { ok: false, code: 'webhook_url_private_address', addressClass: verdict };
    }
  }

  const pinned = answers[0];
  // Second gate on the exact value about to be dialled: if the list check above is ever
  // refactored, this one still stands between the caller and the socket.
  const pinnedClass = addressClass(pinned);
  if (pinnedClass !== 'public') {
    return { ok: false, code: 'webhook_url_private_address', addressClass: pinnedClass };
  }

  let connection: GuardedConnection;
  try {
    connection = await deps.connect({ hostname: pinned, port, serverName: host });
  } catch {
    return { ok: false, code: 'webhook_connect_failed', addressDialled: pinned };
  }

  const encoder = new TextEncoder();
  const bodyBytes = encoder.encode(init.body);
  const lines = [
    `${init.method.toUpperCase()} ${requestTarget || '/'} HTTP/1.1`,
    `host: ${host}`,
    ...Object.entries(init.headers).map(([name, value]) => `${name.toLowerCase()}: ${value}`),
    `content-length: ${bodyBytes.length}`,
    'connection: close',
  ];
  const request = new Uint8Array([
    ...encoder.encode(`${lines.join('\r\n')}\r\n\r\n`),
    ...bodyBytes,
  ]);

  let timedOut = false;
  let closed = false;
  const shut = () => {
    if (closed) return;
    closed = true;
    try {
      connection.close();
    } catch {
      // A socket that is already gone needs no further attention.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    shut();
  }, init.timeoutMs ?? 10_000);

  try {
    await connection.write(request);

    const chunks: number[] = [];
    const buffer = new Uint8Array(2048);
    let head: { status: number; headers: Record<string, string> } | null = null;
    while (chunks.length < MAX_RESPONSE_HEAD_BYTES) {
      const read = await connection.read(buffer);
      if (read === null || read === 0) break;
      for (let index = 0; index < read; index += 1) chunks.push(buffer[index]);
      const text = new TextDecoder().decode(new Uint8Array(chunks));
      const boundary = text.indexOf('\r\n\r\n');
      if (boundary >= 0) {
        head = parseResponseHead(text.slice(0, boundary));
        break;
      }
    }
    if (timedOut) return { ok: false, code: 'webhook_response_timeout', addressDialled: pinned };
    if (!head) return { ok: false, code: 'webhook_response_invalid', addressDialled: pinned };
    return { ok: true, status: head.status, headers: head.headers, addressDialled: pinned };
  } catch {
    if (timedOut) return { ok: false, code: 'webhook_response_timeout', addressDialled: pinned };
    return { ok: false, code: 'webhook_connect_failed', addressDialled: pinned };
  } finally {
    clearTimeout(timer);
    shut();
  }
}

/* ===================== the real dialer ===================== */

/**
 * The production `DialDeps`, and the reason the two steps are separate.
 *
 * `Deno.connect` opens plain TCP to the ADDRESS we validated — no name is involved, so the TLS
 * stack performs no lookup of its own and there is no second resolution to poison.
 * `Deno.startTls` then upgrades that exact socket, with `hostname` set to the NAME the owner
 * registered, so SNI and certificate verification still bind to the name. Doing it in one
 * `connectTls` call would force a single value into both roles: pass the address and the
 * certificate check fails (or, worse, is disabled); pass the name and the pinning is lost.
 */
export const denoDialDeps: DialDeps = {
  async resolve(host, family) {
    try {
      return await Deno.resolveDns(host, family);
    } catch {
      return [];
    }
  },
  async connect(options) {
    const tcp = await Deno.connect({
      hostname: options.hostname,
      port: options.port,
      transport: 'tcp',
    });
    let socket: Deno.TlsConn;
    try {
      socket = await Deno.startTls(tcp, { hostname: options.serverName });
    } catch (error) {
      try {
        tcp.close();
      } catch {
        // The upgrade failed with the socket already gone; nothing left to release.
      }
      throw error;
    }
    return {
      write: (chunk) => socket.write(chunk),
      read: (buffer) => socket.read(buffer),
      close: () => socket.close(),
    };
  },
};

/**
 * A `fetch`-shaped adapter over `guardedRequest`, for callers that already speak Response.
 * The body is intentionally absent: no caller of ours reads an endpoint's response body, and
 * not reading it means an endpoint cannot use its body as a channel into our process.
 */
export async function guardedFetch(
  input: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  deps: DialDeps = denoDialDeps,
): Promise<Response> {
  const outcome = await guardedRequest(
    input,
    { method: init.method ?? 'POST', headers: init.headers ?? {}, body: init.body ?? '' },
    deps,
  );
  if (!outcome.ok) throw new Error(outcome.code);
  return new Response(null, { status: outcome.status, headers: outcome.headers });
}

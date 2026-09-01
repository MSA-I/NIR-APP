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
/**
 * Resolve once, refuse the whole hostname on any non-public answer, dial the address that was
 * validated. Shared by `guardedRequest` and `guardedDownload` because both need EXACTLY these
 * properties and a second copy of them is how one of the two quietly loses a range.
 *
 * The caller passes a name that `classifyWebhookUrl` has already accepted; this function does
 * not re-derive it, so it cannot disagree with the string layer about what host it is dialling.
 */
async function openGuardedSocket(
  host: string,
  port: number,
  deps: DialDeps,
): Promise<
  | { ok: true; connection: GuardedConnection; pinned: string }
  | { ok: false; code: TransportRejection; addressClass?: AddressClass; addressDialled?: string }
> {
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

  try {
    return { ok: true, connection: await deps.connect({ hostname: pinned, port, serverName: host }), pinned };
  } catch {
    return { ok: false, code: 'webhook_connect_failed', addressDialled: pinned };
  }
}

export async function guardedRequest(
  rawUrl: string,
  init: GuardedRequestInit,
  deps: DialDeps,
): Promise<GuardedOutcome> {
  const classified = classifyWebhookUrl(rawUrl);
  if (!classified.ok) return { ok: false, code: classified.code };
  if (!headersAreSafe(init.headers)) return { ok: false, code: 'webhook_header_invalid' };

  const { host, port, requestTarget } = classified.value;

  const dialled = await openGuardedSocket(host, port, deps);
  if (!dialled.ok) return dialled;
  const { connection, pinned } = dialled;

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

/* ===================== 4. the download layer ===================== */

// `guardedFetch` above deliberately discards the body, and that is correct for a webhook probe:
// no caller of ours reads an endpoint's response. Inbound intake is the opposite job. A message
// arrives naming a file we have never seen, hosted by the provider, and the file IS the payload.
//
// The temptation is to reach for `guardedFetch`. It cannot do this -- it returns
// `new Response(null, ...)`. "Zero importers" was the tell. So this layer exists, and it is a
// SEPARATE function rather than a flag on the old one, because reading a body is a different
// risk and has to be argued for separately.
//
// What a downloader must survive that a probe need not:
//
//   * an unbounded body. A provider URL that answers with an endless stream is a memory kill
//     with no attacker skill required, so every read path here is capped and the cap is checked
//     BEFORE the bytes are kept, never after.
//   * a redirect. A probe reports a 3xx and stops (D2). A download must follow one, because
//     that is how both providers actually serve media -- and following it is precisely the
//     step that hands the hop's host back to the remote side. Every hop is therefore
//     re-validated from scratch: the string layer, the exact-host allowlist, a fresh single
//     resolution and the address class. There is no "we already checked this host".
//   * a lying Content-Type. The bytes decide. A provider header is a claim by the same party
//     that chose the file, and storing on that claim is how a document store gets an executable.
//
// Nothing here weakens the three layers above; it reuses them per hop.

export type DownloadRejection =
  | TransportRejection
  | 'download_host_not_allowed'
  | 'download_redirect_limit'
  | 'download_redirect_invalid'
  | 'download_status_rejected'
  | 'download_length_declared_too_large'
  | 'download_too_large'
  | 'download_length_mismatch'
  | 'download_encoding_unsupported'
  | 'download_body_invalid'
  | 'download_media_type_unrecognized'
  | 'download_media_type_rejected';

/**
 * What the BYTES say — never what a header claimed.
 *
 * Two entries are deliberately imprecise, and the imprecision is the honest answer rather than
 * a gap: `application/zip` covers every OOXML file (.xlsx, .docx, .pptx) and
 * `application/x-ole-storage` covers every legacy Office file (.xls, .doc), because the first
 * bytes of those formats are a container signature and say nothing about which member sits
 * inside. A caller that needs the distinction must open the container; this function will not
 * guess it, and returning `application/vnd...sheet` from a `PK` prefix would be a lie with a
 * long name.
 */
export type SniffedMediaType =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/tiff'
  | 'image/heic'
  | 'image/heif'
  | 'image/avif'
  | 'application/zip'
  | 'application/x-ole-storage';

/** One row per format, so an unsupported type is a missing row rather than a missing branch. */
interface Signature {
  media: SniffedMediaType;
  /** Byte offset the prefix starts at. */
  offset: number;
  prefix: readonly number[];
  /** A second fixed run that must also match, for container formats that share a prefix. */
  also?: { offset: number; prefix: readonly number[] };
}

const ASCII = (text: string): number[] => Array.from(text, (character) => character.charCodeAt(0));

const SIGNATURES: readonly Signature[] = [
  { media: 'application/pdf', offset: 0, prefix: ASCII('%PDF-') },
  { media: 'image/jpeg', offset: 0, prefix: [0xff, 0xd8, 0xff] },
  { media: 'image/png', offset: 0, prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { media: 'image/gif', offset: 0, prefix: ASCII('GIF87a') },
  { media: 'image/gif', offset: 0, prefix: ASCII('GIF89a') },
  { media: 'image/webp', offset: 0, prefix: ASCII('RIFF'), also: { offset: 8, prefix: ASCII('WEBP') } },
  { media: 'image/tiff', offset: 0, prefix: [0x49, 0x49, 0x2a, 0x00] },
  { media: 'image/tiff', offset: 0, prefix: [0x4d, 0x4d, 0x00, 0x2a] },
  // ISO base media: 'ftyp' at 4, brand at 8. Every brand is spelled out rather than prefix-
  // matched, because 'heif' as a prefix would also swallow brands that are not still images.
  ...(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'] as const).map(
    (brand): Signature => ({
      media: 'image/heic',
      offset: 4,
      prefix: ASCII('ftyp'),
      also: { offset: 8, prefix: ASCII(brand) },
    }),
  ),
  ...(['mif1', 'msf1'] as const).map(
    (brand): Signature => ({
      media: 'image/heif',
      offset: 4,
      prefix: ASCII('ftyp'),
      also: { offset: 8, prefix: ASCII(brand) },
    }),
  ),
  ...(['avif', 'avis'] as const).map(
    (brand): Signature => ({
      media: 'image/avif',
      offset: 4,
      prefix: ASCII('ftyp'),
      also: { offset: 8, prefix: ASCII(brand) },
    }),
  ),
  // 'PK' plus a local-file-header or empty-archive marker; a bare 'PK' is too weak to act on.
  { media: 'application/zip', offset: 0, prefix: [0x50, 0x4b, 0x03, 0x04] },
  { media: 'application/zip', offset: 0, prefix: [0x50, 0x4b, 0x05, 0x06] },
  { media: 'application/x-ole-storage', offset: 0, prefix: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

function matchesAt(bytes: Uint8Array, offset: number, prefix: readonly number[]): boolean {
  if (bytes.length < offset + prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[offset + index] !== prefix[index]) return false;
  }
  return true;
}

/** The bytes, and only the bytes. `null` means "these bytes are not a format we will store". */
export function sniffMediaType(bytes: Uint8Array): SniffedMediaType | null {
  for (const signature of SIGNATURES) {
    if (!matchesAt(bytes, signature.offset, signature.prefix)) continue;
    if (signature.also && !matchesAt(bytes, signature.also.offset, signature.also.prefix)) continue;
    return signature.media;
  }
  return null;
}

export interface GuardedDownloadInit {
  /**
   * EXACT hostnames, lower-case. Not suffixes: `allowedHosts: ['twiliocdn.com']` must not admit
   * `evil-twiliocdn.com` NOR `anything.twiliocdn.com`, because a provider that lets a customer
   * choose a subdomain would otherwise choose our destination for us. Every hop is checked
   * against this same list, so a redirect cannot walk off it.
   */
  allowedHosts: readonly string[];
  /** Hard ceiling on the BODY. Reached mid-stream, the download is abandoned, not truncated. */
  maxBytes: number;
  /** Byte-level types the caller will accept. A sniffed type outside it is a named refusal. */
  allowedMediaTypes: readonly SniffedMediaType[];
  /** Request headers, e.g. provider authorization. Same CR/LF/NUL rules as `guardedRequest`. */
  headers?: Record<string, string>;
  /** Hops to follow. Default 3. Zero means a 3xx is itself the refusal. */
  maxRedirects?: number;
  /** A budget for the WHOLE download including every hop, not per hop. Default 20s. */
  timeoutMs?: number;
}

export type GuardedDownloadOutcome =
  | {
      ok: true;
      bytes: Uint8Array;
      mediaType: SniffedMediaType;
      /** The host the bytes actually came from — the last hop, which is often not the first. */
      hostDialled: string;
      addressDialled: string;
      redirects: number;
    }
  | {
      ok: false;
      code: DownloadRejection;
      addressClass?: AddressClass;
      addressDialled?: string;
      /** Carried for a refusal the caller must be able to explain, e.g. a 404 from a provider. */
      status?: number;
      /** What the bytes turned out to be, when they were readable but unwanted. */
      mediaType?: SniffedMediaType;
    };

const MAX_ABSOLUTE_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const CRLF_CRLF = [0x0d, 0x0a, 0x0d, 0x0a];

function findSequence(haystack: Uint8Array, needle: readonly number[], from = 0): number {
  outer: for (let index = from; index + needle.length <= haystack.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

/**
 * Everything read from the socket, in one growable buffer with ONE ceiling.
 *
 * The ceiling covers head and body together, so a response that never sends `\r\n\r\n` cannot
 * buy unbounded memory by simply never finishing its headers -- the case a body-only cap misses.
 */
class BoundedReader {
  private buffer = new Uint8Array(0);
  private exhausted = false;

  constructor(private readonly connection: GuardedConnection, private readonly ceiling: number) {}

  get bytes(): Uint8Array {
    return this.buffer;
  }

  get done(): boolean {
    return this.exhausted;
  }

  /** `false` means the ceiling was hit; the caller decides which refusal that is. */
  async pull(): Promise<boolean> {
    if (this.exhausted) return true;
    const scratch = new Uint8Array(16 * 1024);
    const read = await this.connection.read(scratch);
    if (read === null || read === 0) {
      this.exhausted = true;
      return true;
    }
    if (this.buffer.length + read > this.ceiling) return false;
    const grown = new Uint8Array(this.buffer.length + read);
    grown.set(this.buffer, 0);
    grown.set(scratch.subarray(0, read), this.buffer.length);
    this.buffer = grown;
    return true;
  }
}

/** Chunked decoding, with the same ceiling applied to the DECODED size, not the wire size. */
function decodeChunked(
  body: Uint8Array,
  maxBytes: number,
): { ok: true; bytes: Uint8Array } | { ok: false; code: 'download_too_large' | 'download_body_invalid' } {
  const out: Uint8Array[] = [];
  let total = 0;
  let cursor = 0;
  for (;;) {
    const lineEnd = findSequence(body, [0x0d, 0x0a], cursor);
    if (lineEnd < 0) return { ok: false, code: 'download_body_invalid' };
    // A chunk-extension after ';' is legal and carries no length information.
    const header = new TextDecoder().decode(body.subarray(cursor, lineEnd)).split(';')[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(header)) return { ok: false, code: 'download_body_invalid' };
    const size = Number.parseInt(header, 16);
    if (!Number.isFinite(size)) return { ok: false, code: 'download_body_invalid' };
    cursor = lineEnd + 2;
    if (size === 0) break;
    if (total + size > maxBytes) return { ok: false, code: 'download_too_large' };
    if (cursor + size > body.length) return { ok: false, code: 'download_body_invalid' };
    out.push(body.subarray(cursor, cursor + size));
    total += size;
    cursor += size;
    if (body[cursor] !== 0x0d || body[cursor + 1] !== 0x0a) {
      return { ok: false, code: 'download_body_invalid' };
    }
    cursor += 2;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const piece of out) {
    joined.set(piece, at);
    at += piece.length;
  }
  return { ok: true, bytes: joined };
}

/**
 * Fetch one file from a provider, over the same three layers `guardedRequest` uses, with a body.
 *
 * The order is the point:
 *   1. the string layer and the exact-host allowlist, BEFORE any resolution;
 *   2. one resolution, whole-hostname refusal on any non-public answer, dial the pinned address;
 *   3. the response head, under a ceiling that covers the head itself;
 *   4. a 3xx re-enters step 1 as a brand-new URL -- it is never trusted for being a redirect;
 *   5. the body, capped, with the declared length checked against what actually arrived;
 *   6. the media type FROM THE BYTES, checked against what the caller said it would store.
 *
 * A failure at any step returns a named code and no bytes. There is no partial success: a file
 * that hit the ceiling is not a shorter file, it is a refusal.
 */
export async function guardedDownload(
  rawUrl: string,
  init: GuardedDownloadInit,
  deps: DialDeps,
): Promise<GuardedDownloadOutcome> {
  const headers = init.headers ?? {};
  if (!headersAreSafe(headers)) return { ok: false, code: 'webhook_header_invalid' };
  if (!Number.isInteger(init.maxBytes) || init.maxBytes <= 0 || init.maxBytes > MAX_ABSOLUTE_DOWNLOAD_BYTES) {
    return { ok: false, code: 'download_too_large' };
  }
  if (init.allowedHosts.length === 0 || init.allowedMediaTypes.length === 0) {
    // An empty allowlist is a configuration mistake that would otherwise read as "allow none"
    // in one place and "allow all" in the next refactor. Refuse it out loud instead.
    return { ok: false, code: 'download_host_not_allowed' };
  }

  const allowed = new Set(init.allowedHosts.map((host) => host.toLowerCase()));
  const maxRedirects = init.maxRedirects ?? 3;
  const deadline = Date.now() + (init.timeoutMs ?? 20_000);

  let url = rawUrl;
  for (let hop = 0; ; hop += 1) {
    const classified = classifyWebhookUrl(url);
    if (!classified.ok) {
      return { ok: false, code: hop === 0 ? classified.code : 'download_redirect_invalid' };
    }
    const { host, port, requestTarget } = classified.value;
    if (!allowed.has(host)) return { ok: false, code: 'download_host_not_allowed' };

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, code: 'webhook_response_timeout' };

    const dialled = await openGuardedSocket(host, port, deps);
    if (!dialled.ok) return dialled;
    const { connection, pinned } = dialled;

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
    }, remaining);

    let head: { status: number; headers: Record<string, string> } | null = null;
    let body: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let overflowed = false;
    try {
      const encoder = new TextEncoder();
      const lines = [
        `GET ${requestTarget || '/'} HTTP/1.1`,
        `host: ${host}`,
        ...Object.entries(headers).map(([name, value]) => `${name.toLowerCase()}: ${value}`),
        'accept-encoding: identity',
        'connection: close',
      ];
      await connection.write(encoder.encode(`${lines.join('\r\n')}\r\n\r\n`));

      // The ceiling covers head AND body: `maxBytes` of payload plus the head allowance, and
      // one extra byte so a body of exactly `maxBytes` is accepted while `maxBytes + 1` is not.
      const reader = new BoundedReader(connection, MAX_RESPONSE_HEAD_BYTES + init.maxBytes + 1);
      let boundary = -1;
      while (boundary < 0) {
        if (!(await reader.pull())) {
          overflowed = true;
          break;
        }
        boundary = findSequence(reader.bytes, CRLF_CRLF);
        if (boundary < 0 && reader.done) break;
        if (boundary < 0 && reader.bytes.length > MAX_RESPONSE_HEAD_BYTES) {
          return { ok: false, code: 'webhook_response_invalid', addressDialled: pinned };
        }
      }
      if (timedOut) return { ok: false, code: 'webhook_response_timeout', addressDialled: pinned };
      if (overflowed) return { ok: false, code: 'download_too_large', addressDialled: pinned };
      if (boundary < 0) return { ok: false, code: 'webhook_response_invalid', addressDialled: pinned };

      head = parseResponseHead(new TextDecoder().decode(reader.bytes.subarray(0, boundary)));
      if (!head) return { ok: false, code: 'webhook_response_invalid', addressDialled: pinned };

      if (head.status >= 300 && head.status < 400) {
        // Handled after the socket is shut, so a hop can never be opened while the previous
        // one is still held.
        body = new Uint8Array(0);
      } else if (head.status !== 200) {
        return { ok: false, code: 'download_status_rejected', status: head.status, addressDialled: pinned };
      } else {
        // Refused on the DECLARATION, before the body is drained: a provider that says it will
        // send more than we accept is answered without paying for the transfer.
        const promised = head.headers['content-length'];
        if (promised !== undefined && /^[0-9]+$/.test(promised) && Number.parseInt(promised, 10) > init.maxBytes) {
          return { ok: false, code: 'download_length_declared_too_large', addressDialled: pinned };
        }
        while (!reader.done) {
          if (!(await reader.pull())) {
            overflowed = true;
            break;
          }
        }
        if (timedOut) return { ok: false, code: 'webhook_response_timeout', addressDialled: pinned };
        if (overflowed) return { ok: false, code: 'download_too_large', addressDialled: pinned };
        body = reader.bytes.subarray(boundary + CRLF_CRLF.length);
      }
    } catch {
      if (timedOut) return { ok: false, code: 'webhook_response_timeout', addressDialled: pinned };
      return { ok: false, code: 'webhook_connect_failed', addressDialled: pinned };
    } finally {
      clearTimeout(timer);
      shut();
    }

    if (head.status >= 300 && head.status < 400) {
      if (hop >= maxRedirects) return { ok: false, code: 'download_redirect_limit', status: head.status };
      const location = head.headers['location'];
      if (!location) return { ok: false, code: 'download_redirect_invalid', status: head.status };
      try {
        // Resolved against the hop we just made, so a relative Location works; the result then
        // goes through the FULL check at the top of the loop, allowlist included.
        url = new URL(location, `https://${host}${requestTarget || '/'}`).toString();
      } catch {
        return { ok: false, code: 'download_redirect_invalid', status: head.status };
      }
      continue;
    }

    const encoding = (head.headers['transfer-encoding'] ?? '').toLowerCase();
    const declared = head.headers['content-length'];
    let payload: Uint8Array;
    if (encoding.split(',').map((part) => part.trim()).includes('chunked')) {
      const decoded = decodeChunked(body, init.maxBytes);
      if (!decoded.ok) return { ok: false, code: decoded.code, addressDialled: pinned };
      payload = decoded.bytes;
    } else if (declared !== undefined) {
      if (!/^\d+$/.test(declared)) return { ok: false, code: 'download_body_invalid', addressDialled: pinned };
      const length = Number.parseInt(declared, 10);
      if (length > init.maxBytes) {
        return { ok: false, code: 'download_length_declared_too_large', addressDialled: pinned };
      }
      if (body.length !== length) {
        return { ok: false, code: 'download_length_mismatch', addressDialled: pinned };
      }
      payload = body;
    } else {
      // Close-delimited. Legal HTTP, and exactly the shape where nothing bounds the transfer
      // but our own ceiling. Both providers we speak to declare a length; a response that does
      // not is refused by name rather than read on trust.
      return { ok: false, code: 'download_encoding_unsupported', addressDialled: pinned };
    }

    if (payload.length > init.maxBytes) {
      return { ok: false, code: 'download_too_large', addressDialled: pinned };
    }

    const mediaType = sniffMediaType(payload);
    if (mediaType === null) {
      return { ok: false, code: 'download_media_type_unrecognized', addressDialled: pinned };
    }
    if (!init.allowedMediaTypes.includes(mediaType)) {
      return { ok: false, code: 'download_media_type_rejected', mediaType, addressDialled: pinned };
    }

    // A fresh copy, so the returned bytes do not keep the whole read buffer alive through a
    // subarray view of it.
    return {
      ok: true,
      bytes: new Uint8Array(payload),
      mediaType,
      hostDialled: host,
      addressDialled: pinned,
      redirects: hop,
    };
  }
}

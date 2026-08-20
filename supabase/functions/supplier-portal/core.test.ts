import {
  clientAddress,
  corsFor,
  mapSubmitError,
  normalizeToken,
  rateLimitFingerprint,
  sha256Hex,
  TOKEN_SHAPE,
  validRateLimitPepper,
} from './core.ts';

function assertEquals<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('token shape accepts only 64 lowercase hex characters', () => {
  assertEquals(TOKEN_SHAPE.test('a'.repeat(64)), true, 'plain hex');
  assertEquals(TOKEN_SHAPE.test('A'.repeat(64)), false, 'uppercase');
  assertEquals(TOKEN_SHAPE.test('a'.repeat(63)), false, 'too short');
  assertEquals(TOKEN_SHAPE.test('a'.repeat(65)), false, 'too long');
  assertEquals(TOKEN_SHAPE.test('g'.repeat(64)), false, 'non-hex');
});

Deno.test('normalizeToken trims, lowercases, and refuses every other shape', () => {
  assertEquals(normalizeToken(`  ${'B'.repeat(64)} `), 'b'.repeat(64), 'trimmed + lowered');
  assertEquals(normalizeToken('b'.repeat(63)), null, 'short');
  assertEquals(normalizeToken(42), null, 'non-string');
  assertEquals(normalizeToken(null), null, 'null');
  assertEquals(normalizeToken({ token: 'x' }), null, 'object');
});

Deno.test('sha256Hex matches the SQL encode(sha256(...), hex) convention', async () => {
  // Known vector: sha256("abc")
  assertEquals(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'sha256 of "abc"',
  );
});

Deno.test('corsFor echoes only allowlisted origins and never a blanket *', () => {
  const allowed = 'https://app.example.co.il, http://localhost:5199';
  assertEquals(
    corsFor('https://app.example.co.il', allowed)['Access-Control-Allow-Origin'],
    'https://app.example.co.il', 'allowlisted origin echoed');
  assertEquals(
    corsFor('https://evil.example.com', allowed)['Access-Control-Allow-Origin'],
    'https://app.example.co.il', 'foreign origin answered with the first allowed one');
  assertEquals(
    corsFor(null, allowed)['Access-Control-Allow-Origin'],
    'https://app.example.co.il', 'no origin header');
  assertEquals(corsFor('https://x.dev', undefined)['Access-Control-Allow-Origin'], '', 'no allowlist');
});

Deno.test('clientAddress trusts the closest gateway hop and refuses non-address text', () => {
  assertEquals(clientAddress(new Headers({ 'cf-connecting-ip': '203.0.113.8' })),
    '203.0.113.8', 'Cloudflare address');
  assertEquals(clientAddress(new Headers({ 'x-forwarded-for': '198.51.100.4, 2001:db8::7' })),
    '2001:db8::7', 'rightmost forwarded hop');
  assertEquals(clientAddress(new Headers({ 'x-real-ip': 'unknown' })), null, 'invalid address');
  assertEquals(clientAddress(new Headers({ 'x-real-ip': 'abc' })), null, 'hex-like text is not an IP');
  assertEquals(clientAddress(new Headers({ 'x-real-ip': '999.1.1.1' })), null, 'invalid IPv4 octet');
  assertEquals(clientAddress(new Headers()), null, 'missing address');
});

Deno.test('rate-limit fingerprint is stable, opaque and requires a production-sized pepper', async () => {
  const pepper = 'p'.repeat(32);
  assertEquals(validRateLimitPepper(pepper), true, '32-character pepper');
  assertEquals(validRateLimitPepper('short'), false, 'short pepper');
  const first = await rateLimitFingerprint('203.0.113.8', pepper);
  const same = await rateLimitFingerprint('203.0.113.8', pepper);
  const other = await rateLimitFingerprint('203.0.113.9', pepper);
  assertEquals(TOKEN_SHAPE.test(first), true, '64-hex HMAC');
  assertEquals(first, same, 'stable fingerprint');
  assertEquals(first === other, false, 'different address differs');
  assertEquals(first.includes('203.0.113.8'), false, 'raw address absent');
});

Deno.test('submit errors map by name; anything unrecognised is an opaque 503', () => {
  assertEquals(mapSubmitError('link_invalid').status, 404, 'invalid');
  assertEquals(mapSubmitError('x link_locked y').status, 429, 'locked');
  assertEquals(mapSubmitError('proposal_already_submitted').status, 409, 'replay');
  assertEquals(mapSubmitError('proposal_invalid').status, 422, 'invalid payload');
  const fallback = mapSubmitError('column "secret" does not exist');
  assertEquals(fallback.status, 503, 'unknown status');
  assertEquals(fallback.error, 'service_unavailable', 'unknown code stays opaque');
  assertEquals(mapSubmitError(undefined).status, 503, 'undefined message');
});

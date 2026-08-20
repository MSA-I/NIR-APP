// supplier-portal/core.ts -- the pure parts of the token door, extracted so they are provable
// without booting Deno.serve (the outbox-worker core.ts precedent). index.ts wires them to the
// two service RPCs and never adds logic of its own.

/** Raw tokens and their hashes share one shape: 64 lowercase hex characters. */
export const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

export function corsFor(origin: string | null, allowedList: string | undefined): Record<string, string> {
  const allowed = (allowedList ?? '')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  const cleaned = origin?.replace(/\/+$/, '') ?? '';
  return {
    'Access-Control-Allow-Origin': allowed.includes(cleaned) ? cleaned : (allowed[0] ?? ''),
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isIpAddress(value: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255);
  }
  if (!value.includes(':') || value.length > 64) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

/**
 * Reads only gateway-populated address headers. For X-Forwarded-For the rightmost value is the
 * hop appended by the closest proxy; the user-controlled left edge is deliberately ignored.
 * The returned address is never stored or logged -- it exists only long enough to HMAC below.
 */
export function clientAddress(headers: Headers): string | null {
  const direct = headers.get('cf-connecting-ip') ?? headers.get('x-real-ip');
  const forwarded = headers.get('x-forwarded-for')?.split(',').at(-1);
  const candidate = (direct ?? forwarded ?? '').trim();
  return isIpAddress(candidate) ? candidate.toLowerCase() : null;
}

export function validRateLimitPepper(value: string | undefined): value is string {
  return typeof value === 'string' && value.length >= 32;
}

/** HMAC keeps the cross-isolate key stable without making a retained row an IP-address oracle. */
export async function rateLimitFingerprint(address: string, pepper: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(address));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface MappedError {
  error: string;
  status: number;
}

/**
 * The SQL raises by name (0167); the portal answers by the same names with generic HTTP codes.
 * Anything unrecognised is a 503 -- never a leak of the underlying failure.
 */
export function mapSubmitError(message: string | undefined): MappedError {
  const value = message ?? '';
  if (value.includes('link_invalid')) return { error: 'link_invalid', status: 404 };
  if (value.includes('link_locked')) return { error: 'rate_limited', status: 429 };
  if (value.includes('proposal_already_submitted')) {
    return { error: 'proposal_already_submitted', status: 409 };
  }
  if (value.includes('proposal_invalid')) return { error: 'proposal_invalid', status: 422 };
  return { error: 'service_unavailable', status: 503 };
}

/** Normalizes and shape-checks a presented token; null means "answer 404 without asking the DB". */
export function normalizeToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return TOKEN_SHAPE.test(value) ? value : null;
}

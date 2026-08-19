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

/**
 * Soft per-isolate rate window: real enforcement is the token's 32 bytes of entropy plus the
 * per-link failed-submission lock in SQL; this only keeps one noisy client from hammering the
 * DB through a single warm isolate.
 */
export class RateWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 1_000,
  ) {}

  overLimit(key: string, now = Date.now()): boolean {
    const kept = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    kept.push(now);
    this.hits.set(key, kept);
    if (this.hits.size > this.maxKeys) this.hits.clear();
    return kept.length > this.limit;
  }
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

import { carriesAuthCallback, readAuthFragment } from './authFragment';
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — see .env.example');
}

/**
 * Correlation ids (INTEGRATION-ARCHITECTURE.md §5, OPEN-DECISIONS #89).
 *
 * Every `/rest/v1` request carries a fresh `x-correlation-id`; the server records it on
 * audit rows through a column DEFAULT (migration 0062) — no RPC signature changes.
 * Auth/storage/functions requests deliberately do NOT get the header: the local Kong
 * gateway echoes any requested header back on preflight, but hosted Edge Functions answer
 * their own OPTIONS from closed Allow-Headers lists, so scoping the wrapper to REST keeps
 * local behaviour identical to hosted behaviour.
 */
let activeCorrelationId: string | null = null;

/** Group every REST request issued inside `fn` under one explicit correlation id. */
export async function withCorrelationId<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = activeCorrelationId;
  activeCorrelationId = id;
  try {
    return await fn();
  } finally {
    activeCorrelationId = previous;
  }
}

const correlatedFetch: typeof fetch = (input, init) => {
  const target =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!target.includes('/rest/v1')) return fetch(input, init);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set('x-correlation-id', activeCorrelationId ?? crypto.randomUUID());
  return fetch(input, { ...init, headers });
};

export const supabase = createClient(url, anonKey, { global: { fetch: correlatedFetch } });

/**
 * The address bar is not a place for tokens — see src/lib/authFragment.ts for the why.
 *
 * auth-js parsed window.location.href synchronously inside createClient above, so scrubbing here
 * changes nothing it holds in memory; replaceState leaves no token-bearing history entry either.
 * Pages that need to know what the link carried read `authCallbackFragment`.
 */
export const authCallbackFragment = readAuthFragment(typeof window === 'undefined' ? '' : window.location.hash);
if (typeof window !== 'undefined' && carriesAuthCallback(authCallbackFragment)) {
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
}

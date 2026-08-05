import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';

/**
 * The wrapper under test lives in the real client module, which throws at load without its
 * env — so the env is stubbed BEFORE the dynamic import, and the import target is the real
 * `src/lib/supabase.ts`, not a re-implementation. The claims are wire-level: which requests
 * carry `x-correlation-id`, and with what value — asserted inside MSW resolvers, exactly
 * where PostgREST would read the header.
 */
vi.stubEnv('VITE_SUPABASE_URL', SUPABASE_URL);
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');

const { supabase, withCorrelationId } = await import('./supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Serve a REST table and collect the x-correlation-id header of each request to it. */
function captureRestHeaders(table: string): (string | null)[] {
  const seen: (string | null)[] = [];
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/${table}`, ({ request }) => {
      seen.push(request.headers.get('x-correlation-id'));
      return HttpResponse.json([]);
    }),
  );
  return seen;
}

describe('supabase client correlation ids', () => {
  it('sends a valid per-request x-correlation-id on a /rest/v1 request', async () => {
    const seen = captureRestHeaders('correlation_probe');
    await supabase.from('correlation_probe').select('id');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(UUID_RE);
  });

  it('mints a different id for each separate request', async () => {
    const seen = captureRestHeaders('correlation_probe');
    await supabase.from('correlation_probe').select('id');
    await supabase.from('correlation_probe').select('id');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(UUID_RE);
    expect(seen[1]).toMatch(UUID_RE);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('groups requests under one explicit id inside withCorrelationId, then restores', async () => {
    const explicit = '7f000000-0000-4000-8000-000000000001';
    const seen = captureRestHeaders('correlation_probe');
    await withCorrelationId(explicit, async () => {
      await supabase.from('correlation_probe').select('id');
      await supabase.from('correlation_probe').select('id');
    });
    await supabase.from('correlation_probe').select('id');
    expect(seen.slice(0, 2)).toEqual([explicit, explicit]);
    expect(seen[2]).toMatch(UUID_RE);
    expect(seen[2]).not.toBe(explicit);
  });

  it('does not attach the header to auth requests', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.post(`${SUPABASE_URL}/auth/v1/token`, ({ request }) => {
        seen.push(request.headers.get('x-correlation-id'));
        return HttpResponse.json(
          { error: 'invalid_grant', error_description: 'correlation spec probe' },
          { status: 400 },
        );
      }),
    );
    const { error } = await supabase.auth.signInWithPassword({
      email: 'correlation-spec@example.test',
      password: 'not-a-real-password',
    });
    expect(error).not.toBeNull();
    expect(seen).toEqual([null]);
  });
});

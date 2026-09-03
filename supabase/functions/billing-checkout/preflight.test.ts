// billing-checkout/preflight.test.ts — the browser's first request, and the door it used to hit.
//
// MEASURED, not supposed. Against production on 03.09.2026 an OPTIONS preflight carrying
// `Origin` and `Access-Control-Request-Method` was answered **401 with no CORS headers**, while
// `send-invite` and `interpret-document` answered 200 with the full set. The Supabase gateway
// was not the cause: `assistant`, `submit-price-list` and `tenant-export` all declare
// `verify_jwt = true` and all answer the preflight 200, so `OPTIONS` does reach the function
// body. The 401 came from this function's own wiring, which read the environment and then
// demanded an `Authorization` header — and a preflight, by definition, carries neither a body
// nor an Authorization header. The browser therefore never sent the POST behind it, so the
// purchase and subscription-management buttons could not call this function at all.
//
// These cases pin the ordering, the headers, and — just as deliberately — the two refusals that
// must NOT have moved: no environment, no caller. Nothing here touches a network, a database or
// Paddle; every case returns before a client is constructed.

import assert from 'node:assert/strict';
import { handler } from './index.ts';
import { CORS_HEADERS, handleCheckout, type CheckoutPorts } from './core.ts';

const ALLOWED = 'https://app.inplace.digital';
const DEV = 'http://localhost:5199';

/** Sets the environment for one case and puts back whatever was there before. */
async function withEnv(
  values: Record<string, string | null>,
  run: () => void | Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Deno.env.get(key));
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

/** Exactly what a browser sends before a cross-origin POST — no Authorization, no body. */
function preflight(origin: string): Request {
  return new Request('https://project.functions.test/billing-checkout', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
    },
  });
}

const CONFIGURED = {
  ALLOWED_ORIGINS: `${ALLOWED}, ${DEV}`,
  APP_BASE_URL: null,
  SUPABASE_URL: 'http://127.0.0.1:55431',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
};

Deno.test('a CORS preflight is answered 200 with the full header set', async () => {
  await withEnv(CONFIGURED, async () => {
    const response = await handler(preflight(ALLOWED));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED);
    assert.equal(response.headers.get('Vary'), 'Origin');
    assert.match(response.headers.get('Access-Control-Allow-Methods') ?? '', /\bPOST\b/);
    assert.match(response.headers.get('Access-Control-Allow-Methods') ?? '', /\bOPTIONS\b/);
    assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /authorization/);
    await response.body?.cancel();
  });
});

Deno.test('the preflight is answered BEFORE the environment and BEFORE the caller check', async () => {
  // The ordering is the whole fix, and each half is provable on its own.
  await withEnv(
    { ...CONFIGURED, SUPABASE_URL: null, SUPABASE_ANON_KEY: null, SUPABASE_SERVICE_ROLE_KEY: null },
    async () => {
      const noEnvironment = await handler(preflight(ALLOWED));
      assert.equal(noEnvironment.status, 200, 'a missing secret must not take the preflight down');
      assert.equal(noEnvironment.headers.get('Access-Control-Allow-Origin'), ALLOWED);
      await noEnvironment.body?.cancel();
    },
  );

  await withEnv(CONFIGURED, async () => {
    // The same request WITH a full environment: still 200, and still without an Authorization
    // header, which is exactly the condition that used to produce the live 401.
    const configured = await handler(preflight(ALLOWED));
    assert.equal(configured.status, 200);
    assert.equal(configured.headers.has('Access-Control-Allow-Origin'), true);
    await configured.body?.cancel();
  });
});

Deno.test('the dev origin is echoed too, and an unlisted origin is never answered "*"', async () => {
  await withEnv(CONFIGURED, async () => {
    const dev = await handler(preflight(DEV));
    assert.equal(dev.headers.get('Access-Control-Allow-Origin'), DEV);
    await dev.body?.cancel();

    // An unlisted caller gets the FIRST allowed origin, which its own browser then refuses.
    // On a purchasing surface a blanket "*" would be an invitation; it must never appear.
    const stranger = await handler(preflight('https://evil.example.com'));
    assert.equal(stranger.headers.get('Access-Control-Allow-Origin'), ALLOWED);
    assert.notEqual(stranger.headers.get('Access-Control-Allow-Origin'), '*');
    await stranger.body?.cancel();
  });
});

// ===== And the behaviour that must NOT have moved =====

Deno.test('a POST with no Authorization header is still refused 401 "unauthenticated"', async () => {
  await withEnv(CONFIGURED, async () => {
    const response = await handler(
      new Request('https://project.functions.test/billing-checkout', {
        method: 'POST',
        headers: { Origin: ALLOWED, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'checkout', plan_key: 'pro', billing_interval: 'monthly' }),
      }),
    );

    // Status and body are byte-identical to before the fix. There is still no anonymous path
    // into this function; only the response now says which origin may read the refusal.
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthenticated' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED);
  });
});

Deno.test('a missing environment is still refused 503 "refused"', async () => {
  await withEnv({ ...CONFIGURED, SUPABASE_SERVICE_ROLE_KEY: null }, async () => {
    const response = await handler(
      new Request('https://project.functions.test/billing-checkout', {
        method: 'POST',
        headers: { Origin: ALLOWED, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'checkout' }),
      }),
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'refused' });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED);
  });
});

Deno.test('the decision in core.ts declares the origin on its answers too', async () => {
  // A preflight fixed in the wiring while core.ts's answers stayed bare would MOVE the failure
  // rather than remove it: the browser would send the POST and then refuse to let the screen
  // read the reply. This case exercises the method door, which returns before any port is used.
  const unusedPorts = {} as CheckoutPorts;
  const refused = await handleCheckout(
    new Request('https://project.functions.test/billing-checkout', { method: 'GET' }),
    unusedPorts,
  );

  assert.equal(refused.status, 405, 'the method door itself is unchanged');
  assert.deepEqual(await refused.json(), { error: 'refused' });
  // Empty at rest; withAllowedOrigin fills it per request at the edge. Declared is what matters:
  // a response with no such header is left untouched by the wrapper (see _shared/cors.ts).
  assert.equal(refused.headers.has('Access-Control-Allow-Origin'), true);
  assert.equal(CORS_HEADERS['Access-Control-Allow-Origin'], '');
  assert.notEqual(CORS_HEADERS['Access-Control-Allow-Origin'], '*');
});

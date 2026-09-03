// webhook-verify/preflight.test.ts — the browser's first request, and the door it used to hit.
//
// MEASURED, not supposed. Against production on 03.09.2026 an OPTIONS preflight carrying
// `Origin` and `Access-Control-Request-Method` was answered **405 with no CORS headers**, while
// `send-invite` and `interpret-document` answered 200 with the full set. The Supabase gateway
// was not the cause: `assistant`, `submit-price-list` and `tenant-export` all declare
// `verify_jwt = true` and all answer the preflight 200, so `OPTIONS` does reach the function
// body. The 405 came from this file's own method check, which ran before anything knew what a
// preflight was — and a refused preflight means the browser never sends the POST at all, so
// webhook verification failed for every owner while the function reported itself healthy.
//
// These cases pin BOTH halves of the fix and, just as deliberately, the half that must not move:
// the preflight is answered first, every answer now declares the allowed origin, and the method
// door and the request validation behave exactly as they did before.

import assert from 'node:assert/strict';
import { handler } from './index.ts';

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
  return new Request('https://project.functions.test/webhook-verify', {
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
    assert.match(
      response.headers.get('Access-Control-Allow-Headers') ?? '',
      /authorization/,
    );
    await response.body?.cancel();
  });
});

Deno.test('the preflight is answered BEFORE the environment is read', async () => {
  // The ordering is the whole fix. With no configuration at all a POST is refused 500
  // ("misconfigured") — the preflight must still be 200, or a deployment with one missing
  // secret would take the browser down with it.
  await withEnv(
    { ...CONFIGURED, SUPABASE_URL: null, SUPABASE_SERVICE_ROLE_KEY: null },
    async () => {
      const response = await handler(preflight(ALLOWED));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED);
      await response.body?.cancel();
    },
  );
});

Deno.test('the dev origin is echoed too, and an unlisted origin is never answered "*"', async () => {
  await withEnv(CONFIGURED, async () => {
    const dev = await handler(preflight(DEV));
    assert.equal(dev.headers.get('Access-Control-Allow-Origin'), DEV);
    await dev.body?.cancel();

    // An unlisted caller gets the FIRST allowed origin, which its own browser then refuses.
    // The one answer that must never appear on a webhook-ownership surface is a blanket "*".
    const stranger = await handler(preflight('https://evil.example.com'));
    assert.equal(stranger.headers.get('Access-Control-Allow-Origin'), ALLOWED);
    assert.notEqual(stranger.headers.get('Access-Control-Allow-Origin'), '*');
    await stranger.body?.cancel();
  });
});

// ===== And the behaviour that must NOT have moved =====

Deno.test('a GET is still refused 405 by name — now with the origin declared', async () => {
  await withEnv(CONFIGURED, async () => {
    const response = await handler(
      new Request('https://project.functions.test/webhook-verify', {
        method: 'GET',
        headers: { Origin: ALLOWED },
      }),
    );

    assert.equal(response.status, 405);
    const body = await response.json();
    assert.equal(body.error.code, 'method_not_allowed');
    // The status and the named code are byte-identical to before the fix; only the header is new.
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED);
  });
});

Deno.test('a malformed body and a non-uuid id are still refused 400 by name', async () => {
  await withEnv(CONFIGURED, async () => {
    const malformed = await handler(
      new Request('https://project.functions.test/webhook-verify', {
        method: 'POST',
        headers: { Origin: ALLOWED, 'Content-Type': 'application/json' },
        body: '{',
      }),
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'invalid_request');

    const notAUuid = await handler(
      new Request('https://project.functions.test/webhook-verify', {
        method: 'POST',
        headers: { Origin: ALLOWED, 'Content-Type': 'application/json' },
        body: JSON.stringify({ verificationId: 'not-a-uuid' }),
      }),
    );
    assert.equal(notAUuid.status, 400);
    assert.equal((await notAUuid.json()).error.code, 'invalid_request');
    assert.equal(notAUuid.headers.get('Access-Control-Allow-Origin'), ALLOWED);
  });
});

Deno.test('a missing environment is still refused 500 by name', async () => {
  await withEnv({ ...CONFIGURED, SUPABASE_SERVICE_ROLE_KEY: null }, async () => {
    const response = await handler(
      new Request('https://project.functions.test/webhook-verify', {
        method: 'POST',
        headers: { Origin: ALLOWED, 'Content-Type': 'application/json' },
        body: JSON.stringify({ verificationId: '9b000000-0000-4000-8000-000000000001' }),
      }),
    );
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, 'misconfigured');
  });
});

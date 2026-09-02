// No assertion library, deliberately -- the convention every test beside this one follows
// (see reply-to.test.ts): a std import would add remote entries to frozen edge lockfiles.
import { allowedOriginFor, withAllowedOrigin } from './cors.ts';

function eq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function request(origin: string | null): Request {
  return new Request('https://project.functions.test/fn', {
    method: 'POST',
    headers: origin === null ? {} : { Origin: origin },
  });
}

async function withEnv(values: Record<string, string | null>, run: () => void | Promise<void>) {
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

Deno.test('an allowlisted origin is echoed back', async () => {
  await withEnv({ ALLOWED_ORIGINS: 'https://app.inplace.digital, http://localhost:5199', APP_BASE_URL: null }, () => {
    eq(allowedOriginFor(request('https://app.inplace.digital')), 'https://app.inplace.digital', 'first entry');
    // The second entry matters: a single-origin shortcut would break local development.
    eq(allowedOriginFor(request('http://localhost:5199')), 'http://localhost:5199', 'second entry');
    // A trailing slash is a configuration accident, not a different origin.
    eq(allowedOriginFor(request('https://app.inplace.digital/')), 'https://app.inplace.digital', 'trailing slash');
  });
});

Deno.test('an unlisted origin never gets itself back, and never gets a wildcard', async () => {
  await withEnv({ ALLOWED_ORIGINS: 'https://app.inplace.digital', APP_BASE_URL: null }, () => {
    eq(allowedOriginFor(request('https://evil.example.com')), 'https://app.inplace.digital', 'unlisted origin');
    eq(allowedOriginFor(request(null)), 'https://app.inplace.digital', 'no origin header');
  });
});

Deno.test('APP_BASE_URL is the fallback, and an empty allowlist denies rather than opens', async () => {
  await withEnv({ ALLOWED_ORIGINS: null, APP_BASE_URL: 'https://app.inplace.digital' }, () => {
    eq(allowedOriginFor(request('https://app.inplace.digital')), 'https://app.inplace.digital', 'fallback');
  });
  await withEnv({ ALLOWED_ORIGINS: null, APP_BASE_URL: null }, () => {
    eq(allowedOriginFor(request('https://app.inplace.digital')), '', 'no allowlist at all');
  });
});

Deno.test('the wrapper fills a declared allow-origin header and adds Vary', async () => {
  await withEnv({ ALLOWED_ORIGINS: 'https://app.inplace.digital', APP_BASE_URL: null }, async () => {
    const handler = withAllowedOrigin(() =>
      new Response('ok', { headers: { 'Access-Control-Allow-Origin': '', 'Content-Type': 'text/plain' } })
    );
    const response = await handler(request('https://app.inplace.digital'));
    eq(response.headers.get('Access-Control-Allow-Origin'), 'https://app.inplace.digital', 'filled');
    eq(response.headers.get('Vary'), 'Origin', 'vary');
    eq(response.headers.get('Content-Type'), 'text/plain', 'other headers survive');
  });
});

Deno.test('a response that declares no allow-origin is left alone', async () => {
  // tenant-export's public download broker depends on this: those replies are browser navigation
  // over a token link, not a cross-origin fetch, and they answer json(..., cors: false) on purpose.
  await withEnv({ ALLOWED_ORIGINS: 'https://app.inplace.digital', APP_BASE_URL: null }, async () => {
    const handler = withAllowedOrigin(() => new Response('ok', { headers: { 'Content-Type': 'text/plain' } }));
    const response = await handler(request('https://app.inplace.digital'));
    eq(response.headers.has('Access-Control-Allow-Origin'), false, 'not added');
    eq(response.headers.has('Vary'), false, 'no vary either');
  });
});

Deno.test('no edge function answers a wildcard origin', async () => {
  // The Strix scan of 02.09.2026 found six functions replying `Access-Control-Allow-Origin: *`.
  // Six were fixed; this is what stops a seventh from being written. A function that genuinely
  // must serve every origin should fail here and be argued for, not appear by copy-paste.
  const offenders: string[] = [];
  for await (const entry of Deno.readDir('supabase/functions')) {
    if (!entry.isDirectory) continue;
    for await (const file of Deno.readDir(`supabase/functions/${entry.name}`)) {
      if (!file.isFile || !file.name.endsWith('.ts') || file.name.includes('.test.')) continue;
      const path = `supabase/functions/${entry.name}/${file.name}`;
      const source = await Deno.readTextFile(path);
      if (/["']Access-Control-Allow-Origin["']\s*:\s*["']\*["']/.test(source)) offenders.push(path);
    }
  }
  eq(offenders.join(', '), '', 'functions still answering a wildcard origin');
});

Deno.test('the six functions that answered a wildcard are wrapped, not merely edited', async () => {
  // Blanking the header without wrapping the handler would ship an empty allow-origin to every
  // caller -- the app included. Both halves are the fix, so both halves are asserted.
  for (
    const fn of [
      'admin-provision',
      'organization-storage-purge',
      'public-signup',
      'render-document',
      'tenant-export',
      'upload-organization-logo',
    ]
  ) {
    const source = await Deno.readTextFile(`supabase/functions/${fn}/index.ts`);
    eq(source.includes('withAllowedOrigin'), true, `${fn} imports the wrapper`);
    eq(/Deno\.serve\(withAllowedOrigin\(/.test(source), true, `${fn} wraps its handler`);
  }
});

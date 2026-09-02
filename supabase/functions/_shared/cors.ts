/**
 * One answer to "which browser origin may read this function's response".
 *
 * Ten functions already carried a private copy of this rule (`send-invite`, `supplier-portal`,
 * `email-sender`, `whatsapp-sender`, `submit-price-list`, `send-feedback`, `assistant`,
 * `interpret-document`, `recover-document-processing`). Six others answered `*` to everyone,
 * which is broader than any of them needs. The copy stops here: this file is the rule, and the
 * six adopt it by wrapping their handler rather than by growing an eleventh copy.
 *
 * `ALLOWED_ORIGINS` is a comma-separated list; `APP_BASE_URL` is the fallback for the common case
 * of exactly one origin. An unlisted caller is answered with the first allowed origin, which its
 * browser will refuse -- the same shape `supplier-portal/core.ts` has always returned, and the
 * reason an empty allowlist yields an empty header rather than a permissive one.
 */
export function allowedOriginFor(req: Request): string {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('APP_BASE_URL') ?? '')
    .split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean);
  const origin = req.headers.get('Origin')?.replace(/\/+$/, '') ?? '';
  return allowed.includes(origin) ? origin : (allowed[0] ?? '');
}

/**
 * Fills in `Access-Control-Allow-Origin` on the way out, for responses that declare one.
 *
 * Wrapping instead of threading is deliberate. These six functions build their CORS headers in a
 * module-level constant and attach them inside a module-level `json()` helper that never sees the
 * request; passing the origin down would have touched a hundred call sites across 3,000 lines to
 * change one header. Here the handler is unchanged and the header is resolved once, at the edge.
 *
 * A response that carries **no** allow-origin header is left exactly as it is. `tenant-export`
 * depends on that: its public download broker answers token links with `json(..., cors: false)`
 * on purpose, because that path is browser navigation and not a cross-origin fetch.
 */
export function withAllowedOrigin(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const response = await handler(req);
    if (response.headers.has('Access-Control-Allow-Origin')) {
      response.headers.set('Access-Control-Allow-Origin', allowedOriginFor(req));
      if (!response.headers.has('Vary')) response.headers.set('Vary', 'Origin');
    }
    return response;
  };
}

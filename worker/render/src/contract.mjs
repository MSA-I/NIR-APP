/**
 * The wire contract between `supabase/functions/render-document` and this service.
 *
 * VERSIONED ON BOTH SIDES, and the number must move on both in the same rollout. The OCR gateway
 * carries the same discipline for the same reason, and the reason is a production incident: on
 * 24.08.2026 the Edge side went to `3`, the worker stayed on `2`, and document processing stopped
 * SILENTLY for five days — the worker reported `Up`, failed every poll on a contract mismatch, and
 * the screen said "waiting in queue". A mismatch here is louder by construction: the service
 * refuses the request with `render_contract_mismatch` and the Edge turns that into a visible
 * failure rather than a document that never arrives.
 */
export const RENDER_CONTRACT_HEADER = 'x-inplace-render-contract-version';
export const RENDER_CONTRACT_VERSION = '1';

/** A4 at 96dpi, minus nothing: the print stylesheet owns the margins through `@page`. */
export const PAGE_FORMAT = 'A4';

export const MAX_RENDER_MS = 60_000;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * Only these path prefixes may be rendered.
 *
 * The Edge names a path and this service opens it in a browser holding a real user session, so an
 * unrestricted path is a request to read any page of the application on the caller's behalf and
 * hand back a picture of it. The allowlist is the whole defence, and it lives on BOTH sides — the
 * Edge refuses first, and this service refuses again without trusting that it did.
 */
export const ALLOWED_PATH_PREFIXES = ['/reports', '/expenses', '/orders/', '/invoices/'];

export function pathIsRenderable(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  // No scheme, no host, no traversal, no fragment: this becomes a URL on a trusted origin.
  if (path.includes('..') || path.includes('//') || path.includes('#')) return false;
  return ALLOWED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * Validate a render request. Returns `{ ok: true, request }` or `{ ok: false, error }` — never
 * throws, so the caller decides the status code.
 */
export function parseRenderRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'render_bad_request' };
  const { path, orientation, watermark, session } = body;
  if (!pathIsRenderable(path)) return { ok: false, error: 'render_path_not_allowed' };
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    return { ok: false, error: 'render_bad_orientation' };
  }
  if (typeof watermark !== 'boolean') return { ok: false, error: 'render_bad_watermark' };
  if (!session || typeof session !== 'object') return { ok: false, error: 'render_missing_session' };
  if (typeof session.storageKey !== 'string' || !session.storageKey.startsWith('sb-')) {
    return { ok: false, error: 'render_bad_session_key' };
  }
  if (typeof session.value !== 'string' || session.value.length === 0) {
    return { ok: false, error: 'render_bad_session_value' };
  }
  return { ok: true, request: { path, orientation, watermark, session } };
}

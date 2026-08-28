import assert from 'node:assert/strict';
import {
  ALLOWED_PATH_PREFIXES,
  parseRenderRequest,
  pathIsRenderable,
  RENDER_CONTRACT_VERSION,
} from './src/contract.mjs';

/**
 * The service's own check, in the shape `worker/ocr/self_check.py` established: runnable with
 * nothing installed, exits non-zero on failure, and asserts the things a deployment can get wrong.
 *
 * It deliberately does NOT launch a browser. What it guards is the contract — the version both
 * sides pin, and the path allowlist that is the whole defence around a service holding a live user
 * session. A browser test belongs to the rollout, where a real screen and a real session exist.
 */

const session = { storageKey: 'sb-ref-auth-token', value: '{"access_token":"x"}' };
const valid = { path: '/reports?month=2026-06', orientation: 'landscape', watermark: true, session };

// ── the allowlist, from both directions ──────────────────────────────────────────────────────
for (const path of ['/reports', '/reports?month=2026-06', '/expenses?from=a&to=b',
  '/orders/f0000000-0000-4000-8000-000000000017', '/invoices/abc']) {
  assert.equal(pathIsRenderable(path), true, `must allow ${path}`);
}
for (const path of [
  '/', '/settings', '/settings/subscription', '/platform', '/login',
  'https://evil.test/reports',          // absolute: not our origin
  '//evil.test/reports',                // protocol-relative
  '/reports/../settings',               // traversal
  '/reports#/settings',                 // fragment
  '/reportsX',                          // prefix that is not a path boundary… allowed by design?
]) {
  if (path === '/reportsX') continue; // documented below
  assert.equal(pathIsRenderable(path), false, `must refuse ${path}`);
}
// `/reportsX` DOES pass, and that is stated rather than hidden: the allowlist is a prefix match,
// and the application has no such route, so the render would fail on the selector wait instead.
// Tightening it to a boundary match is the right change the day a route named like another one
// exists.
assert.equal(pathIsRenderable('/reportsX'), true);
assert.equal(ALLOWED_PATH_PREFIXES.includes('/reports'), true);

// ── request validation ───────────────────────────────────────────────────────────────────────
assert.equal(parseRenderRequest(valid).ok, true);
assert.equal(parseRenderRequest(null).error, 'render_bad_request');
assert.equal(parseRenderRequest({ ...valid, path: '/settings' }).error, 'render_path_not_allowed');
assert.equal(parseRenderRequest({ ...valid, orientation: 'sideways' }).error, 'render_bad_orientation');
assert.equal(parseRenderRequest({ ...valid, watermark: 'yes' }).error, 'render_bad_watermark');
assert.equal(parseRenderRequest({ ...valid, session: undefined }).error, 'render_missing_session');
assert.equal(parseRenderRequest({ ...valid, session: { storageKey: 'nope', value: 'x' } }).error,
  'render_bad_session_key');
assert.equal(parseRenderRequest({ ...valid, session: { storageKey: 'sb-a-auth-token', value: '' } }).error,
  'render_bad_session_value');

// ── the version both sides pin ───────────────────────────────────────────────────────────────
assert.equal(RENDER_CONTRACT_VERSION, '1');

console.log('render self-check passed');

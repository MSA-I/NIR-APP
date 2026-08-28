import assert from "node:assert/strict";
import {
  ALLOWED_PATH_PREFIXES,
  parseRenderRequest,
  pathIsRenderable,
  RENDER_CONTRACT_VERSION,
  safeFileName,
  sessionStorageKey,
  tokenExpiry,
} from "./contract.ts";

/**
 * What this file guards is the boundary, not the picture.
 *
 * The renderer opens a path in a browser holding the caller's own session, so the allowlist is the
 * whole defence — and the same list is enforced again in `worker/render/src/contract.mjs`, because
 * one side must not have to trust the other. The version is asserted because a silent mismatch is
 * how the OCR gateway stopped production for five days while reporting `Up`.
 */

Deno.test("the allowlist admits the four document screens and nothing else", () => {
  for (
    const path of [
      "/reports",
      "/reports?month=2026-06",
      "/expenses?from=2026-06-01&to=2026-07-31",
      "/orders/f0000000-0000-4000-8000-000000000017",
      "/invoices/f4000000-0000-4000-8000-000000000012",
    ]
  ) {
    assert.equal(pathIsRenderable(path), true, `must allow ${path}`);
  }

  for (
    const path of [
      "/",
      "/login",
      "/settings",
      "/settings/subscription",
      "/platform",
      "/documents",
      "https://evil.test/reports",
      "//evil.test/reports",
      "/reports/../settings",
      "/reports#/settings",
      "",
      42,
      null,
    ]
  ) {
    assert.equal(pathIsRenderable(path), false, `must refuse ${JSON.stringify(path)}`);
  }
});

Deno.test("both sides of the contract carry the same four prefixes", () => {
  assert.deepEqual([...ALLOWED_PATH_PREFIXES], [
    "/reports",
    "/expenses",
    "/orders/",
    "/invoices/",
  ]);
});

Deno.test("a request is rejected on its own terms, one reason at a time", () => {
  const good = { path: "/reports", orientation: "landscape", fileName: "דוח.pdf" };
  const parsed = parseRenderRequest(good);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.request.orientation, "landscape");
    assert.equal(parsed.request.fileName, "דוח.pdf");
  }

  assert.equal(parseRenderRequest(null).ok, false);
  assert.equal(parseRenderRequest({ ...good, path: "/settings" }).ok, false);
  assert.equal(parseRenderRequest({ ...good, fileName: "" }).ok, false);
  // Anything that is not `landscape` is portrait rather than an error: orientation is a hint about
  // paper, not a claim about data, and a document is better produced upright than refused.
  const sideways = parseRenderRequest({ ...good, orientation: "sideways" });
  assert.equal(sideways.ok, true);
  if (sideways.ok) assert.equal(sideways.request.orientation, "portrait");
});

Deno.test("a file name keeps Hebrew and loses what a filesystem refuses", () => {
  assert.equal(safeFileName("דוח: יוני/2026"), "דוח יוני2026.pdf");
  assert.equal(safeFileName("invoice-1509.pdf"), "invoice-1509.pdf");
  assert.equal(safeFileName("///"), null);
  assert.equal(safeFileName("a".repeat(200)), null);
  assert.equal(safeFileName(7), null);
});

/**
 * MEASURED against the local stack: a browser signed in to `http://127.0.0.1:55431` held the
 * session under `sb-127-auth-token`. The renderer writes this exact key before the first
 * navigation, so a wrong answer here is a login screen rendered into the customer's PDF.
 */
Deno.test("the session storage key is the one supabase-js actually uses", () => {
  assert.equal(sessionStorageKey("http://127.0.0.1:55431"), "sb-127-auth-token");
  assert.equal(
    sessionStorageKey("https://rkftlbctohswhbbiaqin.supabase.co"),
    "sb-rkftlbctohswhbbiaqin-auth-token",
  );
  assert.equal(sessionStorageKey("not a url"), null);
});

Deno.test("token expiry is read, and an unreadable token is null rather than a guess", () => {
  const payload = btoa(JSON.stringify({ exp: 1799999999 })).replace(/=+$/, "");
  assert.equal(tokenExpiry(`header.${payload}.signature`), 1799999999);
  assert.equal(tokenExpiry("not-a-jwt"), null);
  assert.equal(tokenExpiry(`header.${btoa("{}")}.signature`), null);
});

Deno.test("the contract version is pinned on this side too", () => {
  assert.equal(RENDER_CONTRACT_VERSION, "1");
});

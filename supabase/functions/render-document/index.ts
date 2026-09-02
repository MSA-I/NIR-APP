import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  MAX_PDF_BYTES,
  parseRenderRequest,
  RENDER_CONTRACT_HEADER,
  RENDER_CONTRACT_VERSION,
  RENDER_TIMEOUT_MS,
  sessionStorageKey,
  tokenExpiry,
} from "./contract.ts";
import { withAllowedOrigin } from "../_shared/cors.ts";

/**
 * Produce a document the caller could not have produced for themselves.
 *
 * ─── WHAT THIS FUNCTION IS FOR, IN ONE SENTENCE ──────────────────────────────────────────────
 * The browser-side generator (`src/lib/pdf.ts`) makes a correct file and cannot make an enforced
 * one: it runs on the reader's machine, so the watermark is branding (DEBT §72) and the text is a
 * picture (DEBT §68). Moving the render to a machine the reader cannot reach answers both — the
 * stamp goes on where it cannot be removed, and Chromium's own `page.pdf()` emits real text.
 *
 * ─── WHO DECIDES THE STAMP ───────────────────────────────────────────────────────────────────
 * THIS FUNCTION DOES, by calling `public.my_export_watermark()` as the caller. The client is never
 * asked and is never believed: a request that arrived saying `watermark: false` would be exactly
 * the tampering this whole package exists to make impossible. The client sends a path and a file
 * name; everything that decides what the document looks like is resolved here.
 *
 * ─── THE SESSION HANDED TO THE RENDERER ──────────────────────────────────────────────────────
 * The screen reads the tenant's own rows under RLS, so the renderer needs a session. It is built
 * here from the ACCESS TOKEN ONLY — no refresh token, because this function never sees one — and
 * travels in the request body rather than the URL, so it does not reach the renderer's access log
 * or the browser's history. It expires with the caller's own token and is thrown away with the
 * browser context.
 *
 * That places the render service inside this function's trust boundary for the seconds a render
 * takes. It is stated here, in `worker/render/src/render.mjs`, and in DEBT §72 rather than being
 * discovered later; the mitigations are the shared secret, the path allowlist enforced on both
 * sides, and a context destroyed after every request.
 *
 * ─── AND IT IS ALLOWED TO BE ABSENT ──────────────────────────────────────────────────────────
 * With no service configured this answers `renderer_not_configured` (503) and the client falls
 * back to generating the document itself. That is deliberate: the alternative is a product whose
 * export button breaks in every environment where the VPS is not deployed, and `worker/render` is
 * deployed by hand exactly like `worker/ocr`. The fallback is branded, not enforced, and the
 * difference is recorded in the debt register rather than papered over.
 */

const CORS = {
  // Filled per request by withAllowedOrigin (../_shared/cors.ts): the caller's Origin when it
  // is on ALLOWED_ORIGINS/APP_BASE_URL, and the first allowed origin otherwise. Never "*".
  "Access-Control-Allow-Origin": "",
  Vary: "Origin",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(withAllowedOrigin(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceUrl = Deno.env.get("RENDER_SERVICE_URL");
  const serviceToken = Deno.env.get("RENDER_SERVICE_TOKEN");
  const authorization = req.headers.get("Authorization");

  if (!url || !anonKey) return json({ error: "server_misconfigured" }, 500);
  if (!authorization) return json({ error: "unauthenticated" }, 401);
  // Before any work: an unconfigured renderer is a normal state, not a failure.
  if (!serviceUrl || !serviceToken) return json({ error: "renderer_not_configured" }, 503);

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return json({ error: "unauthenticated" }, 401);

  let parsed;
  try {
    parsed = parseRenderRequest(await req.json());
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  // The one fact the client is not allowed to supply.
  const { data: watermark, error: watermarkError } = await caller.rpc("my_export_watermark");
  if (watermarkError) return json({ error: "entitlement_unavailable" }, 502);

  const accessToken = authorization.replace(/^Bearer\s+/i, "");
  const storageKey = sessionStorageKey(url);
  if (!storageKey) return json({ error: "server_misconfigured" }, 500);
  const expiresAt = tokenExpiry(accessToken);

  const session = {
    storageKey,
    value: JSON.stringify({
      access_token: accessToken,
      token_type: "bearer",
      // No refresh token exists on this side. The render finishes in seconds and the page never
      // needs to renew; a client that tried would simply fail to, and the render would 401 rather
      // than silently produce an empty document — the loud failure is the right one.
      refresh_token: "",
      expires_at: expiresAt,
      expires_in: expiresAt === null ? 3600 : Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
      user: userData.user,
    }),
  };

  let response: Response;
  try {
    response = await fetch(new URL("/render", serviceUrl).href, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serviceToken}`,
        "Content-Type": "application/json",
        [RENDER_CONTRACT_HEADER]: RENDER_CONTRACT_VERSION,
      },
      body: JSON.stringify({
        path: parsed.request.path,
        orientation: parsed.request.orientation,
        // Resolved here, never echoed from the request.
        watermark: watermark === true,
        session,
      }),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });
  } catch {
    return json({ error: "renderer_unreachable" }, 502);
  }

  if (response.status === 409) return json({ error: "renderer_contract_mismatch" }, 502);
  if (!response.ok) return json({ error: "renderer_failed" }, 502);

  const pdf = new Uint8Array(await response.arrayBuffer());
  if (pdf.byteLength === 0 || pdf.byteLength > MAX_PDF_BYTES) {
    return json({ error: "renderer_failed" }, 502);
  }

  return new Response(pdf, {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "application/pdf",
      // `filename*` in UTF-8 because these names are Hebrew.
      "Content-Disposition":
        `attachment; filename*=UTF-8''${encodeURIComponent(parsed.request.fileName)}`,
      "Cache-Control": "no-store",
    },
  });
}));

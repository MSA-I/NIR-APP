/**
 * The wire contract between this function and `worker/render`.
 *
 * THE VERSION EXISTS ON BOTH SIDES AND MUST MOVE ON BOTH IN ONE ROLLOUT. This is the third
 * contract in the product to carry a number, and the number is here because of what happened to
 * the first: on 24.08.2026 the Edge side of the OCR gateway went to `3`, the VPS worker stayed on
 * `2`, and document processing stopped for five days while the worker reported `Up` and the screen
 * said "waiting in queue". The render service refuses a mismatch with `render_contract_mismatch`
 * and this function turns that into a visible error rather than a document that never arrives.
 *
 * `worker/render/src/contract.mjs` is the other half. Grep for both when changing either.
 */
export const RENDER_CONTRACT_HEADER = "x-inplace-render-contract-version";
export const RENDER_CONTRACT_VERSION = "1";

/** A render is one screen; nothing here needs longer than a minute, and nothing may hang. */
export const RENDER_TIMEOUT_MS = 75_000;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * The only paths that may be rendered, enforced HERE as well as in the service.
 *
 * The renderer opens the path in a browser carrying the caller's own session, so an unrestricted
 * path means "hand me a picture of any screen in the application as that user". Both sides check,
 * and neither trusts the other to have done it: this one because it is the authenticated boundary,
 * the service because it is the one holding the browser.
 */
export const ALLOWED_PATH_PREFIXES = [
  "/reports",
  "/expenses",
  "/orders/",
  "/invoices/",
] as const;

export function pathIsRenderable(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  if (path.includes("..") || path.includes("//") || path.includes("#")) return false;
  return ALLOWED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

export type RenderOrientation = "portrait" | "landscape";

export interface RenderRequest {
  path: string;
  orientation: RenderOrientation;
  fileName: string;
}

export type RenderParse =
  | { ok: true; request: RenderRequest }
  | { ok: false; error: string };

/** A file name that a browser will save and a filesystem will accept, and nothing more. */
export function safeFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\\/:*?"<>|\r\n]/g, "").trim();
  if (trimmed.length === 0 || trimmed.length > 120) return null;
  return trimmed.toLowerCase().endsWith(".pdf") ? trimmed : `${trimmed}.pdf`;
}

export function parseRenderRequest(body: unknown): RenderParse {
  if (!body || typeof body !== "object") return { ok: false, error: "bad_request" };
  const raw = body as Record<string, unknown>;
  if (!pathIsRenderable(raw.path)) return { ok: false, error: "path_not_allowed" };
  const orientation = raw.orientation === "landscape" ? "landscape" : "portrait";
  const fileName = safeFileName(raw.fileName);
  if (fileName === null) return { ok: false, error: "bad_file_name" };
  return { ok: true, request: { path: raw.path, orientation, fileName } };
}

/**
 * The localStorage key supabase-js keeps a session under: `sb-<first label of the host>-auth-token`.
 *
 * MEASURED rather than assumed — against the local stack on `http://127.0.0.1:55431` the browser
 * held `sb-127-auth-token`, which is what the first host label gives. The renderer writes this key
 * before the first navigation so the application boots signed in.
 */
export function sessionStorageKey(supabaseUrl: string): string | null {
  try {
    const label = new URL(supabaseUrl).hostname.split(".")[0];
    return label ? `sb-${label}-auth-token` : null;
  } catch {
    return null;
  }
}

/** `exp` out of a JWT the server has already verified. Read, not trusted, and never a decision. */
export function tokenExpiry(accessToken: string): number | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=")),
    );
    return typeof decoded?.exp === "number" ? decoded.exp : null;
  } catch {
    return null;
  }
}

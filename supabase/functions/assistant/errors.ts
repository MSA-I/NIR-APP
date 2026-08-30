// The assistant's error surface. The closed union is canonical in
// src/lib/assistant/errorCodes.ts (re-exported by contracts.ts); this module adds only what a
// server boundary needs on top of it -- an HTTP status per code, an Error subclass, and the
// CORS/JSON plumbing every function in this repo carries.
//
// IT NO LONGER CARRIES A SENTENCE. The wording moved into the `errors` namespace of the two
// dictionaries, under these exact codes, so each failure has one answer PER LANGUAGE. A server
// that shipped one Hebrew sentence in the body would be a second wording of the same failure,
// and it would be the wrong language for half the people who can now read this product. The
// client has always preferred `error.code` over `error.message` (`client.ts:56`), so the body
// carrying only the code is what it already reads.
import type { AssistantErrorCode } from "../../../src/lib/assistant/contracts.ts";

export type AssistantEdgeErrorCode = AssistantErrorCode;

const STATUS: Record<AssistantEdgeErrorCode, number> = {
  assistant_unauthenticated: 401,
  assistant_disabled: 403,
  assistant_not_entitled: 403,
  assistant_limit_reached: 429,
  assistant_limit_unknown: 403,
  assistant_rate_limited: 429,
  assistant_question_too_long: 400,
  assistant_input_restricted: 400,
  assistant_provider_unavailable: 503,
  assistant_provider_timeout: 504,
  assistant_unsupported_answer: 502,
  assistant_tool_failed: 503,
  assistant_history_unavailable: 503,
  assistant_proposal_unavailable: 404,
  assistant_proposal_expired: 409,
  assistant_proposal_state: 409,
  assistant_read_only_organization: 403,
  assistant_invalid_request: 400,
  assistant_persistence_failed: 503,
};

export class AssistantEdgeError extends Error {
  readonly code: AssistantEdgeErrorCode;
  readonly status: number;

  constructor(code: AssistantEdgeErrorCode, status?: number) {
    super(code);
    this.code = code;
    this.status = status ?? STATUS[code];
  }
}

export function corsFor(req: Request): Record<string, string> {
  const allowed =
    (Deno.env.get("ALLOWED_ORIGINS") ?? Deno.env.get("APP_BASE_URL") ?? "")
      .split(",").map((origin) => origin.trim().replace(/\/+$/, "")).filter(
        Boolean,
      );
  const origin = req.headers.get("Origin")?.replace(/\/+$/, "") ?? "";
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin)
      ? origin
      : (allowed[0] ?? ""),
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-correlation-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export function json(
  cors: Record<string, string>,
  body: unknown,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export function fail(
  cors: Record<string, string>,
  error: AssistantEdgeError,
): Response {
  return json(cors, {
    error: { code: error.code },
  }, error.status);
}

// The assistant's error surface. The closed union and its Hebrew text are canonical in
// src/lib/assistant/errorCodes.ts (re-exported by contracts.ts); this module adds only what a
// server boundary needs on top of them -- an HTTP status per code, an Error subclass, and the
// CORS/JSON plumbing every function in this repo carries.
import {
  ASSISTANT_ERROR_MESSAGES,
  type AssistantErrorCode,
} from "../../../src/lib/assistant/contracts.ts";

export type AssistantEdgeErrorCode = AssistantErrorCode;

const STATUS: Record<AssistantEdgeErrorCode, number> = {
  assistant_unauthenticated: 401,
  assistant_disabled: 403,
  assistant_not_entitled: 403,
  assistant_limit_reached: 429,
  assistant_limit_unknown: 403,
  assistant_rate_limited: 429,
  assistant_question_too_long: 400,
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

export function assistantErrorMessage(code: AssistantEdgeErrorCode): string {
  return ASSISTANT_ERROR_MESSAGES[code];
}

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
    error: { code: error.code, message: assistantErrorMessage(error.code) },
  }, error.status);
}

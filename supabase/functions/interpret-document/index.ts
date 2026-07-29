// interpret-document -- server-side Claude interpretation of an existing structured extraction.
// Claude receives no source file reference or media. The only egress is the allowlisted payload
// built in core.ts, and every result remains a review suggestion.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildProviderPayload,
  createAnthropicProvider,
  type ExtractionContract,
  InterpretationError,
  type LearningRuleSummary,
  MODEL_ID,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type SupplierCandidate,
} from "./core.ts";

const PROVIDER = "anthropic";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type EdgeErrorCode =
  | "unauthenticated"
  | "not_authorized"
  | "invalid_request"
  | "job_unknown"
  | "extraction_unknown"
  | "interpretation_in_progress"
  | "invalid_job_state"
  | "unsupported_extraction_contract"
  | "context_unavailable"
  | "provider_payload_too_large"
  | "provider_timeout"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_rejected"
  | "provider_invalid_output"
  | "interpretation_conflict"
  | "persistence_failed"
  | "service_unavailable";

const MESSAGE: Record<EdgeErrorCode, string> = {
  unauthenticated: "נדרשת התחברות מחדש לפני פירוש המסמך.",
  not_authorized: "אין לך הרשאה לפרש את המסמך הזה.",
  invalid_request: "בקשת פירוש המסמך אינה תקינה.",
  job_unknown: "משימת עיבוד המסמך לא נמצאה.",
  extraction_unknown: "תוצאת החילוץ של המסמך לא נמצאה.",
  interpretation_in_progress: "המסמך כבר נמצא בתהליך פירוש.",
  invalid_job_state: "המסמך אינו מוכן לפירוש במצבו הנוכחי.",
  unsupported_extraction_contract: "גרסת חוזה החילוץ אינה נתמכת.",
  context_unavailable: "הקשר הפירוש אינו זמין כרגע. נסה שוב מאוחר יותר.",
  provider_payload_too_large: "תוכן החילוץ גדול מדי לפירוש בטוח.",
  provider_timeout: "שירות הפירוש לא השיב בזמן. נסה שוב מאוחר יותר.",
  provider_rate_limited: "שירות הפירוש עמוס כרגע. נסה שוב מאוחר יותר.",
  provider_unavailable: "שירות הפירוש אינו זמין כרגע. נסה שוב מאוחר יותר.",
  provider_rejected: "שירות הפירוש דחה את הבקשה.",
  provider_invalid_output: "שירות הפירוש החזיר תוצאה שאינה ניתנת לאימות.",
  interpretation_conflict: "נשמר כבר פירוש אחר למשימה הזו.",
  persistence_failed: "שמירת פירוש המסמך נכשלה.",
  service_unavailable: "שירות פירוש המסמכים אינו זמין כרגע.",
};

class EdgeError extends Error {
  readonly code: EdgeErrorCode;
  readonly status: number;

  constructor(code: EdgeErrorCode, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

interface InterpretRequest {
  jobId?: string;
}

interface ProfileRow {
  org_id: string;
  role: string;
  active: boolean;
}

interface JobRow {
  id: string;
  org_id: string;
  document_id: string;
  status: string;
}

interface ExtractionRow {
  id: string;
}

interface BeginContext {
  job_id: string;
  org_id: string;
  document_id: string;
  actor_id: string;
  extraction_id: string;
  extraction_contract_version?: string;
  extraction_payload?: ExtractionContract;
  already_interpreted: boolean;
  interpretation_id?: string;
}

interface SupplierRow {
  id: string;
  name: string;
  status: string;
}

interface RuleRow {
  id: string;
  user_id: string | null;
  document_type: string | null;
  supplier_id: string | null;
  mark_kind: string;
  mark_fingerprint: string | null;
  tag_key: string;
  label: string;
  version: number;
}

function corsFor(req: Request): Record<string, string> {
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
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(
  cors: Record<string, string>,
  body: unknown,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function fail(cors: Record<string, string>, error: EdgeError): Response {
  return json(cors, {
    error: { code: error.code, message: MESSAGE[error.code] },
  }, error.status);
}

function pgError(message: string): EdgeError {
  if (message.includes("document_processing_job_unknown")) {
    return new EdgeError("job_unknown", 404);
  }
  if (message.includes("document_extraction_unknown")) {
    return new EdgeError("extraction_unknown", 404);
  }
  if (message.includes("document_interpretation_in_progress")) {
    return new EdgeError("interpretation_in_progress", 409);
  }
  if (message.includes("document_interpretation_status_invalid")) {
    return new EdgeError("invalid_job_state", 409);
  }
  if (message.includes("document_unknown")) {
    return new EdgeError("invalid_job_state", 409);
  }
  if (message.includes("document_interpretation_conflict")) {
    return new EdgeError("interpretation_conflict", 409);
  }
  if (
    message.includes("not_authorized") || message.includes("org_suspended") ||
    message.includes("document_interpretation_actor_invalid") ||
    message.includes("document_interpretation_actor_mismatch")
  ) {
    return new EdgeError("not_authorized", 403);
  }
  return new EdgeError("service_unavailable", 503);
}

function providerError(error: InterpretationError): EdgeError {
  return new EdgeError(error.code, error.status);
}

async function markFailed(
  admin: SupabaseClient,
  jobId: string,
  extractionId: string,
  actorId: string,
  code: string,
): Promise<void> {
  const failed = await admin.rpc("fail_document_interpretation", {
    p_job_id: jobId,
    p_extraction_id: extractionId,
    p_actor_id: actorId,
    p_error_code: code,
    p_error_message: null,
  });
  if (failed.error) {
    console.error("interpret-document failure persistence failed");
  }
}

async function existingInterpretation(
  admin: SupabaseClient,
  orgId: string,
  jobId: string,
): Promise<string | null> {
  const existing = await admin.from("document_interpretations").select("id")
    .eq("org_id", orgId).eq("job_id", jobId).maybeSingle();
  return existing.error || !existing.data ? null : String(existing.data.id);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return fail(cors, new EdgeError("invalid_request", 400));
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!url || !anonKey || !serviceKey || !anthropicKey) {
    return fail(cors, new EdgeError("service_unavailable", 500));
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return fail(cors, new EdgeError("unauthenticated", 401));
  }

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  const userResult = await caller.auth.getUser();
  if (userResult.error || !userResult.data.user) {
    return fail(cors, new EdgeError("unauthenticated", 401));
  }
  const actorId = userResult.data.user.id;

  let body: InterpretRequest;
  try {
    body = await req.json() as InterpretRequest;
  } catch {
    return fail(cors, new EdgeError("invalid_request", 400));
  }
  const requestKeys = body && typeof body === "object" && !Array.isArray(body)
    ? Object.keys(body)
    : [];
  const jobId = body?.jobId;
  if (
    requestKeys.length !== 1 || requestKeys[0] !== "jobId" ||
    typeof jobId !== "string" || !UUID.test(jobId)
  ) {
    return fail(cors, new EdgeError("invalid_request", 400));
  }

  const profileResult = await admin.from("profiles").select(
    "org_id,role,active",
  )
    .eq("id", actorId).maybeSingle();
  if (profileResult.error) {
    return fail(cors, new EdgeError("service_unavailable", 503));
  }
  const profile = profileResult.data as ProfileRow | null;
  if (
    !profile?.active || !["owner", "office", "kitchen"].includes(profile.role)
  ) {
    return fail(cors, new EdgeError("not_authorized", 403));
  }

  const orgResult = await admin.from("organizations").select("id,status")
    .eq("id", profile.org_id).maybeSingle();
  if (orgResult.error) {
    return fail(cors, new EdgeError("service_unavailable", 503));
  }
  if (
    !orgResult.data ||
    !["trial", "active"].includes(String(orgResult.data.status))
  ) {
    return fail(cors, new EdgeError("not_authorized", 403));
  }

  const jobResult = await admin.from("document_processing_jobs")
    .select("id,org_id,document_id,status").eq("id", jobId)
    .eq("org_id", profile.org_id).maybeSingle();
  if (jobResult.error) {
    return fail(cors, new EdgeError("service_unavailable", 503));
  }
  const job = jobResult.data as JobRow | null;
  if (!job) return fail(cors, new EdgeError("job_unknown", 404));
  if (!["extracted", "interpreting", "review"].includes(job.status)) {
    return fail(cors, new EdgeError("invalid_job_state", 409));
  }

  const extractionResult = await admin.from("document_extractions").select("id")
    .eq("org_id", profile.org_id).eq("job_id", job.id)
    .eq("document_id", job.document_id).maybeSingle();
  if (extractionResult.error) {
    return fail(cors, new EdgeError("service_unavailable", 503));
  }
  const extraction = extractionResult.data as ExtractionRow | null;
  if (!extraction) return fail(cors, new EdgeError("extraction_unknown", 404));

  const beginResult = await admin.rpc("begin_document_interpretation", {
    p_job_id: job.id,
    p_extraction_id: extraction.id,
    p_actor_id: actorId,
  });
  if (beginResult.error) return fail(cors, pgError(beginResult.error.message));
  const context = beginResult.data as BeginContext;
  if (context.already_interpreted && context.interpretation_id) {
    return json(cors, {
      interpretationId: context.interpretation_id,
      jobId: job.id,
      status: "review",
      idempotent: true,
    }, 200);
  }
  if (
    context.org_id !== profile.org_id || context.job_id !== job.id ||
    context.extraction_id !== extraction.id || context.actor_id !== actorId ||
    context.extraction_contract_version !== "1" || !context.extraction_payload
  ) {
    await markFailed(
      admin,
      job.id,
      extraction.id,
      actorId,
      "unsupported_extraction_contract",
    );
    return fail(cors, new EdgeError("unsupported_extraction_contract", 409));
  }

  try {
    const [suppliersResult, rulesResult] = await Promise.all([
      admin.from("suppliers").select("id,name,status").eq(
        "org_id",
        context.org_id,
      )
        .is("deleted_at", null).order("name").limit(101),
      admin.from("document_learning_rules")
        .select(
          "id,user_id,document_type,supplier_id,mark_kind,mark_fingerprint,tag_key,label,version",
        )
        .eq("org_id", context.org_id).eq("active", true)
        .or(`user_id.is.null,user_id.eq.${actorId}`).order("version", {
          ascending: false,
        }).limit(201),
    ]);
    if (suppliersResult.error || rulesResult.error) {
      throw new EdgeError("context_unavailable", 503);
    }

    const suppliers: SupplierCandidate[] =
      ((suppliersResult.data ?? []) as SupplierRow[])
        .map(({ id, name, status }) => ({ id, name, status }));
    const rules: LearningRuleSummary[] = ((rulesResult.data ?? []) as RuleRow[])
      .sort((a, b) => Number(b.user_id !== null) - Number(a.user_id !== null))
      .map((rule) => ({
        id: rule.id,
        scope: rule.user_id === null ? "organization" : "personal",
        version: rule.version,
        document_type: rule.document_type,
        supplier_id: rule.supplier_id,
        mark_kind: rule.mark_kind,
        mark_fingerprint: rule.mark_fingerprint,
        tag_key: rule.tag_key,
        tag_label: rule.label,
      }));
    const providerPayload = buildProviderPayload(
      context.extraction_payload,
      suppliers,
      rules,
    );
    const startedAt = performance.now();
    const result = await createAnthropicProvider({ apiKey: anthropicKey })
      .interpret(providerPayload);
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const saved = await admin.rpc("save_document_interpretation", {
      p_job_id: job.id,
      p_extraction_id: extraction.id,
      p_actor_id: actorId,
      p_provider: PROVIDER,
      p_model: MODEL_ID,
      p_prompt_version: PROMPT_VERSION,
      p_schema_version: SCHEMA_VERSION,
      p_payload: result.interpretation,
      p_usage: {
        ...result.usage,
        provider_request_id: result.provider_request_id,
        input_truncation: providerPayload.truncation,
      },
      p_duration_ms: durationMs,
    });
    if (saved.error || !saved.data) {
      const existingId = await existingInterpretation(
        admin,
        context.org_id,
        job.id,
      );
      if (existingId) {
        return json(cors, {
          interpretationId: existingId,
          jobId: job.id,
          status: "review",
          idempotent: true,
        }, 200);
      }
      if (saved.error?.message.includes("document_interpretation_conflict")) {
        throw new EdgeError("interpretation_conflict", 409);
      }
      throw new EdgeError("persistence_failed", 503);
    }
    return json(cors, {
      interpretationId: String(saved.data),
      jobId: job.id,
      status: "review",
      schemaVersion: SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      model: MODEL_ID,
      idempotent: false,
    }, 200);
  } catch (error) {
    const edgeError = error instanceof InterpretationError
      ? providerError(error)
      : error instanceof EdgeError
      ? error
      : new EdgeError("service_unavailable", 503);
    await markFailed(admin, job.id, extraction.id, actorId, edgeError.code);
    console.error("interpret-document failed", edgeError.code);
    return fail(cors, edgeError);
  }
});

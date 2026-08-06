// interpret-document -- server-side model interpretation of an existing structured extraction.
// The provider receives no source file reference or media. The only egress is the allowlisted
// payload built in core.ts, and every result remains a review suggestion.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildProviderPayload,
  createOpenAiProvider,
  type ExtractionContract,
  InterpretationError,
  type LearningRuleSummary,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type SupplierCandidate,
} from "./core.ts";

const PROVIDER = "openai";
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
  | "provider_output_truncated"
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
  provider_output_truncated: "המסמך מורכב מדי לפירוש בבת אחת. נסה שוב על קטע קטן יותר.",
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
  supplier_id: string | null;
}

interface JobRow {
  id: string;
  org_id: string;
  document_id: string;
  status: string;
  requested_by: string;
  input_checksum: string;
  contract_version: string;
}

interface ExtractionRow {
  id: string;
  org_id: string;
  job_id: string;
  document_id: string;
  input_checksum: string;
  contract_version: string;
}

interface DocumentRow {
  id: string;
  org_id: string;
  entity_type: string;
  entity_id: string | null;
  supplier_id: string | null;
  document_kind: string;
  uploaded_by: string;
  storage_path: string;
  deleted_at: string | null;
}

interface BeginContext {
  job_id: string;
  org_id: string;
  document_id: string;
  actor_id: string;
  interpretation_started_at?: string;
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

export function supplierInterpretationContextAllowed(
  actorId: string,
  profile: ProfileRow,
  document: DocumentRow,
  job: JobRow,
  extraction: ExtractionRow,
): boolean {
  const supplierId = profile.supplier_id;
  return profile.active && profile.role === "supplier" &&
    typeof supplierId === "string" && UUID.test(supplierId) &&
    profile.org_id === document.org_id &&
    document.entity_type === "supplier" &&
    document.entity_id === supplierId &&
    document.supplier_id === supplierId &&
    document.document_kind === "price_list" &&
    document.uploaded_by === actorId && document.deleted_at === null &&
    document.storage_path.startsWith(
      `${profile.org_id}/supplier/${supplierId}/${document.id}/`,
    ) &&
    job.org_id === profile.org_id && job.document_id === document.id &&
    job.requested_by === actorId && job.contract_version === "1" &&
    extraction.org_id === profile.org_id && extraction.job_id === job.id &&
    extraction.document_id === document.id &&
    extraction.contract_version === job.contract_version &&
    extraction.input_checksum === job.input_checksum;
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
      "authorization, x-client-info, apikey, content-type, x-correlation-id",
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
  if (message.includes("document_interpretation_attempt_mismatch")) {
    return new EdgeError("interpretation_in_progress", 409);
  }
  if (message.includes("document_interpretation_status_invalid")) {
    return new EdgeError("invalid_job_state", 409);
  }
  if (message.includes("document_unknown")) {
    return new EdgeError("invalid_job_state", 409);
  }
  if (message.includes("document_source_changed")) {
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
  interpretationStartedAt: string,
  code: string,
  supplierPriceList: boolean,
): Promise<void> {
  const failed = await admin.rpc(
    supplierPriceList
      ? "fail_supplier_price_interpretation"
      : "fail_document_interpretation",
    {
    p_job_id: jobId,
    p_extraction_id: extractionId,
    p_actor_id: actorId,
    p_interpretation_started_at: interpretationStartedAt,
    p_error_code: code,
    p_error_message: null,
    },
  );
  if (failed.error) {
    console.error("interpret-document failure persistence failed");
  }
}

// The narrowest shape these helpers need, rather than SupabaseClient, so a test can hand them a
// client that fails in each of the ways below without constructing a real one.
//
// `data` is declared because the decision RETURNS its verdict -- the outcome, the reason code,
// and the ids of anything it wrote. An interface that admitted only `error` made a call that may
// have just authored an invoice log NOTHING on success, which is the one event in this file most
// worth being able to find afterwards.
export interface RpcResult {
  data?: unknown;
  error: { message: string } | null;
}

// supabase-js carries the abort signal on the builder rather than in an options bag, so the
// shape has to admit `.abortSignal()` instead of a `{ signal }` argument.
export interface RpcBuilder extends PromiseLike<RpcResult> {
  abortSignal(signal: AbortSignal): PromiseLike<RpcResult>;
}

export interface DecisionRpcClient {
  rpc(fn: string, args: Record<string, unknown>): RpcBuilder;
}

export type ApplyDecision = (
  admin: DecisionRpcClient,
  jobId: string,
  interpretationId: string,
  actorId: string,
) => Promise<void>;

// A BOUND ON A CALL THAT NOTHING ELSE BOUNDS. Measured on this database rather than assumed:
// `authenticator` carries statement_timeout=8s AND lock_timeout=8s, `authenticated` 8s, `anon`
// 3s -- and `service_role` carries no rolconfig at all. Neither supabase-js nor Deno's fetch
// supplies a default either, so without this the call is unbounded in the one role that has no
// server-side ceiling. apply_document_interpretation takes `for update` on documents, so a lock
// wait behind another writer has nothing to stop it, and it would hold a 200 for an
// interpretation that is already saved and already paid for.
//
// Eight seconds is not a guess: it is the ceiling the tenant-facing role already runs under, and
// the trusted server should not be less bounded than the tenant it acts for.
const DECISION_TIMEOUT_MS = 8_000;

// ===== Acting on a saved interpretation is a separate decision, and a failed decision =====
// ===== may not cost the interpretation.                                               =====
//
// By the time this runs the interpretation row exists, is immutable, and the tenant has already
// paid for the tokens that produced it. apply_document_interpretation (0077) is the command that
// may turn it into a financial record without a human, and it has many legitimate ways to refuse
// -- a suspended tenant, an unresolved autonomy policy, a document somebody already filed. None
// of those are reasons to lose an interpretation, so this function RESOLVES for every outcome:
// a Postgres error, a transport failure folded into `error`, an abort, or a client that throws.
//
// It reports the way every other non-fatal failure in this file does -- console.error with no
// response change -- because markFailed is the opposite behaviour: markFailed exists to record
// that the interpretation did NOT happen, and calling it here would mark a job failed whose
// interpretation is already stored and already visible to the reviewer.
//
// ORDERING IS THE CONTRACT: this is called only after an interpretation id exists. Reversing the
// two would let a refused decision take the saved interpretation down with it.
export async function applyInterpretationDecision(
  admin: DecisionRpcClient,
  jobId: string,
  interpretationId: string,
  actorId: string,
): Promise<void> {
  try {
    // Signature read from the live catalogue, not from the migration text:
    // apply_document_interpretation(p_job_id uuid, p_interpretation_id uuid,
    // p_actor_id uuid DEFAULT NULL) returns jsonb, security definer, EXECUTE granted to
    // service_role alone -- which is why it is reachable from `admin` and from nothing else.
    const applied = await admin.rpc("apply_document_interpretation", {
      p_job_id: jobId,
      p_interpretation_id: interpretationId,
      p_actor_id: actorId,
    }).abortSignal(AbortSignal.timeout(DECISION_TIMEOUT_MS));
    if (applied.error) {
      // WITH THE IDS, and that is not tidiness. A failed decision leaves nothing in the database
      // -- this line is its only trace -- and a trace that cannot name the document it was about
      // cannot be acted on. The retry below exists to recover exactly this event; an operator
      // reading `apply_document_interpretation failed <postgres message>` with no job and no
      // interpretation has no way to tell WHICH document to re-open. Not a privacy boundary
      // either: the success line already carries invoice_id and auto_action_id.
      console.error(
        "apply_document_interpretation failed",
        jobId,
        interpretationId,
        applied.error.message,
      );
      return;
    }
    // The verdict, and only the verdict: an outcome, a reason code and ids. Never a field value,
    // a supplier name or anything else off the document -- this line goes to a log the tenant
    // does not own. Read as an ALLOWLIST of four named fields rather than by spreading `data`,
    // so 0077's replay branch merging model, prompt_version and both confidences into its return
    // cannot reach this line however that shape grows.
    //
    // With the switch in its shipped state (off for every tenant that exists) the steady-state
    // line is `queued_for_review autonomy_disabled`, which is exactly what makes a line that ever
    // reads `auto_applied` findable.
    const verdict = applied.data && typeof applied.data === "object"
      ? applied.data as Record<string, unknown>
      : {};
    console.log(
      "apply_document_interpretation",
      jobId,
      interpretationId,
      String(verdict.outcome ?? "unknown"),
      String(verdict.reason_code ?? ""),
      String(verdict.invoice_id ?? ""),
      String(verdict.auto_action_id ?? ""),
    );
  } catch (error) {
    console.error(
      "apply_document_interpretation failed",
      jobId,
      interpretationId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

// The supplier gate, in ONE place both call sites share rather than duplicated at each.
//
// The supplier price-list path is deliberately NOT offered to the decision layer. 0077 acts on
// documents still in the manager's inbox, and a supplier price list is entity_type 'supplier'
// before it ever reaches here -- supplierInterpretationContextAllowed demands exactly that -- so
// the call could only return already_decided/document_already_filed. It also has its own
// downstream (the price-submission bridge, 0048), which is where a price list is meant to land.
export async function decideOnInterpretation(
  admin: DecisionRpcClient,
  isSupplier: boolean,
  jobId: string,
  interpretationId: string,
  actorId: string,
  apply: ApplyDecision = applyInterpretationDecision,
): Promise<void> {
  if (isSupplier) return;
  await apply(admin, jobId, interpretationId, actorId);
}

export interface ResumeInterpretationOptions {
  admin: DecisionRpcClient;
  isSupplier: boolean;
  jobId: string;
  actorId: string;
  context: { already_interpreted: boolean; interpretation_id?: string };
  apply?: ApplyDecision;
}

// ===== A REPLAY RE-OFFERS THE DECISION, and that is the only retry this feature has. =====
//
// A failed decision leaves NOTHING BEHIND in the database. Not a filing row, not a job marker,
// not an outbox entry -- the only trace is a console.error in a function log nobody reads. And
// there is no product path that would come back for it: DocumentReview computes its jobId from
// `status === 'extracted' && !snapshot.interpretation`, DocumentsInbox re-requests only jobs
// still at 'extracted', and save_document_interpretation has already moved the job to 'review'.
// So once the interpretation exists, the auto-trigger and the retry button are both null and the
// decision is lost permanently.
//
// It is not a rare event either: any transient PostgREST hiccup does it, and so does any lock
// wait on documents, which 0077 takes `for update`.
//
// Re-offering it on the replay path is safe, and 0077 was built for exactly this -- its own
// comments name "C4's fire-and-forget call ran again after a timeout" as a case it handles.
// Traced through both live outcomes: after auto_applied, the same-interpretation guard returns
// the recorded decision and writes nothing; after queued_for_review, v_replay is set, the
// existing filing is reused, and the replay escape is documented as deliberately safe while the
// document is still in the inbox -- which it is, because the guard immediately below refuses any
// document whose entity_type has moved on.
export async function resumeExistingInterpretation(
  options: ResumeInterpretationOptions,
): Promise<string | null> {
  const { context } = options;
  if (!context.already_interpreted || !context.interpretation_id) return null;
  await decideOnInterpretation(
    options.admin,
    options.isSupplier,
    options.jobId,
    context.interpretation_id,
    options.actorId,
    options.apply,
  );
  return context.interpretation_id;
}

export interface SaveAndDecideOptions {
  admin: DecisionRpcClient;
  isSupplier: boolean;
  jobId: string;
  actorId: string;
  args: Record<string, unknown>;
  findExisting: () => Promise<string | null>;
  apply?: ApplyDecision;
}

// Persistence and the decision that follows it, extracted from the handler so that the WIRING is
// pinned and not merely the parts. The handler itself cannot be driven under the gate's
// permission-free `deno test` -- it reads Deno.env before anything else -- so a decision call
// left inside it is a feature a refactor can delete with every gate still green. That is the
// same silent-failure shape core.test.ts guards one layer up, and it deserves the same treatment.
export async function saveAndDecideInterpretation(
  options: SaveAndDecideOptions,
): Promise<{ interpretationId: string; idempotent: boolean }> {
  const { admin, isSupplier } = options;
  const saved = await admin.rpc(
    isSupplier
      ? "save_supplier_price_interpretation"
      : "save_document_interpretation",
    options.args,
  );
  if (saved.error || !saved.data) {
    if (saved.error?.message.includes("document_interpretation_conflict")) {
      throw new EdgeError("interpretation_conflict", 409);
    }
    if (
      saved.error?.message.includes("document_interpretation_attempt_mismatch")
    ) {
      throw new EdgeError("interpretation_in_progress", 409);
    }
    if (
      saved.error?.message.includes("document_interpretation_actor_mismatch")
    ) {
      throw new EdgeError("interpretation_in_progress", 409);
    }
    if (saved.error?.message.includes("document_interpretation_actor_invalid")) {
      throw new EdgeError("not_authorized", 403);
    }
    if (saved.error?.message.includes("document_source_changed")) {
      throw new EdgeError("invalid_job_state", 409);
    }
    const existingId = await options.findExisting();
    if (existingId) {
      // AN INTERPRETATION THAT EXISTS HAS NOT BEEN DECIDED ON. This branch is a save that
      // COMMITTED and then reported a failure -- a transport error on the way back, or an error
      // message matching none of the five conflicts above -- so the row is there and this call is
      // the only one that will ever know about it. The client is handed a 200 and never comes
      // back: the review screen computes its jobId from `extracted && !interpretation`, which is
      // already false. Leaving it undecided here is the same permanent loss the replay path
      // exists to prevent, reached by a narrower door, and the idempotency argument is identical
      // -- 0077 keys on (org_id, interpretation_id) and returns the recorded decision rather than
      // taking a second one.
      await decideOnInterpretation(
        admin,
        isSupplier,
        options.jobId,
        existingId,
        options.actorId,
        options.apply,
      );
      return { interpretationId: existingId, idempotent: true };
    }
    throw new EdgeError("persistence_failed", 503);
  }
  const interpretationId = String(saved.data);
  await decideOnInterpretation(
    admin,
    isSupplier,
    options.jobId,
    interpretationId,
    options.actorId,
    options.apply,
  );
  return { interpretationId, idempotent: false };
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

export async function handler(req: Request): Promise<Response> {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return fail(cors, new EdgeError("invalid_request", 400));
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const providerKey = Deno.env.get("OPENAI_API_KEY");
  if (!url || !anonKey || !serviceKey || !providerKey) {
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
    "org_id,role,active,supplier_id",
  )
    .eq("id", actorId).maybeSingle();
  if (profileResult.error) {
    return fail(cors, new EdgeError("service_unavailable", 503));
  }
  const profile = profileResult.data as ProfileRow | null;
  if (
    !profile?.active ||
    !["owner", "office", "kitchen", "supplier"].includes(profile.role)
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
    .select(
      "id,org_id,document_id,status,requested_by,input_checksum,contract_version",
    ).eq("id", jobId)
    .eq("org_id", profile.org_id).maybeSingle();
  if (jobResult.error) {
    return fail(cors, new EdgeError("service_unavailable", 503));
  }
  const job = jobResult.data as JobRow | null;
  if (!job) return fail(cors, new EdgeError("job_unknown", 404));
  if (!["extracted", "interpreting", "review"].includes(job.status)) {
    return fail(cors, new EdgeError("invalid_job_state", 409));
  }

  const extractionResult = await admin.from("document_extractions").select(
    "id,org_id,job_id,document_id,input_checksum,contract_version",
  )
    .eq("org_id", profile.org_id).eq("job_id", job.id)
    .eq("document_id", job.document_id).maybeSingle();
  if (extractionResult.error) {
    return fail(cors, new EdgeError("service_unavailable", 503));
  }
  const extraction = extractionResult.data as ExtractionRow | null;
  if (!extraction) return fail(cors, new EdgeError("extraction_unknown", 404));

  const isSupplier = profile.role === "supplier";
  if (isSupplier) {
    const documentResult = await admin.from("documents").select(
      "id,org_id,entity_type,entity_id,supplier_id,document_kind,uploaded_by,storage_path,deleted_at",
    ).eq("id", job.document_id).eq("org_id", profile.org_id).maybeSingle();
    if (documentResult.error) {
      return fail(cors, new EdgeError("service_unavailable", 503));
    }
    const document = documentResult.data as DocumentRow | null;
    if (
      !document ||
      !supplierInterpretationContextAllowed(
        actorId,
        profile,
        document,
        job,
        extraction,
      )
    ) {
      return fail(cors, new EdgeError("not_authorized", 403));
    }
  }

  const beginResult = await admin.rpc(
    isSupplier
      ? "begin_supplier_price_interpretation"
      : "begin_document_interpretation",
    {
    p_job_id: job.id,
    p_extraction_id: extraction.id,
    p_actor_id: actorId,
    },
  );
  if (beginResult.error) return fail(cors, pgError(beginResult.error.message));
  const context = beginResult.data as BeginContext;
  const replayed = await resumeExistingInterpretation({
    admin,
    isSupplier,
    jobId: job.id,
    actorId,
    context,
  });
  if (replayed) {
    return json(cors, {
      interpretationId: replayed,
      jobId: job.id,
      status: "review",
      idempotent: true,
    }, 200);
  }
  const interpretationStartedAt = context.interpretation_started_at;
  if (
    context.org_id !== profile.org_id || context.job_id !== job.id ||
    context.extraction_id !== extraction.id || context.actor_id !== actorId ||
    typeof interpretationStartedAt !== "string" || !interpretationStartedAt ||
    context.extraction_contract_version !== "1" || !context.extraction_payload
  ) {
    if (typeof interpretationStartedAt === "string" && interpretationStartedAt) {
      await markFailed(
        admin,
        job.id,
        extraction.id,
        actorId,
        interpretationStartedAt,
        "unsupported_extraction_contract",
        isSupplier,
      );
    }
    return fail(cors, new EdgeError("unsupported_extraction_contract", 409));
  }

  try {
    let suppliersQuery = admin.from("suppliers").select("id,name,status").eq(
      "org_id",
      context.org_id,
    ).is("deleted_at", null).order("name").limit(101);
    let rulesQuery = admin.from("document_learning_rules")
        .select(
          "id,user_id,document_type,supplier_id,mark_kind,mark_fingerprint,tag_key,label,version",
        )
        .eq("org_id", context.org_id).eq("active", true)
        .or(`user_id.is.null,user_id.eq.${actorId}`).order("version", {
          ascending: false,
        }).limit(201);
    if (isSupplier && profile.supplier_id) {
      suppliersQuery = suppliersQuery.eq("id", profile.supplier_id);
      rulesQuery = rulesQuery.or(
        `supplier_id.is.null,supplier_id.eq.${profile.supplier_id}`,
      );
    }
    const [suppliersResult, rulesResult] = await Promise.all([
      suppliersQuery,
      rulesQuery,
    ]);
    if (suppliersResult.error || rulesResult.error) {
      throw new EdgeError("context_unavailable", 503);
    }

    const suppliers: SupplierCandidate[] =
      ((suppliersResult.data ?? []) as SupplierRow[])
        .map(({ id, name, status }) => ({ id, name, status }));
    if (
      isSupplier &&
      (suppliers.length !== 1 || suppliers[0].id !== profile.supplier_id)
    ) {
      throw new EdgeError("context_unavailable", 503);
    }
    const visibleRules = ((rulesResult.data ?? []) as RuleRow[]).filter(
      (rule) =>
        !isSupplier || rule.supplier_id === null ||
        rule.supplier_id === profile.supplier_id,
    );
    const rules: LearningRuleSummary[] = visibleRules
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
    const result = await createOpenAiProvider({ apiKey: providerKey })
      .interpret(providerPayload);
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const persisted = await saveAndDecideInterpretation({
      admin,
      isSupplier,
      jobId: job.id,
      actorId,
      args: {
        p_job_id: job.id,
        p_extraction_id: extraction.id,
        p_actor_id: actorId,
        p_interpretation_started_at: interpretationStartedAt,
        p_provider: PROVIDER,
        // The dated snapshot the provider actually used, not the alias we requested.
        p_model: result.model,
        p_prompt_version: PROMPT_VERSION,
        p_schema_version: SCHEMA_VERSION,
        p_payload: result.interpretation,
        p_usage: {
          ...result.usage,
          provider_request_id: result.provider_request_id,
          input_truncation: providerPayload.truncation,
        },
        p_duration_ms: durationMs,
      },
      findExisting: () => existingInterpretation(admin, context.org_id, job.id),
    });
    if (persisted.idempotent) {
      return json(cors, {
        interpretationId: persisted.interpretationId,
        jobId: job.id,
        status: "review",
        idempotent: true,
      }, 200);
    }

    return json(cors, {
      interpretationId: persisted.interpretationId,
      jobId: job.id,
      status: "review",
      schemaVersion: SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      model: result.model,
      idempotent: false,
    }, 200);
  } catch (error) {
    const edgeError = error instanceof InterpretationError
      ? providerError(error)
      : error instanceof EdgeError
      ? error
      : new EdgeError("service_unavailable", 503);
    await markFailed(
      admin,
      job.id,
      extraction.id,
      actorId,
      interpretationStartedAt,
      edgeError.code,
      isSupplier,
    );
    console.error("interpret-document failed", edgeError.code);
    return fail(cors, edgeError);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}

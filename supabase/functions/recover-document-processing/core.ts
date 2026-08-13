export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RECOVERY_OUTCOMES = [
  "requeued",
  "extraction_recovered",
  "resume_interpretation",
  "interpretation_recovered",
] as const;

export type RecoveryOutcome = typeof RECOVERY_OUTCOMES[number];

export const RECOVERY_STUCK_REASONS = [
  "claim_attempt_limit_reached",
  "lease_expired",
  "active_over_two_hours",
  "no_progress",
  "committed_evidence_available",
] as const;

export interface RecoveryRequest {
  job_id: string;
  request_id: string;
  reason: string;
}

export interface RecoveryResult {
  outcome: RecoveryOutcome;
  old_job_id: string;
  job_id: string;
  stuck_reason: string;
  idempotent: boolean;
}

export class RequestValidationError extends Error {}

export function parseRecoveryRequest(value: unknown): RecoveryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError("invalid_request");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "job_id,reason,request_id") {
    throw new RequestValidationError("invalid_request");
  }
  const jobId = record.job_id;
  const requestId = record.request_id;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (
    typeof jobId !== "string" || !UUID.test(jobId) ||
    typeof requestId !== "string" || !UUID.test(requestId) ||
    reason.length < 1 || reason.length > 1000
  ) {
    throw new RequestValidationError("invalid_request");
  }
  return { job_id: jobId, request_id: requestId, reason };
}

export function isRecoveryResult(value: unknown): value is RecoveryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.join(",") ===
      "idempotent,job_id,old_job_id,outcome,stuck_reason" &&
    typeof record.outcome === "string" &&
    (RECOVERY_OUTCOMES as readonly string[]).includes(record.outcome) &&
    typeof record.old_job_id === "string" && UUID.test(record.old_job_id) &&
    typeof record.job_id === "string" && UUID.test(record.job_id) &&
    typeof record.stuck_reason === "string" &&
    (RECOVERY_STUCK_REASONS as readonly string[]).includes(
      record.stuck_reason,
    ) &&
    typeof record.idempotent === "boolean";
}

export function shouldInvokeInterpretDocument(
  outcome: RecoveryOutcome,
): boolean {
  return outcome === "extraction_recovered" ||
    outcome === "resume_interpretation" ||
    outcome === "interpretation_recovered";
}

export type RecoveryErrorCode =
  | "unauthenticated"
  | "not_authorized"
  | "invalid_request"
  | "organization_read_only"
  | "job_not_recoverable"
  | "recovery_in_progress"
  | "request_conflict"
  | "service_unavailable";

export function databaseErrorCode(error: {
  code?: string;
  message?: string;
}): RecoveryErrorCode {
  const message = error.message ?? "";
  if (
    message.includes("document_processing_source_changed") ||
    message.includes("document_processing_job_not_current") ||
    message.includes("document_processing_job_not_stuck") ||
    message.includes("document_processing_recovery_state_invalid")
  ) {
    return "job_not_recoverable";
  }
  if (
    error.code === "22023" ||
    message.includes("document_processing_recovery_invalid")
  ) {
    return "invalid_request";
  }
  if (message.includes("organization_read_only")) {
    return "organization_read_only";
  }
  if (
    error.code === "42501" || message.includes("service_role_required") ||
    message.includes("not_authorized")
  ) {
    return "not_authorized";
  }
  if (
    error.code === "23505" ||
    message.includes("document_processing_recovery_conflict")
  ) {
    return "request_conflict";
  }
  if (
    message.includes("document_processing_lease_active") ||
    message.includes("document_processing_egress_active")
  ) {
    return "recovery_in_progress";
  }
  if (
    error.code === "55000" || error.code === "P0002" ||
    message.includes("document_processing_job_unknown") ||
    message.includes("document_unknown")
  ) {
    return "job_not_recoverable";
  }
  return "service_unavailable";
}

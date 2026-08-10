import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  getOrganizationEgressEvidence,
  type OrganizationEgressOutcome,
  releaseOrganizationEgress,
  reserveOrganizationEgress,
  type ServiceRpc,
  type ServiceRpcResult,
} from "../_shared/organization-egress.ts";
import { runReservedEgress } from "../_shared/reserved-egress.ts";
import { organizationCanManageBranding, validatedLogoType } from "./core.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-correlation-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-supplyflow-correlation-disposition",
};

const json = (
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extraHeaders },
  });

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_CONTROL_TIMEOUT_MS = 8_000;
const STORAGE_EGRESS_TTL_SECONDS = 60;
const ROTATE_CORRELATION_HEADERS = {
  "x-supplyflow-correlation-disposition": "rotate-after-definitive-failure",
};

interface LogoMutationResult {
  body: Record<string, unknown>;
  status: number;
  outcome: OrganizationEgressOutcome;
  evidenceCode: string;
  evidence: Record<string, unknown>;
}

function databaseFailureIsDefinitive(error: unknown): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code.trim().length > 0;
}

function serviceRpc(admin: SupabaseClient): ServiceRpc {
  return (name, args) =>
    admin.rpc(name, args) as unknown as PromiseLike<ServiceRpcResult>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = req.headers.get("Authorization");
  if (!url || !anonKey || !serviceKey) {
    return json({ error: "server_misconfigured" }, 500);
  }
  if (!authorization) return json({ error: "unauthenticated" }, 401);

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) {
    return json({ error: "unauthenticated" }, 401);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
    // Every database/storage leg that can run after reservation is individually bounded. The
    // longest upload path is upload + reference CAS + old-object cleanup + evidence settlement,
    // leaving a material margin inside the 60-second lease.
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(STORAGE_CONTROL_TIMEOUT_MS),
        }),
    },
  });
  const { data: profile, error: profileError } = await admin.from("profiles")
    .select("org_id, role, active").eq("id", userData.user.id).maybeSingle();
  if (profileError) return json({ error: "authorization_failed" }, 500);
  const { data: organization, error: organizationReadError } = profile
    ? await admin.from("organizations").select("logo_path").eq(
      "id",
      profile.org_id,
    ).maybeSingle()
    : { data: null, error: null };
  const { data: accessMode, error: accessModeError } = profile
    ? await admin.rpc("service_organization_access_mode", {
      p_org_id: profile.org_id,
    })
    : { data: null, error: null };
  if (organizationReadError) {
    return json({ error: "authorization_failed" }, 500);
  }
  if (accessModeError) return json({ error: "authorization_failed" }, 500);
  if (
    !profile || !organizationCanManageBranding(
      profile,
      accessMode ? { access_mode: String(accessMode) } : null,
    )
  ) {
    return json({ error: "forbidden" }, 403);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "invalid_form_data" }, 400);
  }

  const action = form.get("action") === "remove" ? "remove" : "upload";
  let uploadBytes: Uint8Array | null = null;
  let uploadType: { extension: string; contentType: string } | null = null;
  if (action === "upload") {
    const value = form.get("file");
    if (!(value instanceof File)) return json({ error: "file_required" }, 400);
    uploadBytes = new Uint8Array(await value.arrayBuffer());
    uploadType = validatedLogoType(uploadBytes, value.type, value.size);
    if (!uploadType) return json({ error: "invalid_logo" }, 400);
  }

  const rpc = serviceRpc(admin);
  const presentedCorrelation = req.headers.get("x-correlation-id") ?? "";
  if (!UUID.test(presentedCorrelation)) {
    return json({ error: "invalid_correlation_id" }, 400);
  }
  const correlationId = presentedCorrelation;
  let reservation;
  try {
    reservation = await reserveOrganizationEgress(rpc, {
      orgId: profile.org_id,
      kind: "organization_logo_storage",
      correlationId,
      ttlSeconds: STORAGE_EGRESS_TTL_SECONDS,
    });
  } catch {
    return json({ error: "storage_reservation_failed" }, 503);
  }
  if (!reservation.lease) {
    if (reservation.settledOutcome) {
      try {
        const settled = await getOrganizationEgressEvidence(rpc, {
          orgId: profile.org_id,
          kind: "organization_logo_storage",
          correlationId,
        });
        if (
          reservation.settledOutcome === "delivered" &&
          settled?.evidence.action === action
        ) {
          return json({
            path: settled.evidence.path ?? null,
            updated_at: settled.evidence.updated_at ?? null,
            cleanup_failed: Boolean(settled.evidence.cleanup_failed),
            idempotent: true,
          }, 200);
        }
        if (
          reservation.settledOutcome === "failed" &&
          settled?.evidence.action === action &&
          settled.evidence.retryable_definitive === true
        ) {
          return json(
            {
              error: settled.evidence.error ?? "storage_operation_failed",
              retryable_definitive: true,
            },
            409,
            ROTATE_CORRELATION_HEADERS,
          );
        }
      } catch {
        return json({ error: "storage_evidence_unavailable" }, 503);
      }
    }
    return json({
      error: reservation.settledOutcome
        ? "storage_outcome_requires_review"
        : "organization_unavailable",
    }, reservation.settledOutcome ? 409 : 403);
  }
  if (reservation.lease.idempotent) {
    return json({ error: "storage_operation_in_progress" }, 409);
  }
  const storageLease = reservation.lease;
  const operationEvidence: Record<string, unknown> = {
    action,
    path: null,
    previous_path: organization?.logo_path ?? null,
    upload_started: false,
    uploaded: null,
    reference_started: false,
    reference_committed: null,
    cleanup_started: false,
    cleanup_failed: null,
  };

  try {
    const result = await runReservedEgress({
      reserve: () => Promise.resolve(storageLease),
      perform: async (): Promise<LogoMutationResult> => {
        if (action === "remove") {
          operationEvidence.reference_started = true;
          const removedReference = await admin.rpc(
            "set_organization_branding_reference",
            {
              p_actor_id: userData.user.id,
              p_expected_logo_path: organization?.logo_path ?? null,
              p_new_logo_path: null,
              p_new_logo_updated_at: null,
              p_reason: "owner_removed_organization_logo",
            },
          );
          if (removedReference.error || !removedReference.data) {
            if (
              removedReference.error &&
              !databaseFailureIsDefinitive(removedReference.error)
            ) {
              throw new Error("branding_reference_outcome_unknown");
            }
            operationEvidence.reference_committed = false;
            const error = removedReference.error
              ? "organization_update_failed"
              : "branding_conflict";
            return {
              body: { error },
              status: removedReference.error ? 502 : 409,
              outcome: "failed",
              evidenceCode: error,
              evidence: {
                ...operationEvidence,
                error,
                retryable_definitive: true,
              },
            };
          }
          operationEvidence.reference_committed = true;
          operationEvidence.cleanup_started = Boolean(organization?.logo_path);
          const cleanup = organization?.logo_path
            ? await admin.storage.from("organization-branding").remove([
              organization.logo_path,
            ])
            : { error: null };
          const cleanupFailed = Boolean(cleanup.error);
          operationEvidence.cleanup_failed = cleanupFailed;
          return {
            body: {
              path: null,
              updated_at: null,
              cleanup_failed: cleanupFailed,
            },
            status: 200,
            outcome: "delivered",
            evidenceCode: cleanupFailed
              ? "logo_remove_committed_cleanup_failed"
              : "logo_remove_committed",
            evidence: { ...operationEvidence, updated_at: null },
          };
        }

        if (!uploadBytes || !uploadType) {
          throw new Error("validated_upload_missing");
        }
        const path =
          `${profile.org_id}/${crypto.randomUUID()}.${uploadType.extension}`;
        operationEvidence.path = path;
        operationEvidence.upload_started = true;
        const upload = await admin.storage.from("organization-branding").upload(
          path,
          uploadBytes,
          {
            upsert: false,
            contentType: uploadType.contentType,
            cacheControl: "31536000",
          },
        );
        if (upload.error) {
          operationEvidence.uploaded = false;
          operationEvidence.cleanup_started = true;
          const failedUploadCleanup = await admin.storage.from(
            "organization-branding",
          ).remove([path]);
          const cleanupFailed = Boolean(failedUploadCleanup.error);
          operationEvidence.cleanup_failed = cleanupFailed;
          return {
            body: { error: "upload_failed", cleanup_failed: cleanupFailed },
            status: 502,
            outcome: cleanupFailed ? "ambiguous" : "failed",
            evidenceCode: cleanupFailed
              ? "logo_upload_failed_cleanup_unverified"
              : "logo_upload_failed_no_object_remains",
            evidence: {
              ...operationEvidence,
              error: "upload_failed",
              retryable_definitive: !cleanupFailed,
            },
          };
        }
        operationEvidence.uploaded = true;

        const updatedAt = new Date().toISOString();
        operationEvidence.reference_started = true;
        const organizationUpdate = await admin.rpc(
          "set_organization_branding_reference",
          {
            p_actor_id: userData.user.id,
            p_expected_logo_path: organization?.logo_path ?? null,
            p_new_logo_path: path,
            p_new_logo_updated_at: updatedAt,
            p_reason: "owner_uploaded_organization_logo",
          },
        );
        if (organizationUpdate.error || !organizationUpdate.data) {
          if (
            organizationUpdate.error &&
            !databaseFailureIsDefinitive(organizationUpdate.error)
          ) {
            throw new Error("branding_reference_outcome_unknown");
          }
          operationEvidence.reference_committed = false;
          operationEvidence.cleanup_started = true;
          const orphanCleanup = await admin.storage.from(
            "organization-branding",
          ).remove([path]);
          const cleanupFailed = Boolean(orphanCleanup.error);
          operationEvidence.cleanup_failed = cleanupFailed;
          const error = organizationUpdate.error
            ? "organization_update_failed"
            : "branding_conflict";
          return {
            body: { error, cleanup_failed: cleanupFailed },
            status: organizationUpdate.error ? 502 : 409,
            outcome: cleanupFailed ? "ambiguous" : "failed",
            evidenceCode: cleanupFailed
              ? "logo_reference_failed_orphan_cleanup_failed"
              : "logo_reference_failed_upload_reverted",
            evidence: {
              ...operationEvidence,
              updated_at: updatedAt,
              error,
              retryable_definitive: !cleanupFailed,
            },
          };
        }
        operationEvidence.reference_committed = true;

        operationEvidence.cleanup_started = Boolean(
          organization?.logo_path && organization.logo_path !== path,
        );
        const cleanup =
          organization?.logo_path && organization.logo_path !== path
            ? await admin.storage.from("organization-branding").remove([
              organization.logo_path,
            ])
            : { error: null };
        const cleanupFailed = Boolean(cleanup.error);
        operationEvidence.cleanup_failed = cleanupFailed;
        return {
          body: { path, updated_at: updatedAt, cleanup_failed: cleanupFailed },
          status: 200,
          outcome: "delivered",
          evidenceCode: cleanupFailed
            ? "logo_upload_committed_cleanup_failed"
            : "logo_upload_committed",
          evidence: { ...operationEvidence, updated_at: updatedAt },
        };
      },
      settle: (lease, outcome) =>
        releaseOrganizationEgress(
          rpc,
          lease,
          outcome.ok
            ? {
              outcome: outcome.result.outcome,
              evidenceCode: outcome.result.evidenceCode,
              evidence: outcome.result.evidence,
            }
            : {
              outcome: "ambiguous",
              evidenceCode: "logo_storage_exception",
              // This is the only recovery pointer if Storage committed and the HTTP response was
              // lost. Preserve the tenant-prefixed orphan path and the last known phase.
              evidence: { ...operationEvidence },
            },
        ),
    });
    const retryableDefinitive = result.outcome === "failed" &&
      result.evidence.retryable_definitive === true;
    return json(
      retryableDefinitive
        ? { ...result.body, retryable_definitive: true }
        : result.body,
      result.status,
      retryableDefinitive ? ROTATE_CORRELATION_HEADERS : {},
    );
  } catch {
    return json({ error: "storage_operation_failed" }, 503);
  }
});

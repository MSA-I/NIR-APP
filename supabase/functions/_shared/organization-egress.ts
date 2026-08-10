export type OrganizationEgressKind =
  | "document_interpretation"
  | "invitation_email"
  | "push_notification"
  | "integration_webhook"
  | "document_signed_url"
  | "whatsapp_reminder"
  | "organization_logo_storage";

export type OrganizationEgressOutcome =
  | "delivered"
  | "failed"
  | "denied"
  | "ambiguous";

export interface OrganizationEgressLease {
  lease_id: string;
  lease_token: string;
  org_id: string;
  kind: OrganizationEgressKind;
  correlation_id: string;
  expires_at: string;
  idempotent: boolean;
  egress_allowed: boolean;
  settled_outcome: OrganizationEgressOutcome | null;
}

export interface OrganizationEgressReservation {
  lease: OrganizationEgressLease | null;
  settledOutcome: OrganizationEgressOutcome | null;
}

export interface OrganizationEgressEvidence {
  lease_id: string;
  org_id: string;
  kind: OrganizationEgressKind;
  correlation_id: string;
  lease_outcome: OrganizationEgressOutcome;
  evidence_outcome: OrganizationEgressOutcome;
  evidence_code: string | null;
  provider_status: number | null;
  evidence: Record<string, unknown>;
  evidence_sha256: string;
  recorded_at: string;
}

export interface OrganizationEgressSettlement {
  lease_id: string;
  org_id: string;
  kind: OrganizationEgressKind;
  correlation_id: string;
  lease_outcome: OrganizationEgressOutcome;
  evidence_outcome: OrganizationEgressOutcome;
  evidence_sha256: string;
  idempotent: boolean;
}

export interface ServiceRpcResult {
  data: unknown;
  error: { message: string } | null;
}

export type ServiceRpc = (
  name: string,
  args: Record<string, unknown>,
) => PromiseLike<ServiceRpcResult>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = new Set<OrganizationEgressKind>([
  "document_interpretation",
  "invitation_email",
  "push_notification",
  "integration_webhook",
  "document_signed_url",
  "whatsapp_reminder",
  "organization_logo_storage",
]);

function leaseRow(
  value: unknown,
): value is
  | OrganizationEgressLease
  | (Omit<OrganizationEgressLease, "lease_token"> & {
    lease_token: null;
  }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.lease_id === "string" && UUID.test(row.lease_id) &&
    (row.lease_token === null ||
      (typeof row.lease_token === "string" && UUID.test(row.lease_token))) &&
    typeof row.org_id === "string" && UUID.test(row.org_id) &&
    typeof row.kind === "string" &&
    KINDS.has(row.kind as OrganizationEgressKind) &&
    typeof row.correlation_id === "string" && UUID.test(row.correlation_id) &&
    typeof row.expires_at === "string" &&
    !Number.isNaN(Date.parse(row.expires_at)) &&
    typeof row.idempotent === "boolean" &&
    typeof row.egress_allowed === "boolean" &&
    (row.settled_outcome === null ||
      ["delivered", "failed", "denied", "ambiguous"].includes(
        String(row.settled_outcome),
      ));
}

function reservationDenied(message: string): boolean {
  return [
    "organization_external_egress_denied",
    "organization_external_egress_not_allowed",
    "organization_egress_denied",
    "organization_read_only",
    "org_suspended",
    "offboarding",
  ].some((marker) => message.includes(marker));
}

export async function reserveOrganizationEgress(
  rpc: ServiceRpc,
  values: {
    orgId: string;
    kind: OrganizationEgressKind;
    correlationId: string;
    ttlSeconds: number;
  },
): Promise<OrganizationEgressReservation> {
  const result = await rpc("service_reserve_organization_external_egress", {
    p_org_id: values.orgId,
    p_kind: values.kind,
    p_correlation_id: values.correlationId,
    p_ttl_seconds: values.ttlSeconds,
  });
  if (result.error) {
    if (reservationDenied(result.error.message)) {
      return { lease: null, settledOutcome: null };
    }
    throw new Error("organization_egress_reservation_unavailable");
  }
  if (result.data === null) return { lease: null, settledOutcome: null };
  if (!leaseRow(result.data)) {
    throw new Error("organization_egress_reservation_invalid");
  }
  if (result.data.egress_allowed) {
    if (result.data.lease_token === null) {
      throw new Error("organization_egress_reservation_invalid");
    }
    return { lease: result.data, settledOutcome: null };
  }
  if (
    result.data.lease_token !== null || result.data.settled_outcome === null
  ) {
    throw new Error("organization_egress_reservation_invalid");
  }
  return { lease: null, settledOutcome: result.data.settled_outcome };
}

export async function releaseOrganizationEgress(
  rpc: ServiceRpc,
  lease: OrganizationEgressLease,
  values: {
    outcome: OrganizationEgressOutcome;
    evidenceCode?: string | null;
    providerStatus?: number | null;
    evidence?: Record<string, unknown>;
  },
): Promise<OrganizationEgressSettlement> {
  const result = await rpc(
    "service_settle_organization_external_egress_evidence",
    {
      p_lease_id: lease.lease_id,
      p_lease_token: lease.lease_token,
      p_outcome: values.outcome,
      p_evidence_code: values.evidenceCode ?? null,
      p_provider_status: values.providerStatus ?? null,
      p_evidence: values.evidence ?? {},
    },
  );
  if (result.error || !settlementRow(result.data)) {
    throw new Error("organization_egress_settlement_failed");
  }
  return result.data;
}

function settlementRow(value: unknown): value is OrganizationEgressSettlement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.lease_id === "string" && UUID.test(row.lease_id) &&
    typeof row.org_id === "string" && UUID.test(row.org_id) &&
    typeof row.kind === "string" &&
    KINDS.has(row.kind as OrganizationEgressKind) &&
    typeof row.correlation_id === "string" && UUID.test(row.correlation_id) &&
    typeof row.lease_outcome === "string" &&
    ["delivered", "failed", "denied", "ambiguous"].includes(
      row.lease_outcome,
    ) &&
    typeof row.evidence_outcome === "string" &&
    ["delivered", "failed", "denied", "ambiguous"].includes(
      row.evidence_outcome,
    ) &&
    typeof row.evidence_sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(row.evidence_sha256) &&
    typeof row.idempotent === "boolean";
}

function evidenceRow(value: unknown): value is OrganizationEgressEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.lease_id === "string" && UUID.test(row.lease_id) &&
    typeof row.org_id === "string" && UUID.test(row.org_id) &&
    typeof row.kind === "string" &&
    KINDS.has(row.kind as OrganizationEgressKind) &&
    typeof row.correlation_id === "string" && UUID.test(row.correlation_id) &&
    typeof row.lease_outcome === "string" &&
    ["delivered", "failed", "denied", "ambiguous"].includes(
      row.lease_outcome,
    ) &&
    typeof row.evidence_outcome === "string" &&
    ["delivered", "failed", "denied", "ambiguous"].includes(
      row.evidence_outcome,
    ) &&
    (row.evidence_code === null || typeof row.evidence_code === "string") &&
    (row.provider_status === null || Number.isInteger(row.provider_status)) &&
    !!row.evidence && typeof row.evidence === "object" &&
    !Array.isArray(row.evidence) &&
    typeof row.evidence_sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(row.evidence_sha256) &&
    typeof row.recorded_at === "string" &&
    !Number.isNaN(Date.parse(row.recorded_at));
}

export async function getOrganizationEgressEvidence(
  rpc: ServiceRpc,
  values: {
    orgId: string;
    kind: OrganizationEgressKind;
    correlationId: string;
  },
): Promise<OrganizationEgressEvidence | null> {
  const result = await rpc(
    "service_get_organization_external_egress_evidence",
    {
      p_org_id: values.orgId,
      p_kind: values.kind,
      p_correlation_id: values.correlationId,
    },
  );
  if (result.error) throw new Error("organization_egress_evidence_unavailable");
  if (result.data === null) return null;
  if (!evidenceRow(result.data)) {
    throw new Error("organization_egress_evidence_invalid");
  }
  return result.data;
}

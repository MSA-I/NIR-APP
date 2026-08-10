import {
  getOrganizationEgressEvidence,
  releaseOrganizationEgress,
  reserveOrganizationEgress,
  type ServiceRpc,
} from "./organization-egress.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const CORRELATION = "22222222-2222-4222-8222-222222222222";
const LEASE = "33333333-3333-4333-8333-333333333333";
const TOKEN = "44444444-4444-4444-8444-444444444444";

Deno.test("reserve uses the canonical service RPC and validates its lease", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc: ServiceRpc = (name, args) => {
    calls.push([name, args]);
    return Promise.resolve({
      data: {
        lease_id: LEASE,
        lease_token: TOKEN,
        org_id: ORG,
        kind: "integration_webhook",
        correlation_id: CORRELATION,
        expires_at: "2026-08-09T12:00:00.000Z",
        idempotent: false,
        egress_allowed: true,
        settled_outcome: null,
      },
      error: null,
    });
  };
  const reservation = await reserveOrganizationEgress(rpc, {
    orgId: ORG,
    kind: "integration_webhook",
    correlationId: CORRELATION,
    ttlSeconds: 30,
  });
  if (!reservation.lease || calls.length !== 1) {
    throw new Error("valid lease was rejected");
  }
  if (calls[0][0] !== "service_reserve_organization_external_egress") {
    throw new Error("wrong reserve RPC");
  }
  if (calls[0][1].p_correlation_id !== CORRELATION) {
    throw new Error("correlation id was not preserved");
  }
});

Deno.test("lifecycle denial is a denied reservation, not an invented lease", async () => {
  const rpc: ServiceRpc = () =>
    Promise.resolve({
      data: null,
      error: { message: "organization_read_only" },
    });
  const reservation = await reserveOrganizationEgress(rpc, {
    orgId: ORG,
    kind: "push_notification",
    correlationId: CORRELATION,
    ttlSeconds: 30,
  });
  if (reservation.lease !== null || reservation.settledOutcome !== null) {
    throw new Error("lifecycle denial produced a lease");
  }
});

Deno.test("a settled correlation can never call the provider again", async () => {
  const rpc: ServiceRpc = () =>
    Promise.resolve({
      data: {
        lease_id: LEASE,
        lease_token: null,
        org_id: ORG,
        kind: "push_notification",
        correlation_id: CORRELATION,
        expires_at: "2026-08-09T12:00:00.000Z",
        idempotent: true,
        egress_allowed: false,
        settled_outcome: "delivered",
      },
      error: null,
    });
  const reservation = await reserveOrganizationEgress(rpc, {
    orgId: ORG,
    kind: "push_notification",
    correlationId: CORRELATION,
    ttlSeconds: 30,
  });
  if (
    reservation.lease !== null || reservation.settledOutcome !== "delivered"
  ) {
    throw new Error(
      "settled correlation was re-opened or its evidence was lost",
    );
  }
});

Deno.test("a live idempotent lease retains its fencing token for caller-side in-progress handling", async () => {
  const rpc: ServiceRpc = () =>
    Promise.resolve({
      data: {
        lease_id: LEASE,
        lease_token: TOKEN,
        org_id: ORG,
        kind: "document_interpretation",
        correlation_id: CORRELATION,
        expires_at: "2026-08-09T12:00:00.000Z",
        idempotent: true,
        egress_allowed: true,
        settled_outcome: null,
      },
      error: null,
    });
  const reservation = await reserveOrganizationEgress(rpc, {
    orgId: ORG,
    kind: "document_interpretation",
    correlationId: CORRELATION,
    ttlSeconds: 120,
  });
  if (
    !reservation.lease?.idempotent || reservation.lease.lease_token !== TOKEN
  ) {
    throw new Error("live retry lost its in-progress fencing state");
  }
});

Deno.test("release carries the exact fencing token and evidence", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc: ServiceRpc = (name, args) => {
    calls.push([name, args]);
    return Promise.resolve({
      data: {
        lease_id: LEASE,
        org_id: ORG,
        kind: "integration_webhook",
        correlation_id: CORRELATION,
        lease_outcome: "delivered",
        evidence_outcome: "delivered",
        evidence_sha256: "a".repeat(64),
        idempotent: false,
      },
      error: null,
    });
  };
  const settled = await releaseOrganizationEgress(rpc, {
    lease_id: LEASE,
    lease_token: TOKEN,
    org_id: ORG,
    kind: "integration_webhook",
    correlation_id: CORRELATION,
    expires_at: "2026-08-09T12:00:00.000Z",
    idempotent: false,
    egress_allowed: true,
    settled_outcome: null,
  }, {
    outcome: "delivered",
    evidenceCode: "target_accepted",
    providerStatus: 202,
    evidence: { attempt: 1 },
  });
  if (settled.evidence_sha256 !== "a".repeat(64)) {
    throw new Error("database-computed canonical evidence hash was discarded");
  }
  if (
    calls[0][0] !== "service_settle_organization_external_egress_evidence"
  ) {
    throw new Error("wrong release RPC");
  }
  if (
    calls[0][1].p_lease_token !== TOKEN ||
    calls[0][1].p_outcome !== "delivered" ||
    calls[0][1].p_provider_status !== 202 ||
    (calls[0][1].p_evidence as { attempt?: number }).attempt !== 1
  ) {
    throw new Error("release evidence was altered");
  }
});

Deno.test("read validates immutable evidence before returning it", async () => {
  const rpc: ServiceRpc = () =>
    Promise.resolve({
      data: {
        lease_id: LEASE,
        org_id: ORG,
        kind: "document_interpretation",
        correlation_id: CORRELATION,
        lease_outcome: "ambiguous",
        evidence_outcome: "ambiguous",
        evidence_code: "interpretation_persistence_ambiguous",
        provider_status: null,
        evidence: { model: "gpt-5.1-2025-11-13" },
        evidence_sha256: "a".repeat(64),
        recorded_at: "2026-08-09T12:00:01.000Z",
      },
      error: null,
    });
  const evidence = await getOrganizationEgressEvidence(rpc, {
    orgId: ORG,
    kind: "document_interpretation",
    correlationId: CORRELATION,
  });
  if (
    evidence?.evidence_outcome !== "ambiguous" ||
    evidence.evidence.model !== "gpt-5.1-2025-11-13"
  ) {
    throw new Error("valid evidence was lost");
  }
});

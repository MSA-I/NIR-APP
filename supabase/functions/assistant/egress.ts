// Provider egress under a database reservation -- the interpret-document composition, verbatim
// in structure: _shared/organization-egress.ts owns the lease grammar (0166 registered the
// 'assistant' kind in the database CHECK, the reserve function and the shared union), and
// _shared/reserved-egress.ts owns the discipline -- a denied reservation never calls the
// provider, and a completed attempt always settles with evidence before its result or error
// reaches the caller. Nothing here re-validates a lease row; one boundary, one implementation.
import {
  type OrganizationEgressLease,
  releaseOrganizationEgress,
  reserveOrganizationEgress,
  type ServiceRpc,
  type ServiceRpcResult,
} from "../_shared/organization-egress.ts";
import {
  EgressReservationDeniedError,
  runReservedEgress,
} from "../_shared/reserved-egress.ts";

export { EgressReservationDeniedError };
export type { OrganizationEgressLease, ServiceRpc, ServiceRpcResult };

export const ASSISTANT_EGRESS_KIND = "assistant" as const;

export interface AssistantEgressEvidence {
  code: string | null;
  body: Record<string, unknown>;
}

/**
 * The one path to the provider. Every run reserves under a FRESH client-generated uuid, so an
 * idempotent lease can only mean a concurrent duplicate of this very request -- refused rather
 * than allowed to buy a second provider call. A reservation the database declined (suspended,
 * read-only, offboarding) or already settled surfaces as EgressReservationDeniedError, before
 * any spend.
 */
export async function runAssistantEgress<TResult>(
  rpc: ServiceRpc,
  values: { orgId: string; runId: string; ttlSeconds: number },
  perform: (lease: OrganizationEgressLease) => Promise<TResult>,
  evidence: (
    outcome: { ok: true; result: TResult } | { ok: false; error: unknown },
  ) => AssistantEgressEvidence,
): Promise<TResult> {
  return await runReservedEgress<OrganizationEgressLease, TResult>({
    reserve: async () => {
      const reservation = await reserveOrganizationEgress(rpc, {
        orgId: values.orgId,
        kind: ASSISTANT_EGRESS_KIND,
        correlationId: values.runId,
        ttlSeconds: values.ttlSeconds,
      });
      if (!reservation.lease || reservation.lease.idempotent) return null;
      return reservation.lease;
    },
    perform,
    settle: async (lease, outcome) => {
      const { code, body } = evidence(outcome);
      await releaseOrganizationEgress(rpc, lease, {
        outcome: outcome.ok ? "delivered" : "failed",
        evidenceCode: code,
        evidence: body,
      });
    },
  });
}

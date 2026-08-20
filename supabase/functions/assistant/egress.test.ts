// Egress reservation contracts, composed through the SHARED boundary (0166 registered the
// 'assistant' kind): a denied or unarmed lease never calls the provider, a completed attempt
// always settles with evidence, and a settlement failure can never read as success.
import assert from "node:assert/strict";
import {
  ASSISTANT_EGRESS_KIND,
  EgressReservationDeniedError,
  runAssistantEgress,
  type ServiceRpc,
} from "./egress.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const RUN = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(64);

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    lease_id: "44444444-4444-4444-8444-444444444444",
    lease_token: "55555555-5555-4555-8555-555555555555",
    org_id: ORG,
    kind: ASSISTANT_EGRESS_KIND,
    correlation_id: RUN,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    idempotent: false,
    egress_allowed: true,
    settled_outcome: null,
    ...overrides,
  };
}

function settlementRow(outcome: string) {
  return {
    lease_id: "44444444-4444-4444-8444-444444444444",
    org_id: ORG,
    kind: ASSISTANT_EGRESS_KIND,
    correlation_id: RUN,
    lease_outcome: outcome,
    evidence_outcome: outcome,
    evidence_sha256: SHA,
    idempotent: false,
  };
}

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

function scriptedRpc(
  reserve: { data: unknown; error: { message: string } | null },
  calls: RpcCall[],
  settleError: { message: string } | null = null,
): ServiceRpc {
  return (name, args) => {
    calls.push({ name, args });
    if (name === "service_reserve_organization_external_egress") {
      return Promise.resolve(reserve);
    }
    if (name === "service_settle_organization_external_egress_evidence") {
      return Promise.resolve({
        data: settlementRow(String(args.p_outcome)),
        error: settleError,
      });
    }
    return Promise.resolve({
      data: null,
      error: { message: `unexpected rpc ${name}` },
    });
  };
}

Deno.test("a suspended organization never reaches the provider", async () => {
  const calls: RpcCall[] = [];
  let performed = 0;
  await assert.rejects(
    runAssistantEgress(
      scriptedRpc({ data: null, error: { message: "org_suspended" } }, calls),
      { orgId: ORG, runId: RUN, ttlSeconds: 120 },
      () => {
        performed += 1;
        return Promise.resolve("answer");
      },
      () => ({ code: null, body: {} }),
    ),
    (error: unknown) => error instanceof EgressReservationDeniedError,
  );
  assert.equal(performed, 0);
  // Nothing to settle: no attempt was ever started.
  assert.equal(
    calls.filter((call) =>
      call.name === "service_settle_organization_external_egress_evidence"
    ).length,
    0,
  );
});

Deno.test("an unarmed lease (egress_allowed=false) is a denial, not a permission", async () => {
  const calls: RpcCall[] = [];
  let performed = 0;
  await assert.rejects(
    runAssistantEgress(
      scriptedRpc({
        data: leaseRow({
          egress_allowed: false,
          lease_token: null,
          settled_outcome: "denied",
        }),
        error: null,
      }, calls),
      { orgId: ORG, runId: RUN, ttlSeconds: 120 },
      () => {
        performed += 1;
        return Promise.resolve("answer");
      },
      () => ({ code: null, body: {} }),
    ),
    (error: unknown) => error instanceof EgressReservationDeniedError,
  );
  assert.equal(performed, 0);
});

Deno.test("an idempotent lease on a fresh run id is a concurrent duplicate -- refused", async () => {
  const calls: RpcCall[] = [];
  let performed = 0;
  await assert.rejects(
    runAssistantEgress(
      scriptedRpc({ data: leaseRow({ idempotent: true }), error: null }, calls),
      { orgId: ORG, runId: RUN, ttlSeconds: 120 },
      () => {
        performed += 1;
        return Promise.resolve("answer");
      },
      () => ({ code: null, body: {} }),
    ),
    (error: unknown) => error instanceof EgressReservationDeniedError,
  );
  assert.equal(performed, 0);
});

Deno.test("a delivered attempt settles with its evidence before returning", async () => {
  const calls: RpcCall[] = [];
  const result = await runAssistantEgress(
    scriptedRpc({ data: leaseRow(), error: null }, calls),
    { orgId: ORG, runId: RUN, ttlSeconds: 120 },
    () => Promise.resolve("the-answer"),
    (settled) => ({
      code: settled.ok ? "assistant_run_recorded" : "assistant_run_failed",
      body: { run_id: RUN },
    }),
  );
  assert.equal(result, "the-answer");
  const reserve = calls.find((call) =>
    call.name === "service_reserve_organization_external_egress"
  );
  assert.ok(reserve);
  assert.equal(reserve.args.p_kind, ASSISTANT_EGRESS_KIND);
  assert.equal(reserve.args.p_correlation_id, RUN);
  const settle = calls.find((call) =>
    call.name === "service_settle_organization_external_egress_evidence"
  );
  assert.ok(settle);
  assert.equal(settle.args.p_outcome, "delivered");
  assert.equal(settle.args.p_evidence_code, "assistant_run_recorded");
});

Deno.test("a failed attempt settles as failed and rethrows the original error", async () => {
  const calls: RpcCall[] = [];
  const boom = new Error("provider exploded");
  await assert.rejects(
    runAssistantEgress(
      scriptedRpc({ data: leaseRow(), error: null }, calls),
      { orgId: ORG, runId: RUN, ttlSeconds: 120 },
      () => Promise.reject(boom),
      (settled) => ({
        code: settled.ok ? "assistant_run_recorded" : "assistant_run_failed",
        body: { run_id: RUN },
      }),
    ),
    (error: unknown) => error === boom,
  );
  const settle = calls.find((call) =>
    call.name === "service_settle_organization_external_egress_evidence"
  );
  assert.ok(settle);
  assert.equal(settle.args.p_outcome, "failed");
});

Deno.test("a settlement failure can never be reported as success", async () => {
  const calls: RpcCall[] = [];
  await assert.rejects(
    runAssistantEgress(
      scriptedRpc({ data: leaseRow(), error: null }, calls, {
        message: "settlement down",
      }),
      { orgId: ORG, runId: RUN, ttlSeconds: 120 },
      () => Promise.resolve("the-answer"),
      () => ({ code: null, body: {} }),
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "organization_egress_settlement_failed",
  );
});

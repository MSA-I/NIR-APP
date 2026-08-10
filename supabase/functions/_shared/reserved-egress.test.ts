import {
  EgressReservationDeniedError,
  type ReservedEgressOutcome,
  runReservedEgress,
} from "./reserved-egress.ts";

interface Lease {
  token: string;
}

Deno.test("lifecycle denial before reservation never reaches the provider", async () => {
  let providerCalls = 0;
  let settlementCalls = 0;
  let raised: unknown;

  try {
    await runReservedEgress({
      reserve: () => Promise.resolve(null),
      perform: () => {
        providerCalls++;
        return Promise.resolve("sent");
      },
      settle: () => {
        settlementCalls++;
        return Promise.resolve();
      },
    });
  } catch (error) {
    raised = error;
  }

  if (!(raised instanceof EgressReservationDeniedError)) {
    throw new Error("denied reservation did not fail closed");
  }
  if (providerCalls !== 0 || settlementCalls !== 0) {
    throw new Error(
      "denied reservation caused an external or settlement side effect",
    );
  }
});

Deno.test("lifecycle flip after provider success cannot suppress immutable settlement", async () => {
  let writable = true;
  const evidence: Array<ReservedEgressOutcome<string>> = [];

  const result = await runReservedEgress<Lease, string>({
    reserve: () => Promise.resolve(writable ? { token: "lease-1" } : null),
    perform: () => {
      writable = false;
      return Promise.resolve("provider-result");
    },
    settle: (_lease, outcome) => {
      evidence.push(outcome);
      return Promise.resolve();
    },
  });

  if (result !== "provider-result" || evidence.length !== 1) {
    throw new Error("provider success was not settled exactly once");
  }
  const recorded = evidence[0];
  if (!recorded.ok || recorded.result !== "provider-result") {
    throw new Error("provider success evidence was lost after lifecycle flip");
  }
});

Deno.test("provider failure is settled even when lifecycle flips during the call", async () => {
  let writable = true;
  const evidence: Array<ReservedEgressOutcome<string>> = [];
  const providerError = new Error("provider_timeout");
  let raised: unknown;

  try {
    await runReservedEgress<Lease, string>({
      reserve: () => Promise.resolve(writable ? { token: "lease-2" } : null),
      perform: () => {
        writable = false;
        return Promise.reject(providerError);
      },
      settle: (_lease, outcome) => {
        evidence.push(outcome);
        return Promise.resolve();
      },
    });
  } catch (error) {
    raised = error;
  }

  if (raised !== providerError || evidence.length !== 1 || evidence[0].ok) {
    throw new Error("provider failure was not settled and rethrown exactly");
  }
});

Deno.test("settlement failure after provider success can never become fake success", async () => {
  const settlementError = new Error("egress_settlement_failed");
  let raised: unknown;

  try {
    await runReservedEgress({
      reserve: () => Promise.resolve({ token: "lease-3" }),
      perform: () => Promise.resolve("sent"),
      settle: () => Promise.reject(settlementError),
    });
  } catch (error) {
    raised = error;
  }

  if (raised !== settlementError) {
    throw new Error("provider success escaped without durable settlement");
  }
});

import {
  applyInterpretationDecision,
  type DecisionRpcClient,
  supplierInterpretationContextAllowed,
} from "./index.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("expected a truthy value");
}

function assertFalse(value: unknown): void {
  if (value) throw new Error("expected a falsy value");
}

const ACTOR = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const SUPPLIER = "33333333-3333-4333-8333-333333333333";
const DOCUMENT = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const CHECKSUM = "etag:0123456789abcdef";

function context() {
  return {
    profile: {
      org_id: ORG,
      role: "supplier",
      active: true,
      supplier_id: SUPPLIER,
    },
    document: {
      id: DOCUMENT,
      org_id: ORG,
      entity_type: "supplier",
      entity_id: SUPPLIER,
      supplier_id: SUPPLIER,
      document_kind: "price_list",
      uploaded_by: ACTOR,
      storage_path: `${ORG}/supplier/${SUPPLIER}/${DOCUMENT}/prices.pdf`,
      deleted_at: null,
    },
    job: {
      id: JOB,
      org_id: ORG,
      document_id: DOCUMENT,
      status: "extracted",
      requested_by: ACTOR,
      input_checksum: CHECKSUM,
      contract_version: "1",
    },
    extraction: {
      id: "66666666-6666-4666-8666-666666666666",
      org_id: ORG,
      job_id: JOB,
      document_id: DOCUMENT,
      input_checksum: CHECKSUM,
      contract_version: "1",
    },
  };
}

Deno.test("supplier interpretation allows the exact owned price-list chain", () => {
  const value = context();
  assert(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects a different supplier", () => {
  const value = context();
  value.document.supplier_id = "77777777-7777-4777-8777-777777777777";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects cross-tenant context", () => {
  const value = context();
  value.extraction.org_id = "88888888-8888-4888-8888-888888888888";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects another uploader", () => {
  const value = context();
  value.document.uploaded_by = "99999999-9999-4999-8999-999999999999";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects a non-price-list document", () => {
  const value = context();
  value.document.document_kind = "invoice";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects a job requested by another actor", () => {
  const value = context();
  value.job.requested_by = "99999999-9999-4999-8999-999999999999";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects checksum and version drift", () => {
  const value = context();
  value.extraction.input_checksum = "etag:changed";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));

  const versionDrift = context();
  versionDrift.extraction.contract_version = "2";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    versionDrift.profile,
    versionDrift.document,
    versionDrift.job,
    versionDrift.extraction,
  ));
});

Deno.test("supplier interpretation rejects a non-canonical storage path", () => {
  const value = context();
  value.document.storage_path = `${ORG}/supplier/${SUPPLIER}/prices.pdf`;
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

// ===== Acting on the interpretation may never cost the interpretation =====
//
// The tenant has already paid for the tokens by the time this runs, and the row is saved and
// immutable. apply_document_interpretation has legitimate ways to refuse -- a suspended tenant,
// an unresolved autonomy policy, a document already filed -- and none of them are reasons to
// unwind into the handler's catch, which calls markFailed and records that the interpretation
// did not happen. So the helper must resolve for EVERY outcome, including a client that throws.

const INTERPRETATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function recordingClient(
  outcome: () => { error: { message: string } | null },
): { client: DecisionRpcClient; calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    client: {
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push([fn, args]);
        return Promise.resolve(outcome());
      },
    },
  };
}

Deno.test("the decision is called by name with the saved interpretation and the actor", async () => {
  const { client, calls } = recordingClient(() => ({ error: null }));
  await applyInterpretationDecision(client, JOB, INTERPRETATION, ACTOR);
  if (calls.length !== 1) throw new Error("expected exactly one rpc call");
  const [name, args] = calls[0];
  if (name !== "apply_document_interpretation") {
    throw new Error(`unexpected rpc name: ${name}`);
  }
  // The live signature is (p_job_id uuid, p_interpretation_id uuid, p_actor_id uuid default
  // null). A renamed argument fails as a 404 from PostgREST, not as a type error, so it is
  // asserted here rather than trusted to the compiler.
  if (
    args.p_job_id !== JOB || args.p_interpretation_id !== INTERPRETATION ||
    args.p_actor_id !== ACTOR
  ) {
    throw new Error(`unexpected rpc arguments: ${JSON.stringify(args)}`);
  }
  if (Object.keys(args).length !== 3) {
    throw new Error(`unexpected extra rpc arguments: ${JSON.stringify(args)}`);
  }
});

Deno.test("a refused decision resolves quietly and never unwinds into the failure path", async () => {
  const { client } = recordingClient(() => ({
    error: { message: "autonomy_threshold_missing" },
  }));
  // Resolving is the whole assertion: a throw here would reach the handler's catch, which calls
  // markFailed on a job whose interpretation is already stored.
  await applyInterpretationDecision(client, JOB, INTERPRETATION, ACTOR);
});

Deno.test("a client that throws outright still cannot lose the saved interpretation", async () => {
  const throwing: DecisionRpcClient = {
    rpc() {
      throw new Error("connection reset");
    },
  };
  await applyInterpretationDecision(throwing, JOB, INTERPRETATION, ACTOR);

  const rejecting: DecisionRpcClient = {
    rpc() {
      return Promise.reject(new Error("aborted"));
    },
  };
  await applyInterpretationDecision(rejecting, JOB, INTERPRETATION, ACTOR);
});

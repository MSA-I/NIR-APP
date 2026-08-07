import { createClient } from "@supabase/supabase-js";
import {
  type ApplyDecision,
  applyInterpretationDecision,
  type DecisionRpcClient,
  resumeExistingInterpretation,
  type RpcBuilder,
  type RpcResult,
  saveAndDecideInterpretation,
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
const SECOND_INTERPRETATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function stubBuilder(result: RpcResult, signals: AbortSignal[]): RpcBuilder {
  const settled = Promise.resolve(result);
  return Object.assign(settled, {
    abortSignal(signal: AbortSignal) {
      signals.push(signal);
      return settled;
    },
  });
}

interface RecordedClient {
  client: DecisionRpcClient;
  calls: Array<[string, Record<string, unknown>]>;
  signals: AbortSignal[];
}

function recordingClient(result: RpcResult): RecordedClient {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const signals: AbortSignal[] = [];
  return {
    calls,
    signals,
    client: {
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push([fn, args]);
        return stubBuilder(result, signals);
      },
    },
  };
}

function recordingApply(): { apply: ApplyDecision; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    apply: (_admin, jobId, interpretationId, actorId) => {
      calls.push([jobId, interpretationId, actorId]);
      return Promise.resolve();
    },
  };
}

Deno.test("the decision is called by name, bounded, with the interpretation and the actor", async () => {
  const { client, calls, signals } = recordingClient({
    data: { outcome: "queued_for_review", reason_code: "autonomy_disabled" },
    error: null,
  });
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
  // service_role carries no statement_timeout and no lock_timeout, and 0077 takes `for update`
  // on documents. An unbounded call here holds a 200 the tenant already paid for.
  if (signals.length !== 1 || !(signals[0] instanceof AbortSignal)) {
    throw new Error("the decision was issued without an abort signal");
  }
});

Deno.test("a successful decision reports its verdict rather than passing in silence", async () => {
  const { client } = recordingClient({
    data: {
      outcome: "auto_applied",
      reason_code: null,
      invoice_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      auto_action_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    },
    error: null,
  });
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
  try {
    await applyInterpretationDecision(client, JOB, INTERPRETATION, ACTOR);
  } finally {
    console.log = original;
  }
  // A call that just authored an invoice with no human behind it must be findable in the log,
  // AND attributable: a verdict that cannot name the document it was about cannot be acted on.
  const reported = lines.join("\n");
  for (
    const expected of [
      "auto_applied",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      JOB,
      INTERPRETATION,
    ]
  ) {
    if (!reported.includes(expected)) {
      throw new Error(`the verdict omitted ${expected}: ${reported}`);
    }
  }
});

Deno.test("a failed decision names the document it was about", async () => {
  // This line is the ONLY trace a lost decision leaves -- nothing reaches the database. One that
  // cannot be traced back to a job and an interpretation cannot be recovered from.
  const { client } = recordingClient({
    error: { message: "canceling statement due to statement timeout" },
  });
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) =>
    lines.push(parts.map(String).join(" "));
  try {
    await applyInterpretationDecision(client, JOB, INTERPRETATION, ACTOR);
  } finally {
    console.error = original;
  }
  const reported = lines.join("\n");
  if (!reported.includes(JOB) || !reported.includes(INTERPRETATION)) {
    throw new Error(`the failure was unattributable: ${reported}`);
  }
});

Deno.test("a refused decision resolves quietly and never unwinds into the failure path", async () => {
  const { client } = recordingClient({
    error: { message: "autonomy_threshold_missing" },
  });
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
      return {
        abortSignal: () => Promise.reject(new Error("aborted")),
      } as unknown as RpcBuilder;
    },
  };
  await applyInterpretationDecision(rejecting, JOB, INTERPRETATION, ACTOR);
});

// The bound, against the REAL client rather than a stand-in for it. `.abortSignal()` is a
// supabase-js contract, not ours, and the fakes above would keep passing if the client silently
// dropped it. This needs no --allow-net and so does not loosen the gate: the client is built with
// its own `global.fetch`, so the request never leaves the process and the assertion is made on
// the RequestInit supabase-js actually produced.
//
// RESIDUAL, AND BENIGN: an abort stops the client, not necessarily the statement already running
// in Postgres, so a timed-out decision may still commit server-side. 0077's collision guard plus
// the replay path find it on the next call -- the same mechanism the recovery above relies on.
Deno.test("the real client carries the bound into the request it issues", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init?.signal);
    return new Response(JSON.stringify({ outcome: "queued_for_review" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = createClient("http://127.0.0.1:1", "not-a-real-key", {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchImpl },
  });
  await applyInterpretationDecision(client, JOB, INTERPRETATION, ACTOR);
  if (signals.length !== 1) {
    throw new Error(`expected exactly one request, saw ${signals.length}`);
  }
  if (!(signals[0] instanceof AbortSignal)) {
    throw new Error("supabase-js dropped the abort signal before the request");
  }
});

// ===== The wiring itself, not only the parts =====
//
// Every test above passes with the decision disconnected from the pipeline entirely. The handler
// cannot be driven here -- it reads Deno.env before anything else and the gate runs `deno test`
// with no permissions -- so the post-save step and the replay step are exported and pinned
// directly. Deleting either call inside them fails here rather than shipping green.

Deno.test("a saved interpretation is offered to the decision exactly once", async () => {
  const { client } = recordingClient({ data: INTERPRETATION, error: null });
  const { apply, calls } = recordingApply();
  const persisted = await saveAndDecideInterpretation({
    admin: client,
    isSupplier: false,
    jobId: JOB,
    actorId: ACTOR,
    args: { p_job_id: JOB },
    findExisting: () => Promise.resolve(null),
    apply,
  });
  if (persisted.interpretationId !== INTERPRETATION || persisted.idempotent) {
    throw new Error(`unexpected persistence result: ${JSON.stringify(persisted)}`);
  }
  // The id passed on must be the one the save returned, not the job and not the request.
  if (
    calls.length !== 1 || calls[0][0] !== JOB ||
    calls[0][1] !== INTERPRETATION || calls[0][2] !== ACTOR
  ) {
    throw new Error(`the decision was not offered the saved id: ${JSON.stringify(calls)}`);
  }
});

Deno.test("a supplier price list is never offered to the decision", async () => {
  const { client } = recordingClient({ data: INTERPRETATION, error: null });
  const { apply, calls } = recordingApply();
  await saveAndDecideInterpretation({
    admin: client,
    isSupplier: true,
    jobId: JOB,
    actorId: ACTOR,
    args: { p_job_id: JOB },
    findExisting: () => Promise.resolve(null),
    apply,
  });
  if (calls.length !== 0) {
    throw new Error("a supplier price list reached the decision layer");
  }
});

Deno.test("a save that failed but committed still reaches the decision", async () => {
  // The narrow door into the same permanent loss the replay path exists to prevent: the save
  // COMMITTED and reported a failure anyway (a transport error, or a message matching none of
  // the known conflicts), so the row exists, the client is handed a 200, and nothing will ever
  // ask again -- the review screen's trigger is already false.
  const { client } = recordingClient({
    data: null,
    error: { message: "fetch failed" },
  });
  const { apply, calls } = recordingApply();
  const persisted = await saveAndDecideInterpretation({
    admin: client,
    isSupplier: false,
    jobId: JOB,
    actorId: ACTOR,
    args: { p_job_id: JOB },
    findExisting: () => Promise.resolve(SECOND_INTERPRETATION),
    apply,
  });
  if (!persisted.idempotent || persisted.interpretationId !== SECOND_INTERPRETATION) {
    throw new Error(`unexpected recovery result: ${JSON.stringify(persisted)}`);
  }
  // The id offered must be the one that was FOUND, not the one that failed to come back.
  if (calls.length !== 1 || calls[0][1] !== SECOND_INTERPRETATION) {
    throw new Error(`the recovered interpretation was left undecided: ${JSON.stringify(calls)}`);
  }
});

Deno.test("a supplier save that failed but committed still stays out of the decision", async () => {
  const { client } = recordingClient({
    data: null,
    error: { message: "fetch failed" },
  });
  const { apply, calls } = recordingApply();
  await saveAndDecideInterpretation({
    admin: client,
    isSupplier: true,
    jobId: JOB,
    actorId: ACTOR,
    args: { p_job_id: JOB },
    findExisting: () => Promise.resolve(SECOND_INTERPRETATION),
    apply,
  });
  if (calls.length !== 0) {
    throw new Error("a supplier price list reached the decision layer");
  }
});

Deno.test("an interpretation that failed to save is never offered to the decision", async () => {
  const { client } = recordingClient({
    data: null,
    error: { message: "document_interpretation_conflict" },
  });
  const { apply, calls } = recordingApply();
  let raised = false;
  try {
    await saveAndDecideInterpretation({
      admin: client,
      isSupplier: false,
      jobId: JOB,
      actorId: ACTOR,
      args: { p_job_id: JOB },
      findExisting: () => Promise.resolve(null),
      apply,
    });
  } catch {
    raised = true;
  }
  if (!raised) throw new Error("a save conflict should still fail the request");
  if (calls.length !== 0) {
    throw new Error("a decision was taken on an interpretation that was never saved");
  }
});

Deno.test("a replay re-offers the decision, because nothing else ever will", async () => {
  const { client } = recordingClient({ data: null, error: null });
  const { apply, calls } = recordingApply();
  const replayed = await resumeExistingInterpretation({
    admin: client,
    isSupplier: false,
    jobId: JOB,
    actorId: ACTOR,
    context: {
      already_interpreted: true,
      interpretation_id: SECOND_INTERPRETATION,
    },
    apply,
  });
  if (replayed !== SECOND_INTERPRETATION) {
    throw new Error(`the replay lost the interpretation id: ${replayed}`);
  }
  // A decision lost to a transient failure leaves nothing in the database and no product path
  // that would come back for it. This call is the retry.
  if (calls.length !== 1 || calls[0][1] !== SECOND_INTERPRETATION) {
    throw new Error(`the replay did not re-offer the decision: ${JSON.stringify(calls)}`);
  }
});

Deno.test("a replay of a supplier price list stays out of the decision layer", async () => {
  const { client } = recordingClient({ data: null, error: null });
  const { apply, calls } = recordingApply();
  const replayed = await resumeExistingInterpretation({
    admin: client,
    isSupplier: true,
    jobId: JOB,
    actorId: ACTOR,
    context: { already_interpreted: true, interpretation_id: INTERPRETATION },
    apply,
  });
  if (replayed !== INTERPRETATION) throw new Error("the replay lost the id");
  if (calls.length !== 0) {
    throw new Error("a supplier replay reached the decision layer");
  }
});

Deno.test("a first run is not a replay and decides nothing before the interpretation exists", async () => {
  const { client } = recordingClient({ data: null, error: null });
  const { apply, calls } = recordingApply();
  const replayed = await resumeExistingInterpretation({
    admin: client,
    isSupplier: false,
    jobId: JOB,
    actorId: ACTOR,
    context: { already_interpreted: false },
    apply,
  });
  if (replayed !== null) throw new Error("a first run was mistaken for a replay");
  if (calls.length !== 0) {
    throw new Error("a decision was taken before any interpretation existed");
  }
});

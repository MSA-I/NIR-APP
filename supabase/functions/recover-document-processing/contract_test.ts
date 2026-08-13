import assert from "node:assert/strict";
import {
  databaseErrorCode,
  isRecoveryResult,
  parseRecoveryRequest,
  RequestValidationError,
  shouldInvokeInterpretDocument,
} from "./core.ts";
import {
  createRecoveryHandler,
  DATABASE_TIMEOUT_MS,
  INTERPRET_DOCUMENT_TIMEOUT_MS,
  type RecoveryHandlerDependencies,
} from "./index.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const RESULT_JOB = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";

const result = {
  outcome: "requeued" as const,
  old_job_id: JOB,
  job_id: RESULT_JOB,
  stuck_reason: "active_over_two_hours",
  idempotent: false,
};

interface Calls {
  user: unknown[];
  profile: unknown[];
  recover: unknown[];
  interpret: unknown[];
}

function dependencies(
  overrides: Partial<RecoveryHandlerDependencies> = {},
): { dependencies: RecoveryHandlerDependencies; calls: Calls } {
  const calls: Calls = { user: [], profile: [], recover: [], interpret: [] };
  const values: Record<string, string> = {
    SUPABASE_URL: "http://127.0.0.1:55431",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    INTERPRET_DOCUMENT_CRON_SECRET: "cron-secret",
    APP_BASE_URL: "http://127.0.0.1:5199",
  };
  const defaults: RecoveryHandlerDependencies = {
    getEnv: (name) => values[name],
    getUser: (input) => {
      calls.user.push(input);
      return Promise.resolve({ id: USER, error: false });
    },
    getProfile: (input) => {
      calls.profile.push(input);
      return Promise.resolve({
        data: { org_id: "org", role: "owner", active: true },
        error: null,
      });
    },
    recover: (input) => {
      calls.recover.push(input);
      return Promise.resolve({ data: result, error: null });
    },
    invokeInterpretDocument: (input) => {
      calls.interpret.push(input);
      return Promise.resolve(true);
    },
  };
  return { dependencies: { ...defaults, ...overrides }, calls };
}

function request(
  body: unknown = { job_id: JOB, request_id: REQUEST, reason: "  מסמך תקוע  " },
  init: RequestInit = {},
): Request {
  return new Request(
    "http://127.0.0.1/functions/v1/recover-document-processing",
    {
      method: "POST",
      headers: {
        authorization: "Bearer user-token",
        "content-type": "application/json",
        origin: "http://127.0.0.1:5199",
      },
      body: JSON.stringify(body),
      ...init,
    },
  );
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

Deno.test("recovery request is exact, trims reason and accepts the SQL limit", () => {
  assert.deepEqual(
    parseRecoveryRequest({
      job_id: JOB,
      request_id: REQUEST,
      reason: "  מסמך תקוע מעל שעתיים  ",
    }),
    {
      job_id: JOB,
      request_id: REQUEST,
      reason: "מסמך תקוע מעל שעתיים",
    },
  );
  assert.equal(
    parseRecoveryRequest({
      job_id: JOB,
      request_id: REQUEST,
      reason: "א".repeat(1000),
    }).reason.length,
    1000,
  );

  for (
    const invalid of [
      { jobId: JOB, requestId: REQUEST, reason: "תקוע" },
      { job_id: JOB, request_id: "retry-1", reason: "תקוע" },
      { job_id: JOB, request_id: REQUEST, reason: "" },
      { job_id: JOB, request_id: REQUEST, reason: "א".repeat(1001) },
      { job_id: JOB, request_id: REQUEST, reason: "תקוע", force: true },
    ]
  ) {
    assert.throws(
      () => parseRecoveryRequest(invalid),
      (error) => error instanceof RequestValidationError,
    );
  }
});

Deno.test("recovery result accepts only the four snake-case backend outcomes and exact public shape", () => {
  for (
    const outcome of [
      "requeued",
      "extraction_recovered",
      "resume_interpretation",
      "interpretation_recovered",
    ]
  ) {
    assert.equal(isRecoveryResult({ ...result, outcome }), true);
  }
  for (
    const invalid of [
      { ...result, outcome: "already_recovered" },
      { ...result, job_id: "not-a-uuid" },
      { ...result, internal: "provider evidence must not leak" },
      { ...result, stuck_reason: null },
      { ...result, stuck_reason: "postgres_internal_reason" },
    ]
  ) {
    assert.equal(isRecoveryResult(invalid), false);
  }
});

Deno.test("every recovered extraction or interpretation is handed to the idempotent decision path", () => {
  assert.equal(shouldInvokeInterpretDocument("extraction_recovered"), true);
  assert.equal(shouldInvokeInterpretDocument("resume_interpretation"), true);
  assert.equal(
    shouldInvokeInterpretDocument("interpretation_recovered"),
    true,
  );
  assert.equal(shouldInvokeInterpretDocument("requeued"), false);
});

Deno.test("database errors map to stable non-leaking HTTP codes", () => {
  assert.equal(
    databaseErrorCode({ code: "42501", message: "secret detail" }),
    "not_authorized",
  );
  assert.equal(
    databaseErrorCode({ code: "23505", message: "duplicate" }),
    "request_conflict",
  );
  assert.equal(
    databaseErrorCode({
      message: "document_processing_egress_active: provider-internal",
    }),
    "recovery_in_progress",
  );
  assert.equal(
    databaseErrorCode({ code: "55000", message: "state" }),
    "job_not_recoverable",
  );
  assert.equal(
    databaseErrorCode({ code: "P0002", message: "document_unknown" }),
    "job_not_recoverable",
  );
  assert.equal(
    databaseErrorCode({
      code: "22023",
      message: "document_processing_source_changed",
    }),
    "job_not_recoverable",
  );
  assert.equal(
    databaseErrorCode({ code: "XX000", message: "internal" }),
    "service_unavailable",
  );
  assert.equal(
    databaseErrorCode({ code: "42501", message: "organization_read_only" }),
    "organization_read_only",
  );
});

Deno.test("handler rejects non-POST, missing auth and invalid JSON before owner or recovery calls", async () => {
  const built = dependencies();
  const handler = createRecoveryHandler(built.dependencies);

  const get = await handler(
    new Request("http://local/recover", { method: "GET" }),
  );
  assert.equal(get.status, 400);

  const unauthenticated = await handler(request(undefined, {
    headers: { "content-type": "application/json" },
  }));
  assert.equal(unauthenticated.status, 401);

  const invalid = await handler(
    new Request("http://local/recover", {
      method: "POST",
      headers: {
        authorization: "Bearer user-token",
        "content-type": "application/json",
      },
      body: "{",
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal(built.calls.user.length, 1);
  assert.equal(built.calls.profile.length, 0);
  assert.equal(built.calls.recover.length, 0);
});

Deno.test("handler requires an authenticated active owner before the service RPC", async () => {
  const unauthenticated = dependencies({
    getUser: () => Promise.resolve({ id: null, error: true }),
  });
  const rejectedUser = await createRecoveryHandler(
    unauthenticated.dependencies,
  )(request());
  assert.equal(rejectedUser.status, 401);
  assert.equal(unauthenticated.calls.profile.length, 0);
  assert.equal(unauthenticated.calls.recover.length, 0);

  const office = dependencies({
    getProfile: (input) => {
      office.calls.profile.push(input);
      return Promise.resolve({
        data: { org_id: "org", role: "office", active: true },
        error: null,
      });
    },
  });
  const rejectedOffice = await createRecoveryHandler(office.dependencies)(
    request(),
  );
  assert.equal(rejectedOffice.status, 403);
  assert.equal(office.calls.recover.length, 0);
});

Deno.test("handler maps the stable request and authenticated actor to the service-only recovery RPC", async () => {
  const built = dependencies();
  const response = await createRecoveryHandler(built.dependencies)(request());
  assert.equal(response.status, 200);
  assert.deepEqual(built.calls.recover, [{
    url: "http://127.0.0.1:55431",
    serviceKey: "service",
    jobId: JOB,
    actorId: USER,
    requestId: REQUEST,
    reason: "מסמך תקוע",
  }]);
  assert.deepEqual(await json(response), {
    outcome: "requeued",
    job_id: RESULT_JOB,
    idempotent: false,
  });
});

Deno.test("handler rejects response internals and never reflects database error text", async () => {
  const internal = dependencies({
    recover: () =>
      Promise.resolve({
        data: { ...result, provider_payload: { secret: true } },
        error: null,
      }),
  });
  const rejectedInternal = await createRecoveryHandler(internal.dependencies)(
    request(),
  );
  assert.equal(rejectedInternal.status, 503);
  assert.equal(
    JSON.stringify(await json(rejectedInternal)).includes("provider_payload"),
    false,
  );

  const valid = dependencies();
  const publicResponse = await createRecoveryHandler(valid.dependencies)(
    request(),
  );
  const publicBody = await json(publicResponse);
  assert.deepEqual(Object.keys(publicBody).sort(), [
    "idempotent",
    "job_id",
    "outcome",
  ]);
  assert.equal("old_job_id" in publicBody, false);
  assert.equal("stuck_reason" in publicBody, false);

  const database = dependencies({
    recover: () =>
      Promise.resolve({
        data: null,
        error: {
          code: "XX000",
          message: "postgres host, SQL and provider token must stay internal",
        },
      }),
  });
  const failed = await createRecoveryHandler(database.dependencies)(request());
  const failedBody = JSON.stringify(await json(failed));
  assert.equal(failed.status, 503);
  assert.equal(failedBody.includes("postgres"), false);
  assert.equal(failedBody.includes("provider token"), false);
  assert.equal(failedBody.includes("שירות שחזור העיבוד"), true);
});

Deno.test("handler invokes interpret-document for every outcome with existing evidence", async () => {
  for (
    const [outcome, expectedCalls] of [
      ["requeued", 0],
      ["interpretation_recovered", 1],
      ["extraction_recovered", 1],
      ["resume_interpretation", 1],
    ] as const
  ) {
    const built = dependencies({
      recover: (input) => {
        built.calls.recover.push(input);
        return Promise.resolve({ data: { ...result, outcome }, error: null });
      },
    });
    const response = await createRecoveryHandler(built.dependencies)(request());
    assert.equal(response.status, 200, outcome);
    assert.equal(built.calls.interpret.length, expectedCalls, outcome);
    if (expectedCalls === 1) {
      assert.deepEqual(built.calls.interpret[0], {
        url: "http://127.0.0.1:55431",
        anonKey: "anon",
        cronSecret: "cron-secret",
        jobId: RESULT_JOB,
      });
    }
  }
});

Deno.test("a failed interpretation handoff is retryable through the stable recovery request", async () => {
  const built = dependencies({
    recover: () =>
      Promise.resolve({
        data: { ...result, outcome: "resume_interpretation", idempotent: true },
        error: null,
      }),
    invokeInterpretDocument: () => Promise.resolve(false),
  });
  const response = await createRecoveryHandler(built.dependencies)(request());
  assert.equal(response.status, 503);
  assert.equal(
    JSON.stringify(await json(response)).includes("interpret-document"),
    false,
  );
});

Deno.test("production wiring uses the owner projection, canonical RPC arguments and cron handoff", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assert.ok(source.includes('.select("org_id,role,active")'));
  assert.ok(source.includes('"service_recover_stuck_document_processing"'));
  for (
    const mapping of [
      "p_job_id: jobId",
      "p_actor_id: actorId",
      "p_request_id: requestId",
      "p_reason: reason",
    ]
  ) assert.ok(source.includes(mapping), mapping);
  assert.ok(source.includes("/functions/v1/interpret-document"));
  assert.ok(source.includes('"x-interpret-cron-secret": cronSecret'));
  assert.equal(DATABASE_TIMEOUT_MS, 15_000);
  assert.equal(INTERPRET_DOCUMENT_TIMEOUT_MS, 70_000);
  assert.equal(
    source.includes("AbortSignal.timeout(INTERPRET_DOCUMENT_TIMEOUT_MS)"),
    true,
  );
});

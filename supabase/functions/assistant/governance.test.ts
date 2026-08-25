// The provider-governance gate, proved by refusal (OPEN-DECISIONS #179).
//
// #179 is not a preference: the assistant stays OFF until training use, retention, provider
// logs, DPA and data region are each verified and documented for OpenAI. Five rows, all
// mandatory, and a missing row is a refusal -- never a warning that a deploy can ride past.
// These cases therefore spend most of their length on the NEGATIVE side: an allow is one
// arrangement, and every other arrangement must fail closed.
//
// No permissions are requested on purpose. CI runs this directory with `--allow-env` only
// (quality-gate.yml, "Assistant authorization, egress, validation, tool and provider
// contracts"), so a case that reads a file or a clock would fail there and nowhere else.
import assert from "node:assert/strict";
import {
  assertGovernedProviderConstruction,
  assertProviderGovernance,
  GOVERNANCE_ENV_VARS,
  GOVERNANCE_ROWS,
  type GovernanceRow,
  type GovernanceEvidenceRow,
  GOVERNED_PROVIDER,
  PRELAUNCH_EXCEPTION_ENV_VAR,
  type PrelaunchException,
  ProviderGovernanceRefusedError,
  type ProviderGovernanceEvidence,
  readPrelaunchException,
  readProviderGovernanceEvidence,
} from "./governance.ts";

/**
 * A row that satisfies every mandatory field. Deliberately NOT a claim about what OpenAI's
 * terms actually say -- these are shapes, and the real dated evidence lives in
 * docs/ASSISTANT-ACTIVATION-EVIDENCE.md where a human signs for it.
 */
function verifiedRow(overrides: Partial<GovernanceEvidenceRow> = {}): GovernanceEvidenceRow {
  return {
    status: "VERIFIED",
    claim: "test_claim",
    source: "https://example.test/policy",
    retrieved: "2026-08-24",
    verifier: "test-verifier",
    contract: null,
    ...overrides,
  };
}

function completeEvidence(
  overrides: Partial<Record<GovernanceRow, GovernanceEvidenceRow | null>> = {},
  provider: string = GOVERNED_PROVIDER,
): ProviderGovernanceEvidence {
  const rows = {} as Record<GovernanceRow, GovernanceEvidenceRow | null>;
  for (const row of GOVERNANCE_ROWS) rows[row] = verifiedRow();
  return { provider, rows: { ...rows, ...overrides } };
}

Deno.test("five verified rows for the governed provider allow the boundary", () => {
  const decision = assertProviderGovernance(completeEvidence());
  assert.equal(decision.allowed, true);
  if (!decision.allowed) return;
  assert.equal(decision.provider, GOVERNED_PROVIDER);
  assert.deepEqual(Object.keys(decision.rows).sort(), [...GOVERNANCE_ROWS].sort());
});

Deno.test("the five rows are exactly the five #179 names, in code and in configuration", () => {
  assert.deepEqual([...GOVERNANCE_ROWS], [
    "training_use",
    "retention",
    "provider_logs",
    "dpa",
    "data_region",
  ]);
  // Every row has a configuration key: a row nobody can supply is a gate nobody can pass.
  for (const row of GOVERNANCE_ROWS) {
    assert.equal(typeof GOVERNANCE_ENV_VARS[row], "string");
    assert.ok(GOVERNANCE_ENV_VARS[row].startsWith("AI_ASSISTANT_GOVERNANCE_"));
  }
});

Deno.test("each row missing in turn refuses, and the refusal names that row", () => {
  for (const missing of GOVERNANCE_ROWS) {
    const decision = assertProviderGovernance(completeEvidence({ [missing]: null }));
    assert.equal(decision.allowed, false, `${missing} absent must refuse`);
    if (decision.allowed) continue;
    assert.deepEqual(decision.unmet.map((entry) => entry.row), [missing]);
    assert.ok(
      decision.reason.includes(missing),
      `refusal must name ${missing}, got ${decision.reason}`,
    );
    // The other four rows are fine; naming them would send the operator to the wrong file.
    for (const other of GOVERNANCE_ROWS) {
      if (other !== missing) assert.ok(!decision.reason.includes(other));
    }
  }
});

Deno.test("a row present but not VERIFIED refuses and carries its status", () => {
  for (const status of ["MISSING", "CONTRADICTED"] as const) {
    const decision = assertProviderGovernance(
      completeEvidence({ dpa: verifiedRow({ status }) }),
    );
    assert.equal(decision.allowed, false);
    if (decision.allowed) continue;
    assert.deepEqual(decision.unmet, [{ row: "dpa", cause: `status_${status}` }]);
  }
});

Deno.test("all five absent refuses once, naming all five", () => {
  const empty: ProviderGovernanceEvidence = { provider: GOVERNED_PROVIDER, rows: {} };
  const decision = assertProviderGovernance(empty);
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.deepEqual(decision.unmet.map((entry) => entry.row), [...GOVERNANCE_ROWS]);
});

Deno.test("a zero-retention claim without a contract reference is refused, row otherwise complete", () => {
  // #179, verbatim: zero retention is never promised without a contract that proves it. The row
  // here is VERIFIED, sourced, dated and signed -- and still refused, because the only thing that
  // can carry that promise is a contract.
  const decision = assertProviderGovernance(
    completeEvidence({ retention: verifiedRow({ claim: "zero_retention", contract: null }) }),
  );
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.deepEqual(decision.unmet, [
    { row: "retention", cause: "zero_retention_without_contract" },
  ]);
});

Deno.test("a filler contract reference does not buy a zero-retention claim", () => {
  for (const filler of ["none", "N/A", "tbd", "pending", "-"]) {
    const decision = assertProviderGovernance(
      completeEvidence({
        retention: verifiedRow({ claim: "zero_retention", contract: filler }),
      }),
    );
    assert.equal(decision.allowed, false, `contract=${filler} must not pass`);
  }
});

Deno.test("zero retention with a real contract reference is allowed", () => {
  const decision = assertProviderGovernance(
    completeEvidence({
      retention: verifiedRow({ claim: "zero_retention", contract: "ZDR-2026-0142" }),
    }),
  );
  assert.equal(decision.allowed, true);
});

Deno.test("the zero-retention rule is not specific to the retention row", () => {
  // provider_logs is the other row where "we are not kept" is tempting to write.
  const decision = assertProviderGovernance(
    completeEvidence({ provider_logs: verifiedRow({ claim: "zero_retention" }) }),
  );
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.deepEqual(decision.unmet, [
    { row: "provider_logs", cause: "zero_retention_without_contract" },
  ]);
});

Deno.test("standard retention, disclosed honestly, is allowed -- #179 permits it", () => {
  const decision = assertProviderGovernance(
    completeEvidence({ retention: verifiedRow({ claim: "standard_retention_30_days" }) }),
  );
  assert.equal(decision.allowed, true);
});

Deno.test("an unsourced, undated or unsigned row is refused", () => {
  const cases: [Partial<GovernanceEvidenceRow>, string][] = [
    [{ source: "" }, "source_missing"],
    [{ source: "openai policies page" }, "source_not_a_url"],
    [{ source: "http://example.test/policy" }, "source_not_a_url"],
    [{ source: "tbd" }, "source_missing"],
    [{ retrieved: "" }, "retrieval_date_missing"],
    [{ retrieved: "24.08.2026" }, "retrieval_date_malformed"],
    [{ retrieved: "2026-13-01" }, "retrieval_date_malformed"],
    [{ verifier: "" }, "verifier_unnamed"],
    [{ verifier: "unknown" }, "verifier_unnamed"],
    [{ claim: "" }, "claim_missing"],
  ];
  for (const [override, cause] of cases) {
    const decision = assertProviderGovernance(
      completeEvidence({ training_use: verifiedRow(override) }),
    );
    assert.equal(decision.allowed, false, `${JSON.stringify(override)} must refuse`);
    if (decision.allowed) continue;
    assert.deepEqual(decision.unmet, [{ row: "training_use", cause }]);
  }
});

Deno.test("a refusal never falls through to a second vendor", () => {
  // #179: there is no backup provider. Complete, verified evidence for a DIFFERENT vendor is
  // still a refusal -- evidence is not transferable, and a second vendor is a sub-processor
  // change (#124), not a runtime decision.
  const decision = assertProviderGovernance(completeEvidence({}, "anthropic"));
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.deepEqual(decision.unmet, [{ row: "provider", cause: "provider_not_governed" }]);

  // And the refusal itself must not read as a suggestion. Nothing the gate emits may name a
  // vendor other than the one governance covers -- an operator reading this line must find no
  // alternative in it, not even the name of the one that was tried.
  const emitted = JSON.stringify(decision).toLowerCase();
  for (const vendor of ["anthropic", "google", "gemini", "azure", "mistral", "cohere", "llama"]) {
    assert.ok(!emitted.includes(vendor), `refusal must not name ${vendor}`);
  }
});

Deno.test("an incomplete decision cannot be handed to provider construction", () => {
  const refusal = assertProviderGovernance(completeEvidence({ dpa: null }));
  assert.throws(
    () => assertGovernedProviderConstruction(refusal),
    ProviderGovernanceRefusedError,
  );
  assertGovernedProviderConstruction(assertProviderGovernance(completeEvidence()));
});

Deno.test("construction re-checks the rows it is handed, not just the allow flag", () => {
  // Defence in depth against the refactor that keeps the flag and loosens the parse: the
  // construction site revalidates the evidence carried inside the decision.
  const tampered = {
    allowed: true as const,
    provider: GOVERNED_PROVIDER,
    rows: {
      ...completeEvidence().rows,
      retention: verifiedRow({ claim: "zero_retention" }),
    } as Record<GovernanceRow, GovernanceEvidenceRow>,
  };
  assert.throws(
    () => assertGovernedProviderConstruction(tampered),
    ProviderGovernanceRefusedError,
  );
});

Deno.test("configuration is read fail-closed: unset is absent, malformed is a refusal", () => {
  const supplied: Record<string, string> = {
    [GOVERNANCE_ENV_VARS.training_use]:
      "status=VERIFIED;claim=no_training_on_api_data;source=https://example.test/a;retrieved=2026-08-24;verifier=owner",
  };
  const evidence = readProviderGovernanceEvidence(
    (name) => supplied[name],
    GOVERNED_PROVIDER,
  );
  assert.equal(evidence.rows.training_use?.claim, "no_training_on_api_data");
  assert.equal(evidence.rows.dpa, null);

  const decision = assertProviderGovernance(evidence);
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.deepEqual(decision.unmet.map((entry) => entry.row), [
    "retention",
    "provider_logs",
    "dpa",
    "data_region",
  ]);
});

Deno.test("a typo in an evidence field is a refusal, not a silently dropped field", () => {
  const supplied: Record<string, string> = {
    [GOVERNANCE_ENV_VARS.dpa]:
      "status=VERIFIED;clam=signed;source=https://example.test/dpa;retrieved=2026-08-24;verifier=owner",
  };
  const evidence = readProviderGovernanceEvidence(
    (name) => supplied[name],
    GOVERNED_PROVIDER,
  );
  const decision = assertProviderGovernance(evidence);
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.ok(
    decision.unmet.some((entry) => entry.row === "dpa" && entry.cause === "row_unparsable"),
    decision.reason,
  );
});

Deno.test("a fully configured environment allows, and the read is deterministic", () => {
  const supplied: Record<string, string> = {};
  for (const row of GOVERNANCE_ROWS) {
    supplied[GOVERNANCE_ENV_VARS[row]] =
      `status=VERIFIED;claim=${row}_documented;source=https://example.test/${row};retrieved=2026-08-24;verifier=owner`;
  }
  const read = () => readProviderGovernanceEvidence((name) => supplied[name], GOVERNED_PROVIDER);
  assert.deepEqual(read(), read());
  assert.equal(assertProviderGovernance(read()).allowed, true);
  // Same input, same answer -- twice in a row, with no clock and no I/O between them.
  assert.deepEqual(assertProviderGovernance(read()), assertProviderGovernance(read()));
});

// ---------------------------------------------------------------------------------------------
// The pre-launch exception (OPEN-DECISIONS #271, owner ruling 25.08.2026).
//
// The exception exists because no company is registered, so no DPA can be executed -- there is no
// counterparty, not an unsigned form. It waives ONE row, for ONE organisation, until ONE date.
// Everything below is the negative side of that sentence, because a waiver whose bounds are not
// tested is a waiver without bounds.

const OWNER_ORG = "11111111-2222-3333-4444-555555555555";
const OTHER_ORG = "99999999-8888-7777-6666-555555555555";

function exception(overrides: Partial<PrelaunchException> = {}): PrelaunchException {
  return { until: "2026-12-31", organizationId: OWNER_ORG, reason: "pre_launch_owner_org", ...overrides };
}

/** A fixed instant, injected everywhere: a case that read the real clock would rot on its own. */
const BEFORE_EXPIRY = new Date("2026-08-25T00:00:00Z");
const AFTER_EXPIRY = new Date("2027-01-01T00:00:00Z");

Deno.test("the exception waives an absent dpa row, and says so on the decision", () => {
  const decision = assertProviderGovernance(completeEvidence({ dpa: null }), {
    exception: exception(),
    now: BEFORE_EXPIRY,
  });
  assert.ok(decision.allowed);
  assert.equal(decision.prelaunchException?.organizationId, OWNER_ORG);
  // The waiver must never launder the row into evidence: /privacy is derived from these rows,
  // and a VERIFIED dpa here would become a false statement to a customer.
  assert.equal(decision.rows.dpa.status, "MISSING");
});

Deno.test("the exception waives a dpa row that is present and MISSING", () => {
  const decision = assertProviderGovernance(
    completeEvidence({ dpa: { ...verifiedRow(), status: "MISSING" } }),
    { exception: exception(), now: BEFORE_EXPIRY },
  );
  assert.ok(decision.allowed);
  assert.equal(decision.rows.dpa.status, "MISSING");
});

Deno.test("a CONTRADICTED dpa row is never waivable", () => {
  // "Nobody supplied one" and "we checked and the answer is no" are different facts. Only the
  // first is what the owner ruled on.
  const decision = assertProviderGovernance(
    completeEvidence({ dpa: { ...verifiedRow(), status: "CONTRADICTED" } }),
    { exception: exception(), now: BEFORE_EXPIRY },
  );
  assert.ok(!decision.allowed);
  assert.match(decision.reason, /prelaunch_exception_not_for_this_cause/);
});

Deno.test("the exception covers dpa only -- a second unmet row still refuses", () => {
  const decision = assertProviderGovernance(
    completeEvidence({ dpa: null, retention: null }),
    { exception: exception(), now: BEFORE_EXPIRY },
  );
  assert.ok(!decision.allowed);
  assert.match(decision.reason, /prelaunch_exception_covers_dpa_only/);
  assert.match(decision.reason, /retention=row_absent/);
});

Deno.test("an expired exception refuses with no code change", () => {
  const decision = assertProviderGovernance(completeEvidence({ dpa: null }), {
    exception: exception(),
    now: AFTER_EXPIRY,
  });
  assert.ok(!decision.allowed);
  assert.match(decision.reason, /prelaunch_exception_expired/);
});

Deno.test("the last day is inclusive and the day after is not", () => {
  const onLastDay = assertProviderGovernance(completeEvidence({ dpa: null }), {
    exception: exception({ until: "2026-12-31" }),
    now: new Date("2026-12-31T23:59:59Z"),
  });
  assert.ok(onLastDay.allowed);
  const nextDay = assertProviderGovernance(completeEvidence({ dpa: null }), {
    exception: exception({ until: "2026-12-31" }),
    now: new Date("2027-01-01T00:00:00Z"),
  });
  assert.ok(!nextDay.allowed);
});

Deno.test("no exception configured means the dpa row refuses exactly as before", () => {
  const decision = assertProviderGovernance(completeEvidence({ dpa: null }), {
    exception: null,
    now: BEFORE_EXPIRY,
  });
  assert.ok(!decision.allowed);
  assert.match(decision.reason, /dpa=row_absent/);
  assert.ok(!decision.reason.includes("prelaunch"));
});

Deno.test("construction binds the waiver to one organisation", () => {
  const decision = assertProviderGovernance(completeEvidence({ dpa: null }), {
    exception: exception(),
    now: BEFORE_EXPIRY,
  });
  assert.ok(decision.allowed);

  // The organisation it was granted to proceeds.
  assertGovernedProviderConstruction(decision, { organizationId: OWNER_ORG, now: BEFORE_EXPIRY });

  // Any other organisation does not -- this is the bound that keeps a customer who signs up
  // tomorrow from being swept under an arrangement that was never about them.
  assert.throws(
    () => assertGovernedProviderConstruction(decision, { organizationId: OTHER_ORG, now: BEFORE_EXPIRY }),
    ProviderGovernanceRefusedError,
  );
  // And an unknown organisation is not a pass-through.
  assert.throws(
    () => assertGovernedProviderConstruction(decision, { now: BEFORE_EXPIRY }),
    ProviderGovernanceRefusedError,
  );
});

Deno.test("construction re-checks expiry, so a warm isolate cannot outlive the date", () => {
  // Parsed while valid, constructed after midnight on the end date.
  const decision = assertProviderGovernance(completeEvidence({ dpa: null }), {
    exception: exception(),
    now: BEFORE_EXPIRY,
  });
  assert.ok(decision.allowed);
  assert.throws(
    () => assertGovernedProviderConstruction(decision, { organizationId: OWNER_ORG, now: AFTER_EXPIRY }),
    ProviderGovernanceRefusedError,
  );
});

Deno.test("a fully verified decision needs no organisation and carries no exception", () => {
  const decision = assertProviderGovernance(completeEvidence(), { now: BEFORE_EXPIRY });
  assert.ok(decision.allowed);
  assert.equal(decision.prelaunchException, undefined);
  assertGovernedProviderConstruction(decision, { now: BEFORE_EXPIRY });
});

Deno.test("the exception is read fail-closed: absent, valid, and unparsable are three answers", () => {
  assert.equal(readPrelaunchException(() => undefined).kind, "absent");
  assert.equal(readPrelaunchException(() => "   ").kind, "absent");

  const valid = readPrelaunchException((name) =>
    name === PRELAUNCH_EXCEPTION_ENV_VAR
      ? `until=2026-12-31;org=${OWNER_ORG};reason=pre_launch_owner_org`
      : undefined
  );
  assert.equal(valid.kind, "valid");
  if (valid.kind === "valid") {
    assert.equal(valid.exception.until, "2026-12-31");
    assert.equal(valid.exception.organizationId, OWNER_ORG);
  }

  // Each of these is a way an operator can believe an exception is live when it is not, so each
  // must be reported rather than read as "absent".
  const malformed = [
    `until=31/12/2026;org=${OWNER_ORG};reason=x`, // not ISO
    `until=2026-13-01;org=${OWNER_ORG};reason=x`, // impossible month
    `until=2026-12-31;org=not-a-uuid;reason=x`,
    `until=2026-12-31;org=${OWNER_ORG}`, // reason missing
    `until=2026-12-31;org=${OWNER_ORG};reason=tbd`, // placeholder is not a reason
    `until=2026-12-31;org=${OWNER_ORG};reason=x;until=2027-01-01`, // duplicated key
    `until=2026-12-31;org=${OWNER_ORG};reason=x;scope=everything`, // unknown key
  ];
  for (const raw of malformed) {
    const read = readPrelaunchException((name) =>
      name === PRELAUNCH_EXCEPTION_ENV_VAR ? raw : undefined
    );
    assert.equal(read.kind, "unparsable", `must not accept: ${raw}`);
  }
});

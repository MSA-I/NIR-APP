// The synthetic live-evaluation runner is the one path in this function directory that builds a
// provider WITHOUT going through parseAssistantConfig, so the #179 gate that config.ts enforces
// does not reach it by construction. ASSISTANT.md §4.1 already claimed the opposite -- "גם runner
// סינתטי אינו עוקף את חסמי הממשל #179" -- which made this a documented promise the code did not
// keep. These cases hold it to the promise: incomplete provider governance refuses before a key
// is used, and it refuses for the governance reason rather than for a missing knob.
import assert from "node:assert/strict";
import { executeSyntheticLiveEvaluation } from "./live-evaluation.ts";
import { GOVERNANCE_ENV_VARS, GOVERNANCE_ROWS } from "./governance.ts";

function completeGovernance(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const row of GOVERNANCE_ROWS) {
    env[GOVERNANCE_ENV_VARS[row]] =
      `status=VERIFIED;claim=${row}_fixture;source=https://example.test/${row};retrieved=2026-08-24;verifier=test-fixture`;
  }
  return env;
}

Deno.test("a synthetic live run refuses when one governance row is missing (#179)", async () => {
  const env = completeGovernance();
  delete env[GOVERNANCE_ENV_VARS.dpa];
  await assert.rejects(
    () =>
      executeSyntheticLiveEvaluation(
        "sk-must-never-be-used",
        "gpt-nonexistent",
        (name) => env[name],
      ),
    (error: Error) => {
      assert.equal(error.name, "ProviderGovernanceRefusedError");
      assert.match(error.message, /dpa/);
      return true;
    },
  );
});

Deno.test("a synthetic live run refuses when no governance evidence is configured at all", async () => {
  await assert.rejects(
    () => executeSyntheticLiveEvaluation("sk-must-never-be-used", "gpt-nonexistent", () => undefined),
    (error: Error) => {
      assert.equal(error.name, "ProviderGovernanceRefusedError");
      return true;
    },
  );
});

Deno.test("the refusal happens before any provider work, not after a failed call", async () => {
  // A network-shaped failure would prove nothing -- it could mean the key was wrong. The gate is
  // only worth having if it fires with an unreachable model name and an invalid key, i.e. before
  // anything is attempted. `fetch` is replaced with a throwing stub so a single outbound attempt
  // fails this case loudly instead of turning into an ordinary provider error.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("live_evaluation_reached_the_network_before_the_governance_gate");
  }) as typeof fetch;
  try {
    const env = completeGovernance();
    delete env[GOVERNANCE_ENV_VARS.data_region];
    await assert.rejects(
      () =>
        executeSyntheticLiveEvaluation(
          "sk-must-never-be-used",
          "gpt-nonexistent",
          (name) => env[name],
        ),
      (error: Error) => {
        assert.equal(error.name, "ProviderGovernanceRefusedError");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

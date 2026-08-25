// The provider-governance gate (OPEN-DECISIONS #179).
//
// #179, decided by the owner on 21.08.2026: the assistant stays OFF until training use,
// retention, provider logs, DPA and data region are each VERIFIED and documented for OpenAI.
// Standard retention is allowed with honest disclosure; zero retention is never promised
// without a contract that proves it. If the DPA or any mandatory condition is unavailable, the
// assistant stays off. There is no backup provider -- provider failure falls back to the
// deterministic product path (/alerts and the screens), never to a second vendor.
//
// This module is the mechanical half of that decision. The human half -- the actual dated
// sources and who read them -- lives in docs/ASSISTANT-ACTIVATION-EVIDENCE.md, which the
// operator transcribes into the configuration values this module parses. The document is where
// a person signs; this file is what refuses when nobody has.
//
// Three deliberate properties:
//
//   * Dependency-free. No imports, no network, no Deno APIs. A gate that needed the network to
//     decide whether the network is allowed would be circular. Given the same evidence it returns
//     the same decision, always -- which is why the whole suite runs with no permissions at all.
//     EVIDENCE is never compared to a clock: a retrieval date ages without becoming false, so a
//     clock-sensitive gate would switch production off while nobody touched it. The one exception
//     -- and it is a different KIND of input -- is the pre-launch exception below, which is a
//     permission with an end date rather than evidence with an age. Its `now` is a parameter that
//     defaults to the real clock for production callers and is injected by every test, so the
//     suite stays deterministic while production needs no wiring to expire on time.
//   * Fail-closed on anything it does not understand. An unset row is absent, a malformed row
//     is unparsable, a typo'd field name is a refusal. There is no shape that means "probably
//     fine": the class of bug this exists to prevent is a governance field that stops being
//     read and takes nobody's attention with it.
//   * A refusal is a refusal, not a route. Nothing emitted here names an alternative vendor,
//     and evidence for a vendor other than the governed one is itself a refusal. Evidence is
//     not transferable, and adding a model vendor is a sub-processor change (#124) requiring a
//     consent-document update and a TERMS_VERSION bump -- never a runtime fallback.
//
// Callers must treat a refusal as "assistant unavailable" and stop. It is not a soft warning,
// and it is not a reason to try something else.

/**
 * The one vendor the governance evidence covers. Not a default that can be widened: #179 forbids
 * a backup provider outright, and config.ts independently refuses any other AI_ASSISTANT_PROVIDER
 * value. Two refusals for one rule, because this is the rule that must not erode quietly.
 */
export const GOVERNED_PROVIDER = "openai" as const;

/**
 * The five mandatory rows, in the order #179 names them. The order is load-bearing only for
 * readability of a refusal; the rule is that ALL five must be VERIFIED.
 */
export const GOVERNANCE_ROWS = [
  "training_use",
  "retention",
  "provider_logs",
  "dpa",
  "data_region",
] as const;

export type GovernanceRow = typeof GOVERNANCE_ROWS[number];

/**
 * Where each row is supplied at runtime. These are Edge-function secrets like every other
 * assistant knob -- they do not enter Git, and they are set separately from the OCR/document
 * interpretation configuration (ASSISTANT.md §4).
 */
export const GOVERNANCE_ENV_VARS: Record<GovernanceRow, string> = {
  training_use: "AI_ASSISTANT_GOVERNANCE_TRAINING_USE",
  retention: "AI_ASSISTANT_GOVERNANCE_RETENTION",
  provider_logs: "AI_ASSISTANT_GOVERNANCE_PROVIDER_LOGS",
  dpa: "AI_ASSISTANT_GOVERNANCE_DPA",
  data_region: "AI_ASSISTANT_GOVERNANCE_DATA_REGION",
};

/**
 * The pre-launch exception (owner ruling, 25.08.2026 — OPEN-DECISIONS #271).
 *
 * A DPA is executed between a legal entity and OpenAI OpCo, LLC. No company is registered yet, so
 * the `dpa` row cannot become VERIFIED — not because a form is unfilled, but because there is no
 * counterparty. Writing VERIFIED anyway was refused: `/privacy` is derived from these rows, so a
 * false status is a false statement to customers, and preventing exactly that is why this gate
 * exists.
 *
 * This is the other half of that refusal. It is a PERMISSION with an end date, not evidence:
 * it never marks the `dpa` row VERIFIED, never changes what `/privacy` says, and is recorded as
 * itself so an audit reads "ran under a pre-launch exception", never "had a contract".
 *
 * Three bounds, each enforced independently:
 *   - one organisation, matched at construction time where the actor is known;
 *   - one end date, after which the gate refuses with no code change;
 *   - `dpa` ONLY, and only when that row is absent or MISSING. Any other unmet row still refuses,
 *     and a CONTRADICTED `dpa` — meaning the answer was checked and is negative — is never
 *     exceptable.
 */
export const PRELAUNCH_EXCEPTION_ENV_VAR = "AI_ASSISTANT_PRELAUNCH_EXCEPTION";

export interface PrelaunchException {
  /** Inclusive last day the exception is honoured, ISO `YYYY-MM-DD`. */
  until: string;
  /** The single organisation it covers. Any other org is refused at construction. */
  organizationId: string;
  /** Why it exists, carried into the refusal and the audit trail. */
  reason: string;
}

/**
 * The three statuses the evidence template uses, plus one a person never writes: UNPARSABLE is
 * what the configuration reader records when a supplied value does not parse. Keeping it in the
 * status rather than in a side channel means a broken value travels with its row instead of
 * being dropped on the way. Only VERIFIED opens the gate.
 */
export type GovernanceStatus = "VERIFIED" | "MISSING" | "CONTRADICTED" | "UNPARSABLE";

export interface GovernanceEvidenceRow {
  /** VERIFIED / MISSING / CONTRADICTED, transcribed from the evidence document. */
  status: GovernanceStatus;
  /** What the provider's terms actually say, as a short stable token, e.g. `no_training_on_api_data`. */
  claim: string;
  /** The dated official source: an https URL to the provider's own published terms. */
  source: string;
  /** The retrieval date, ISO `YYYY-MM-DD`. Recorded, never compared to a clock (see header). */
  retrieved: string;
  /** Who read the source. A row nobody signed for is a row nobody checked. */
  verifier: string;
  /** Contract reference, required for -- and only for -- a `zero_retention` claim. */
  contract: string | null;
}

export interface ProviderGovernanceEvidence {
  provider: string;
  rows: Partial<Record<GovernanceRow, GovernanceEvidenceRow | null>>;
}

export interface GovernanceUnmetRow {
  row: GovernanceRow | "provider";
  cause: string;
}

export type ProviderGovernanceDecision =
  | {
    allowed: true;
    provider: typeof GOVERNED_PROVIDER;
    rows: Record<GovernanceRow, GovernanceEvidenceRow>;
    /**
     * Present only when the `dpa` row was waived by the pre-launch exception. Absent means all
     * five rows stood on their own evidence. Callers that record what happened must read this
     * rather than infer from `allowed`: the two are not the same claim.
     */
    prelaunchException?: PrelaunchException;
  }
  | { allowed: false; reason: string; unmet: GovernanceUnmetRow[] };

/**
 * The claim token that #179 singles out. Any row carrying it needs a contract reference; the
 * rule is not scoped to the retention row, because "we are not logged" is the same promise
 * wearing a different label.
 */
const ZERO_RETENTION_CLAIM = "zero_retention";

/**
 * Words that look like an answer and are not one. A governance field filled with `tbd` has the
 * same evidentiary value as an empty one, and the failure mode this guards against is exactly
 * the plausible-looking placeholder that survives review because the field is not blank.
 */
const PLACEHOLDER_VALUES = new Set([
  "-",
  "n/a",
  "na",
  "none",
  "null",
  "pending",
  "tbd",
  "todo",
  "unknown",
  "—",
]);

function isFilled(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && !PLACEHOLDER_VALUES.has(normalized);
}

/**
 * An https URL and nothing else. http is rejected on purpose: a governance source that can be
 * rewritten in transit is not evidence, and every provider publishes its terms over TLS.
 */
function isOfficialSourceUrl(value: string): boolean {
  return /^https:\/\/[^\s]+$/.test(value.trim());
}

/**
 * ISO `YYYY-MM-DD`, validated by construction rather than by Date parsing -- `new Date()` accepts
 * "2026-13-01" in some runtimes and rolls it over, which would let a typo pass as a date.
 */
function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** The first unmet cause for one row, or null when the row is complete. */
function rowCause(row: GovernanceEvidenceRow): string | null {
  if (row.status === "UNPARSABLE") return "row_unparsable";
  if (row.status !== "VERIFIED") return `status_${row.status}`;
  if (!isFilled(row.claim)) return "claim_missing";
  if (!isFilled(row.source)) return "source_missing";
  if (!isOfficialSourceUrl(row.source)) return "source_not_a_url";
  if (!isFilled(row.retrieved)) return "retrieval_date_missing";
  if (!isIsoDate(row.retrieved)) return "retrieval_date_malformed";
  if (!isFilled(row.verifier)) return "verifier_unnamed";
  // #179: zero retention is never promised without a contract that proves it. This check sits
  // AFTER the completeness checks on purpose -- a zero-retention row that is otherwise perfect
  // is still refused, and the refusal must say why rather than blame a missing field.
  if (row.claim.trim().toLowerCase() === ZERO_RETENTION_CLAIM && !isFilled(row.contract ?? "")) {
    return "zero_retention_without_contract";
  }
  return null;
}

/**
 * The gate. Returns a decision rather than throwing, so the one caller that matters --
 * parseAssistantConfig -- can turn it into the same ConfigResult refusal every other malformed
 * knob produces. One refusal path through the boundary, not two.
 *
 * A refusal names every unmet row at once: an operator who fixes one row and redeploys to
 * discover the next is an operator who will eventually stop reading the reason.
 */
export function assertProviderGovernance(
  evidence: ProviderGovernanceEvidence,
  options: {
    /** The parsed pre-launch exception, or null/undefined when none is configured. */
    exception?: PrelaunchException | null;
    /** Injected so the expiry is testable. Callers in production pass the real clock. */
    now?: Date;
  } = {},
): ProviderGovernanceDecision {
  if (evidence.provider !== GOVERNED_PROVIDER) {
    // Deliberately does not echo the vendor that was tried. A refusal that names another vendor
    // reads as a suggestion, and #179 has no second vendor to suggest.
    return refuse([{ row: "provider", cause: "provider_not_governed" }]);
  }

  const unmet: GovernanceUnmetRow[] = [];
  const accepted = {} as Record<GovernanceRow, GovernanceEvidenceRow>;
  for (const row of GOVERNANCE_ROWS) {
    const supplied = evidence.rows[row];
    if (!supplied) {
      unmet.push({ row, cause: "row_absent" });
      continue;
    }
    const cause = rowCause(supplied);
    if (cause) unmet.push({ row, cause });
    else accepted[row] = supplied;
  }

  if (unmet.length === 0) {
    return { allowed: true, provider: GOVERNED_PROVIDER, rows: accepted };
  }

  const waiver = waiveDpa(unmet, options.exception ?? null, options.now ?? new Date());
  if (!waiver.waived) return refuse(unmet, waiver.extra);

  // The waived row travels INTO the decision exactly as supplied, so the construction-time
  // re-check decides over the same rows and reaches the same answer. Substituting a synthetic
  // VERIFIED row here would make the recheck agree for the wrong reason, which is the failure
  // that re-check exists to catch.
  accepted.dpa = evidence.rows.dpa ?? ABSENT_DPA_ROW;
  return {
    allowed: true,
    provider: GOVERNED_PROVIDER,
    rows: accepted,
    prelaunchException: waiver.exception,
  };
}

/**
 * The `dpa` row as it is recorded when nobody supplied one at all. Carrying a MISSING row rather
 * than omitting it keeps `rows` complete for the re-check, and keeps the honest status visible to
 * anything that reads the decision.
 */
const ABSENT_DPA_ROW: GovernanceEvidenceRow = {
  status: "MISSING",
  claim: "no_dpa_no_legal_entity_to_execute_one",
  source: "",
  retrieved: "",
  verifier: "",
  contract: null,
};

/** Causes on the `dpa` row that mean "there is no DPA", as opposed to "we checked and it is bad". */
const WAIVABLE_DPA_CAUSES = new Set(["row_absent", "status_MISSING"]);

type DpaWaiver =
  | { waived: true; exception: PrelaunchException }
  | { waived: false; extra: GovernanceUnmetRow[] };

/**
 * Decides whether the single unmet `dpa` row may be waived. Every rejection adds a named cause to
 * the refusal instead of falling through silently: an operator who set an exception and still got
 * refused must be told which of the three bounds stopped it.
 */
function waiveDpa(
  unmet: GovernanceUnmetRow[],
  exception: PrelaunchException | null,
  now: Date,
): DpaWaiver {
  if (!exception) return { waived: false, extra: [] };

  // Only `dpa`, and only alone. An exception that could carry a second unmet row would be a
  // general override, and #179 has no general override.
  if (unmet.length !== 1 || unmet[0].row !== "dpa") {
    return { waived: false, extra: [{ row: "dpa", cause: "prelaunch_exception_covers_dpa_only" }] };
  }
  if (!WAIVABLE_DPA_CAUSES.has(unmet[0].cause)) {
    return { waived: false, extra: [{ row: "dpa", cause: "prelaunch_exception_not_for_this_cause" }] };
  }

  // The one place in this module that compares a date to a clock, and the inversion is deliberate:
  // a retrieval date is EVIDENCE and ages without becoming false, so comparing it to a clock would
  // switch production off while nobody touched it. An exception is a PERMISSION, and a permission
  // that does not end is the thing the owner asked to avoid.
  if (isoDateOf(now) > exception.until) {
    return { waived: false, extra: [{ row: "dpa", cause: "prelaunch_exception_expired" }] };
  }

  return { waived: true, exception };
}

/** `YYYY-MM-DD` in UTC. Compared as a string, which is ordered correctly for this format. */
function isoDateOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function refuse(
  unmet: GovernanceUnmetRow[],
  extra: GovernanceUnmetRow[] = [],
): ProviderGovernanceDecision {
  const all = [...unmet, ...extra];
  const detail = all.map((entry) => `${entry.row}=${entry.cause}`).join(",");
  return { allowed: false, reason: `assistant_governance_incomplete:${detail}`, unmet: all };
}

/**
 * Thrown at the provider-construction site. Its own error class rather than an AssistantEdgeError
 * so this module stays dependency-free; index.ts's outer catch already maps an unrecognised throw
 * to `assistant_provider_unavailable` (503), whose Hebrew wording -- "העוזר אינו זמין כרגע.
 * הנתונים עצמם זמינים במסכים." -- is exactly #179's fallback: no assistant, and the deterministic
 * screens still answer.
 */
export class ProviderGovernanceRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ProviderGovernanceRefusedError";
  }
}

/**
 * The last check before a provider client exists. It re-runs the decision over the rows the
 * decision carries instead of trusting the `allowed` flag: the failure this defends against is
 * the future refactor that keeps the flag and loosens the parse, which no configuration test
 * would notice because the configuration would still look valid.
 */
export function assertGovernedProviderConstruction(
  decision: ProviderGovernanceDecision,
  context: {
    /**
     * The organisation this request belongs to. Required whenever the decision rests on a
     * pre-launch exception, because the exception covers exactly one organisation and this is the
     * first point in the request where that identity is known.
     */
    organizationId?: string;
    now?: Date;
  } = {},
): void {
  const now = context.now ?? new Date();
  const rechecked = decision.allowed
    ? assertProviderGovernance(
      { provider: decision.provider, rows: decision.rows },
      { exception: decision.prelaunchException ?? null, now },
    )
    : decision;
  if (!rechecked.allowed) throw new ProviderGovernanceRefusedError(rechecked.reason);

  // The organisation bound, enforced here rather than at parse time because parse time has no
  // request and therefore no organisation. Re-running the date check above is not redundant: a
  // warm isolate can hold a decision parsed before midnight and construct a provider after it.
  const exception = rechecked.prelaunchException;
  if (!exception) return;
  if (context.organizationId !== exception.organizationId) {
    throw new ProviderGovernanceRefusedError(
      "assistant_governance_incomplete:dpa=prelaunch_exception_wrong_organization",
    );
  }
}

type EnvReader = (name: string) => string | undefined;

/**
 * Reads the five rows from configuration. Format, one variable per row:
 *
 *   status=VERIFIED;claim=<token>;source=https://…;retrieved=YYYY-MM-DD;verifier=<who>[;contract=<ref>]
 *
 * Values may contain `=` (query strings survive) but not `;`; a source URL that needs a semicolon
 * must percent-encode it. An unset variable is an absent row -- the honest reading of "nobody
 * supplied this". A variable that is set but does not parse is `row_unparsable`, never a partly
 * populated row: a typo'd field name that silently dropped its value is how a gate stops
 * checking what its author believed it checked.
 *
 * `provider` is passed in rather than read here, so the vendor is resolved once, by config.ts,
 * with its documented default -- two places deriving the same default is how the two drift.
 */
export function readProviderGovernanceEvidence(
  env: EnvReader,
  provider: string,
): ProviderGovernanceEvidence {
  const rows: Partial<Record<GovernanceRow, GovernanceEvidenceRow | null>> = {};
  for (const row of GOVERNANCE_ROWS) {
    rows[row] = parseEvidenceRow(env(GOVERNANCE_ENV_VARS[row]));
  }
  return { provider, rows };
}

/**
 * An unparsable row is represented as a CONTRADICTED row carrying `row_unparsable`, so the
 * refusal distinguishes "nobody supplied it" from "somebody supplied something wrong" -- two
 * different conversations with two different people.
 */
const UNPARSABLE_ROW: GovernanceEvidenceRow = {
  status: "UNPARSABLE",
  claim: "",
  source: "",
  retrieved: "",
  verifier: "",
  contract: null,
};

/**
 * Splits `key=value;key=value` under one set of rules, used by both readers in this module.
 * Returns null when the shape is wrong: a duplicated key, a segment with no `=`, or a leading `=`.
 * Values may contain `=`; keys are lowercased.
 */
function splitFields(raw: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const segment of raw.split(";")) {
    if (segment.trim() === "") continue;
    const separator = segment.indexOf("=");
    if (separator <= 0) return null;
    const key = segment.slice(0, separator).trim().toLowerCase();
    const value = segment.slice(separator + 1).trim();
    if (fields.has(key)) return null;
    fields.set(key, value);
  }
  return fields;
}

/**
 * Reads the pre-launch exception. Format:
 *
 *   until=YYYY-MM-DD;org=<uuid>;reason=<text>
 *
 * Three outcomes, kept distinct because they call for different operator action: `absent` is the
 * normal state and refuses nothing by itself; `unparsable` is a typo that must be reported rather
 * than silently read as absent, or an operator would believe an exception is live when it is not.
 */
export type PrelaunchExceptionRead =
  | { kind: "absent" }
  | { kind: "valid"; exception: PrelaunchException }
  | { kind: "unparsable" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readPrelaunchException(env: EnvReader): PrelaunchExceptionRead {
  const raw = env(PRELAUNCH_EXCEPTION_ENV_VAR);
  if (raw === undefined || raw.trim() === "") return { kind: "absent" };

  const fields = splitFields(raw);
  if (!fields) return { kind: "unparsable" };

  const known = ["until", "org", "reason"];
  for (const key of fields.keys()) {
    if (!known.includes(key)) return { kind: "unparsable" };
  }
  for (const required of known) {
    if (!fields.has(required)) return { kind: "unparsable" };
  }

  const until = fields.get("until") ?? "";
  const organizationId = fields.get("org") ?? "";
  const reason = fields.get("reason") ?? "";
  if (!isIsoDate(until)) return { kind: "unparsable" };
  if (!UUID_PATTERN.test(organizationId)) return { kind: "unparsable" };
  // A reason nobody wrote is a permission nobody justified, and the audit line would read empty.
  if (!isFilled(reason)) return { kind: "unparsable" };

  return { kind: "valid", exception: { until, organizationId: organizationId.toLowerCase(), reason } };
}

function parseEvidenceRow(raw: string | undefined): GovernanceEvidenceRow | null {
  if (raw === undefined || raw.trim() === "") return null;

  const fields = splitFields(raw);
  if (!fields) return unparsable();

  const known = ["status", "claim", "source", "retrieved", "verifier", "contract"];
  for (const key of fields.keys()) {
    if (!known.includes(key)) return unparsable();
  }

  const status = fields.get("status")?.toUpperCase() ?? "";
  if (status !== "VERIFIED" && status !== "MISSING" && status !== "CONTRADICTED") {
    return unparsable();
  }
  for (const required of ["claim", "source", "retrieved", "verifier"]) {
    if (!fields.has(required)) return unparsable();
  }

  return {
    status,
    claim: fields.get("claim") ?? "",
    source: fields.get("source") ?? "",
    retrieved: fields.get("retrieved") ?? "",
    verifier: fields.get("verifier") ?? "",
    contract: fields.get("contract") ?? null,
  };
}

function unparsable(): GovernanceEvidenceRow {
  return { ...UNPARSABLE_ROW };
}

import { z } from 'zod';

/**
 * InPlace Assistant — canonical contracts.
 *
 * One file, two runtimes. The browser imports it as `./contracts`; the Edge function imports the
 * same file as `../../../src/lib/assistant/contracts.ts` (Deno needs the extension, Vite does not).
 * A second copy would drift, and the whole point of this feature is that the model may only speak
 * about values the server issued — a drifting envelope defeats that at the first schema change.
 *
 * Nothing here may import from the app: no supabase client, no React, no DOM. Zod and types only.
 */

export const ASSISTANT_CONTRACT_VERSION = 'assistant-contracts-v1';

/* ============================================================================
 * 1. Data classification
 * ==========================================================================*/

/**
 * What a field is, for the purpose of deciding whether it may cross the boundary to a model
 * provider. RLS decides which rows a caller sees; this decides which *fields* of those rows are
 * allowed to leave InPlace. The two are independent controls and neither substitutes for the other.
 */
export const DATA_CLASSES = [
  /** Catalogue/product help text and route metadata. Not tenant-identifying. */
  'public_product_metadata',
  /** Ordinary tenant business data: statuses, counts, dates, entity names. */
  'tenant_standard',
  /** Money: totals, balances, deltas, exposure. May leave, but only as computed values. */
  'financial_sensitive',
  /** Supplier bank details. Never leaves as a value — masked context only. */
  'bank_restricted',
  /** Named humans, phones, emails. */
  'personal_contact',
  /** Raw OCR payloads and stored document bytes. */
  'document_raw',
  /** Anything explicitly barred from any provider, whatever the reason. */
  'provider_forbidden',
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/**
 * Classes that must never appear in a provider request body.
 *
 * `personal_contact` is on the list deliberately: the assistant answers operational questions, and
 * "which supplier is late" needs the supplier's *name* (tenant_standard), never the buyer's phone
 * number. A capability that genuinely needs a contact detail must state its case in
 * docs/ASSISTANT.md and change this list in the same commit.
 */
export const PROVIDER_FORBIDDEN_CLASSES: readonly DataClass[] = [
  'bank_restricted',
  'personal_contact',
  'document_raw',
  'provider_forbidden',
];

export function mayReachProvider(dataClass: DataClass): boolean {
  return !PROVIDER_FORBIDDEN_CLASSES.includes(dataClass);
}

/* ============================================================================
 * 2. Authorization context
 * ==========================================================================*/

/** The three live roles. `user_role` still carries three retired values; they cannot authenticate. */
export const ASSISTANT_ROLES = ['owner', 'office', 'accountant'] as const;
export type AssistantRole = (typeof ASSISTANT_ROLES)[number];

/**
 * Resolved from the authenticated server context on every run — never from anything the browser
 * sent. `orgId`/`role` come from `auth_org()`/`auth_role()`, which read `auth.uid()` and refuse
 * suspended organizations and retired roles.
 */
export interface ActorContext {
  userId: string;
  orgId: string;
  role: AssistantRole;
  /** `auth_scopes()` — the unit ids this actor may see. Empty means org-wide with no unit focus. */
  scopes: readonly string[];
  /** From `organization_access_state()`. A read-only org may still ask; it may not confirm actions. */
  canWrite: boolean;
  capabilities: AssistantCapabilities;
}

/**
 * What this organization has turned on. Flags gate exposure (0059's law: a flag never grants a
 * permission); entitlements gate permission and fail closed when unmeasured. Both are resolved
 * server-side per run — the browser's opinion is not consulted.
 */
export interface AssistantCapabilities {
  /** `assistant.ui` — the panel and the read-only tools. */
  ui: boolean;
  /** `assistant.history` — persistence of conversations. Off means the run is not stored. */
  history: boolean;
  /** `assistant.drafts` — the model may compose a proposal. It still cannot execute one. */
  drafts: boolean;
  /**
   * Whether a human-confirmed proposal may be executed.
   *
   * **This one is not a flag.** ENTERPRISE-SECURITY-MODEL §8 is explicit: a flag may only turn a
   * capability off, never widen permission, and `resolve_feature_flags()` is structurally barred
   * from appearing in any authorization path. So the switch that opens a new road to a business
   * write follows the autonomy-policy pattern instead (OPEN-DECISIONS #109): a private baseline of
   * OFF held by a CHECK constraint, enabled per organization only by a platform-admin command that
   * demands a reason and writes an audit row.
   */
  confirmedActions: boolean;
}

/** Rollout switches. Exposure only — never authorization. */
export const ASSISTANT_FLAG_KEYS = {
  ui: 'assistant.ui',
  history: 'assistant.history',
  drafts: 'assistant.drafts',
} as const satisfies Record<'ui' | 'history' | 'drafts', string>;

/** The policy key behind `confirmedActions`. Baseline off; only a platform command may raise it. */
export const ASSISTANT_ACTION_POLICY_KEY = 'assistant.confirmed_actions';

/**
 * Entitlement keys resolved through `effective_entitlement()`. Unmeasured is a refusal, not infinity.
 *
 * Volume only, and deliberately so: OPEN-DECISIONS #158 records that plans do not gate capabilities
 * in this product — "Free הוא הדמו של המוצר" — they differ by how much. A boolean
 * `assistant.enabled` entitlement would have quietly reversed that decision through a side door.
 */
export const ASSISTANT_ENTITLEMENTS = {
  /** numeric, per_period — assistant runs allowed in the billing period. */
  runsPerPeriod: 'assistant_runs.monthly',
} as const;

/**
 * Per-hour ceiling on runs for one user, enforced in the database.
 *
 * ENTERPRISE-SECURITY-MODEL §10 lists rate limiting as a standing requirement that most surfaces
 * still owe; a new endpoint that calls a paid provider must not join that list. The precedent is
 * the counted limit on invitations (0020) and on signup (0159) — counted in Postgres, not in an
 * Edge variable, because a per-instance counter is not a limit.
 */
export const ASSISTANT_RUNS_PER_USER_HOUR = 30;

/** Usage metric keys recorded through `record_usage_event()`. */
export const ASSISTANT_USAGE_METRICS = {
  runs: 'assistant_runs.monthly',
} as const;

/* ============================================================================
 * 3. Evidence: facts and sources
 * ==========================================================================*/

/** Entities the assistant may point at. A route is only ever one the tool returned. */
export const EVIDENCE_ENTITIES = [
  'invoice',
  'purchase_order',
  'supplier',
  'product',
  'payment_request',
  'payment',
  'credit_note',
  'exception',
  'document',
  'bank_transaction',
  'price_offer',
  'organization',
] as const;
export type EvidenceEntity = (typeof EVIDENCE_ENTITIES)[number];

/**
 * Fact kinds. Closed on purpose: post-generation validation asks "does this fact support this
 * claim", and that question is only answerable against a known vocabulary. A tool may not invent a
 * kind at runtime; adding one is a contract change reviewed here.
 *
 * Populated from the capability map — every kind below is backed by a server computation that
 * already exists. Kinds for capabilities that turned out to be unmeasurable are absent rather than
 * stubbed, for the same reason the alert scanner leaves out stock levels: a fact that nothing
 * computes is a lie with an id.
 */
export const FACT_KINDS = [
  'metric.count',
  'metric.money',
  'metric.percent',
  'invoice.total',
  'invoice.status',
  'invoice.block_reason',
  'invoice.balance',
  'order.total',
  'order.status',
  'order_invoice.delta',
  'supplier.balance',
  'supplier.price_change',
  'payment_request.total',
  'payment_request.status',
  'credit.open_amount',
  'exception.status',
  'document.status',
  'alert.occurrence',
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_UNITS = ['ils', 'count', 'percent', 'date', 'text'] as const;
export type FactUnit = (typeof FACT_UNITS)[number];

/**
 * A single server-computed value the model is allowed to state.
 *
 * `id` is run-scoped (`f1`, `f2`, …) and meaningless outside the run that issued it — that is what
 * makes "cite only what this run returned" checkable. `value` is the value as computed by server
 * code; the model may explain it and must not recompute it.
 */
export interface Fact {
  id: string;
  kind: FactKind;
  /** What the fact is about. `null` for an aggregate that is not about one row. */
  subject: { entity: EvidenceEntity; id: string } | null;
  /** A short Hebrew phrase naming what was measured, e.g. "חשבוניות שנקלטו ב-7 הימים האחרונים". */
  label: string;
  /** `null` means "not measured" and must never be rendered as zero. */
  value: number | string | null;
  unit: FactUnit;
  /** The tool that issued it. */
  tool: string;
  /** When the underlying data was read. */
  as_of: string;
  classification: DataClass;
}

/**
 * A place in the product where a human can go and see the thing for themselves.
 *
 * A source is a reference, never a grant: it is re-authorized against current permissions every
 * time it is read back, so a role change or a deletion takes effect on stored history too.
 */
export interface SourceReference {
  id: string;
  entity: EvidenceEntity;
  entity_id: string;
  /** Safe display label. Never a bank detail, never a raw document filename with a storage path. */
  label: string;
  /** In-app route returned by the tool. The model may not compose a route of its own. */
  route: string | null;
  classification: DataClass;
}

/* ============================================================================
 * 4. Tool result envelope
 * ==========================================================================*/

/**
 * Every tool returns this shape.
 *
 * `complete` is a claim about coverage, not about emptiness. Zero rows with `complete: true` means
 * "measured, and the answer is none". Zero rows with `complete: false` means "we could not measure",
 * and the assistant must say so rather than report a clean sheet — the same distinction /alerts
 * already makes in prose ("הסריקה לא הושלמה, ולכן אין אפשרות לקבוע שאין התראות פתוחות").
 */
export interface ToolEnvelope<T = unknown> {
  data: T[];
  complete: boolean;
  /** What could not be measured, and its Hebrew label, mirroring `Summary.failures`. */
  failures: { code: string; label: string }[];
  /** The effective filters, echoed so the answer can state its own scope. */
  filters: Record<string, string | number | boolean | null>;
  as_of: string;
  result_count: number;
  has_more: boolean;
  facts: Fact[];
  sources: SourceReference[];
  warnings: string[];
}

export const TOOL_RESULT_LIMIT = 50;
export const TOOL_RESULT_LIMIT_MAX = 200;

/* ============================================================================
 * 5. Time semantics
 * ==========================================================================*/

/**
 * The organization timezone. Asia/Jerusalem is already the product's business timezone
 * (`toTimeZoneISO` in src/lib/format.ts, `usage_period()` in migration 0155); this constant names
 * it rather than introducing a second opinion. There is no per-organization timezone column, and
 * inventing one for the assistant would be a business decision nobody has taken.
 */
export const ORG_TIME_ZONE = 'Asia/Jerusalem';

/**
 * Named periods the assistant may ask for.
 *
 * `last_7_days` and `last_30_days` are trailing windows anchored on today in `ORG_TIME_ZONE`.
 *
 * Calendar week and calendar month are absent on purpose, and the reason is measured rather than
 * stylistic: the product currently means two different things by "השבוע". `summary.ts` and
 * `alerts.ts` use trailing windows (7 and 30 days), while the dashboard's own weekly buckets use
 * `startOfCalendarWeek` from src/lib/format.ts, which starts on Sunday. Server-side there is no
 * week helper at all. Offering both semantics here would let one question return two numbers, both
 * defensible, with nothing on screen to say which was used. Until the owner picks one
 * (OPEN-DECISIONS #178), the assistant answers only in windows it can name out loud.
 */
export const TIME_WINDOWS = ['last_7_days', 'last_30_days', 'last_90_days'] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

export const TIME_WINDOW_DAYS: Record<TimeWindow, number> = {
  last_7_days: 7,
  last_30_days: 30,
  last_90_days: 90,
};

/** Hebrew label for a window, so every tool describes its own scope identically. */
export const TIME_WINDOW_LABELS: Record<TimeWindow, string> = {
  last_7_days: '7 הימים האחרונים',
  last_30_days: '30 הימים האחרונים',
  last_90_days: '90 הימים האחרונים',
};

/* ============================================================================
 * 6. Assistant response schema
 * ==========================================================================*/

/**
 * Any digit — Latin or Arabic-Indic — outside a claim block is a fabricated number until proven
 * otherwise. This is the mechanical half of "evidence before eloquence": prose may carry meaning,
 * only a claim may carry a quantity.
 */
export const DIGIT_PATTERN = /[0-9٠-٩۰-۹]/;

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(600).refine((value) => !DIGIT_PATTERN.test(value), {
    message: 'text_block_contains_digits',
  }),
});

export const ClaimBlockSchema = z.object({
  type: z.literal('claim'),
  text: z.string().min(1).max(600),
  /** The exact server-issued semantic this sentence claims. */
  claim_kind: z.enum(FACT_KINDS),
  /** Must match the supporting Fact subject exactly; null is reserved for aggregates. */
  subject: z
    .object({
      entity: z.enum(EVIDENCE_ENTITIES),
      id: z.string().min(1).max(200),
    })
    .strict()
    .nullable(),
  /** Every claim rests on at least one fact issued in this run. */
  fact_ids: z.array(z.string().min(1)).min(1).max(12),
  /** Optional: where a human goes to check it. */
  source_ids: z.array(z.string().min(1)).max(12).default([]),
});

export const AssistantBlockSchema = z.discriminatedUnion('type', [TextBlockSchema, ClaimBlockSchema]);
export type AssistantBlock = z.infer<typeof AssistantBlockSchema>;

/** Why an answer is absent. Named reasons, so "I don't know" is never mistaken for "there is none". */
export const NO_ANSWER_REASONS = [
  /** No tool covers the question. */
  'no_capability',
  /** A tool ran and could not measure. */
  'not_measured',
  /** The actor's role or scope does not reach the data. */
  'not_permitted',
  /** The question needs a business rule the product has not defined. */
  'undefined_business_rule',
] as const;
export type NoAnswerReason = (typeof NO_ANSWER_REASONS)[number];

export const AssistantAnswerSchema = z.object({
  blocks: z.array(AssistantBlockSchema).min(1).max(20),
  /** Follow-ups a human can take, each pointing at a source this run issued. */
  next_steps: z
    .array(z.object({ label: z.string().min(1).max(80), source_id: z.string().min(1) }))
    .max(3)
    .default([]),
  no_answer_reason: z.enum(NO_ANSWER_REASONS).nullable().default(null),
});
export type AssistantAnswer = z.infer<typeof AssistantAnswerSchema>;

/** What the browser receives. The envelope the panel renders. */
export interface AssistantRunResult {
  run_id: string;
  conversation_id: string | null;
  answer: AssistantAnswer;
  facts: Fact[];
  sources: SourceReference[];
  /** Tools that ran, for the "what did it look at" disclosure. */
  tools_used: { tool: string; complete: boolean }[];
  /** True when every tool that ran reported `complete`. */
  complete: boolean;
  as_of: string;
  proposal: AssistantProposal | null;
}

/* ============================================================================
 * 7. Proposal state machine
 * ==========================================================================*/

/**
 * A proposal is a draft of a command the product already has. The assistant never executes one on
 * its own: it composes, a human confirms, and the underlying command runs with the human's own
 * permissions, its own validation and its own audit row.
 */
export const PROPOSAL_STATES = [
  'draft',
  'awaiting_confirmation',
  'confirmed',
  'executed',
  'failed',
  'rejected',
  'expired',
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export const PROPOSAL_TRANSITIONS: Record<ProposalState, readonly ProposalState[]> = {
  draft: ['awaiting_confirmation', 'rejected', 'expired'],
  awaiting_confirmation: ['confirmed', 'rejected', 'expired'],
  confirmed: ['executed', 'failed'],
  executed: [],
  failed: [],
  rejected: [],
  expired: [],
};

export function canTransition(from: ProposalState, to: ProposalState): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

/**
 * How long a proposal stays confirmable.
 *
 * A safety default, not a business rule — which is why it lives here and not in the database, and
 * why `0164` deliberately refuses to default it: a draft is composed from figures read at one
 * moment, and the longer it sits the less those figures describe. Sixty minutes is short enough
 * that the numbers a person confirms are the numbers they were shown. Recorded as
 * OPEN-DECISIONS #182 so an owner can lengthen it on purpose rather than by drift.
 */
export const PROPOSAL_TTL_MINUTES = 60;

export interface AssistantProposal {
  id: string;
  state: ProposalState;
  /** The command this proposal would run, from the allowlist. Never free text. */
  command: string;
  /** Hebrew, human-readable, one line — what confirming this will do. */
  summary: string;
  /** The exact arguments, server-validated before the proposal was ever shown. */
  payload: Record<string, unknown>;
  facts: Fact[];
  sources: SourceReference[];
  expires_at: string;
}

/* ============================================================================
 * 8. Error taxonomy
 * ==========================================================================*/

/**
 * The codes and their Hebrew wording live in `./errorCodes`, which has no dependencies, because
 * `src/lib/errors.ts` needs them and is imported by most of the app — routing that map through this
 * file would pull Zod into the eager graph of every screen. Re-exported here so a consumer that
 * already imports the contracts does not need to know about the split.
 */
export {
  ASSISTANT_ERROR_CODES,
  ASSISTANT_ERROR_MESSAGES,
  type AssistantErrorCode,
} from './errorCodes.ts';

/* ============================================================================
 * 9. Request contract
 * ==========================================================================*/

export const ASSISTANT_QUESTION_MAX_CHARS = 600;

export const AssistantAskRequestSchema = z.object({
  question: z.string().trim().min(1).max(ASSISTANT_QUESTION_MAX_CHARS),
  /** Continues an existing conversation. Ownership is checked server-side, never trusted. */
  conversation_id: z.string().uuid().nullable().default(null),
  /** The route the user is on. Context only — never authorization, never a data filter. */
  route: z.string().max(200).nullable().default(null),
});
export type AssistantAskRequest = z.infer<typeof AssistantAskRequestSchema>;

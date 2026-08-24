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
export const DataClassSchema = z.enum(DATA_CLASSES);

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
export const EvidenceEntitySchema = z.enum(EVIDENCE_ENTITIES);

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
  /** The price that was in effect at the start of the calendar month a rise is measured against. */
  'supplier.price_baseline',
  /** What choosing this supplier saved against the NEXT-cheapest usable offer (src/lib/orderComparison.ts). */
  'comparison.saved_vs_next',
  /** What choosing this supplier costs above the cheapest usable offer. */
  'comparison.extra_vs_cheapest',
  /** A supplier minimum the entered quantity does not clear. Reported, never silently cleared (#190). */
  'comparison.minimum_breach',
  /** One authoritative product-help entry, valued by its canonical route (#192). */
  'product_help.entry',
  'payment_request.total',
  'payment_request.status',
  'credit.open_amount',
  'exception.status',
  'document.status',
  'alert.occurrence',
] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export const FactKindSchema = z.enum(FACT_KINDS);

export const FACT_UNITS = ['ils', 'count', 'percent', 'date', 'text'] as const;
export type FactUnit = (typeof FACT_UNITS)[number];
export const FactUnitSchema = z.enum(FACT_UNITS);
export const FactValueSchema = z.union([
  z.number().finite(),
  z.string().min(1).max(600),
  z.null(),
]);

const ContractIdSchema = z.string().min(1).max(200).refine((value) => value.trim() === value, {
  message: 'identifier_has_surrounding_whitespace',
});
const ContractTimestampSchema = z.string().datetime({ offset: true });
const FactSubjectSchema = z
  .object({
    entity: EvidenceEntitySchema,
    id: ContractIdSchema,
  })
  .strict();

/**
 * A single server-computed value the model is allowed to state.
 *
 * `id` is run-scoped (`f1`, `f2`, …) and meaningless outside the run that issued it — that is what
 * makes "cite only what this run returned" checkable. `value` is the value as computed by server
 * code; the model may explain it and must not recompute it.
 */
export const FactSchema = z
  .object({
  id: ContractIdSchema,
  kind: FactKindSchema,
  /** What the fact is about. `null` for an aggregate that is not about one row. */
  subject: FactSubjectSchema.nullable(),
  /** A short Hebrew phrase naming what was measured, e.g. "חשבוניות שנקלטו ב-7 הימים האחרונים". */
  label: z.string().min(1).max(300),
  /** `null` means "not measured" and must never be rendered as zero. */
  value: FactValueSchema,
  unit: FactUnitSchema,
  /** The tool that issued it. */
  tool: z.string().min(1).max(100),
  /** When the underlying data was read. */
  as_of: ContractTimestampSchema,
  classification: DataClassSchema,
  })
  .strict();
export type Fact = z.infer<typeof FactSchema>;

function isSafeInAppRouteShape(route: string): boolean {
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('#')) return false;
  try {
    const parsed = new URL(route, 'https://inplace.invalid');
    return parsed.origin === 'https://inplace.invalid'
      && `${parsed.pathname}${parsed.search}` === route;
  } catch {
    return false;
  }
}

export const AssistantSourceRouteSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(isSafeInAppRouteShape, { message: 'source_route_must_be_internal' });

/**
 * A place in the product where a human can go and see the thing for themselves.
 *
 * A source is a reference, never a grant: it is re-authorized against current permissions every
 * time it is read back, so a role change or a deletion takes effect on stored history too.
 */
export const SourceReferenceSchema = z
  .object({
  id: ContractIdSchema,
  entity: EvidenceEntitySchema,
  entity_id: ContractIdSchema,
  /** Safe display label. Never a bank detail, never a raw document filename with a storage path. */
  label: z.string().min(1).max(300),
  /** In-app route returned by the tool. The model may not compose a route of its own. */
  route: AssistantSourceRouteSchema.nullable(),
  classification: DataClassSchema,
  })
  .strict();
export type SourceReference = z.infer<typeof SourceReferenceSchema>;

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
 * `last_7_days`, `last_30_days` and `last_90_days` are trailing windows anchored on today in
 * `ORG_TIME_ZONE`, and their labels say so out loud.
 *
 * The two-meanings problem this list was originally written around has since been decided.
 * OPEN-DECISIONS #178 (owner, 21.08.2026) rules that in this product "week" and "month" mean
 * CALENDAR periods in `ORG_TIME_ZONE` — a week from Sunday 00:00, a month from the 1st at 00:00 —
 * and that a trailing window is legal only under an explicit `7 הימים האחרונים` / `30 הימים
 * האחרונים` label that never calls itself a week or a month. That is why the two vocabularies
 * below are separate constants rather than one enum: a tool picks the semantic it actually
 * computed, and the label it must print comes with it.
 *
 * Calendar WEEK is still absent, and deliberately: no server read model computes one yet, and a
 * period the assistant can name but not measure is a promise with no number behind it.
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

/**
 * Calendar periods, kept apart from the trailing windows above so that no tool can print a
 * trailing label over a calendar computation or the reverse (#178).
 *
 * `this_calendar_month` is the period #189 measures a supplier price rise over: from the 1st of
 * the current month at 00:00 in `ORG_TIME_ZONE` until now. The boundary lives in the server read
 * model; this constant only fixes the name the answer must carry.
 */
export const CALENDAR_PERIODS = ['this_calendar_month'] as const;
export type CalendarPeriod = (typeof CALENDAR_PERIODS)[number];

export const CALENDAR_PERIOD_LABELS: Record<CalendarPeriod, string> = {
  this_calendar_month: 'החודש הקלנדרי הנוכחי, מה-1 בחודש',
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
}).strict();

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
  /** Exact unit and value asserted by this claim. Both must equal one cited Fact. */
  claim_unit: FactUnitSchema,
  claim_value: FactValueSchema,
  /** Every claim rests on at least one fact issued in this run. */
  fact_ids: z.array(z.string().min(1)).min(1).max(12),
  /** Optional: where a human goes to check it. */
  source_ids: z.array(z.string().min(1)).max(12).default([]),
}).strict();

/**
 * A supplier reminder the human sends, not the product (#191).
 *
 * The label is a constant here rather than a field on the block, so the model cannot rename its
 * own output: it composes a body, and the product decides that a body is presented as `טיוטה`.
 * There is no recipient, no channel and no send — those capabilities do not exist anywhere in the
 * assistant surface, and `scripts/check-assistant-no-send.mjs` keeps it that way.
 *
 * The digit rule is NOT relaxed here. A reminder that names an order number or an amount is
 * carrying a quantity, so a draft is pinned exactly like a claim: every numeral in the body must
 * be a rendering of a cited fact's VALUE, checked by validateAnswer(). `fact_ids` is therefore
 * required rather than optional — a draft with nothing behind it is prose with a label.
 */
export const ASSISTANT_DRAFT_LABEL = 'טיוטה';

/**
 * The claim the product must never make about itself, held as a constant so it exists in exactly
 * ONE place. `scripts/check-assistant-no-send.mjs` forbids this word across the whole assistant
 * surface; the refusal that enforces the ban needs to name the word it bans, and a guard cannot
 * tell a refusal apart from an affordance by reading a string literal. Defining it here — and
 * importing it wherever it is checked — is what keeps the guard's single allowance to one
 * reviewed line instead of a per-file exception list.
 */
export const ASSISTANT_SENT_CLAIM_MARKER = 'נשלח';

/** #191: owner and office compose supplier drafts. `accountant` deliberately does not. */
export const ASSISTANT_DRAFT_ROLES: readonly AssistantRole[] = ['owner', 'office'];

export const DraftBlockSchema = z.object({
  type: z.literal('draft'),
  /** A message body rather than a sentence, hence the wider ceiling than a text block. */
  text: z.string().min(1).max(1200),
  fact_ids: z.array(z.string().min(1)).min(1).max(12),
  source_ids: z.array(z.string().min(1)).max(12).default([]),
}).strict();

export const AssistantBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ClaimBlockSchema,
  DraftBlockSchema,
]);
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
    .array(z.object({
      label: z.string().min(1).max(80),
      source_id: z.string().min(1),
    }).strict())
    .max(3)
    .default([]),
  no_answer_reason: z.enum(NO_ANSWER_REASONS).nullable().default(null),
}).strict();
export type AssistantAnswer = z.infer<typeof AssistantAnswerSchema>;

/** What the browser receives. The envelope the panel renders. */
export type AssistantRunResult = z.infer<typeof AssistantRunResultSchema>;

/* ============================================================================
 * 6b. Product help
 * ==========================================================================*/

/**
 * The shape of one authoritative product-help entry (#192).
 *
 * The registry in `src/lib/assistant/productHelpRegistry.ts` is the SINGLE source of truth for
 * "how do I do X in this product". A prompt, a design document or an on-screen sentence is not a
 * source: they drift, and a drifted answer about the product is indistinguishable from a correct
 * one until somebody follows it. The entry therefore carries its own provenance — who owns it,
 * which version it is, when it was last touched and what it was written from — and its `route` is
 * a key of `APP_ROUTE_POLICY`, not a free string, so a screen that is removed or whose roles move
 * breaks the registry guard instead of shipping a dead instruction.
 *
 * There is no fallback. A question the registry does not answer is answered `no_capability`.
 */
export const PRODUCT_HELP_LOCALES = ['he', 'en'] as const;
export type ProductHelpLocale = (typeof PRODUCT_HELP_LOCALES)[number];

export const ProductHelpEntrySchema = z
  .object({
    id: z.string().min(1).max(120).regex(/^[a-z0-9_]+$/, 'product_help_id_shape'),
    /** Bumped whenever the steps change, so an answer can name the version it came from. */
    version: z.number().int().positive(),
    /** Who is accountable for the sentence being true. */
    owner: z.string().min(1).max(80),
    locale: z.enum(PRODUCT_HELP_LOCALES),
    /** Roles this entry may be shown to. Narrower than, never wider than, the route's own roles. */
    roles: z.array(z.enum(ASSISTANT_ROLES)).min(1),
    /** A key of APP_ROUTE_POLICY. The guard resolves it to a path and to that path's roles. */
    route: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    /** What a person actually does, in order. An entry with no steps explains nothing. */
    steps: z.array(z.string().min(1).max(300)).min(1).max(10),
    /** Where the steps were written from — a document, a decision or a screen contract. */
    source: z.string().min(1).max(200),
    /** ISO calendar date, so staleness is answerable without reading Git. */
    updated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'product_help_updated_at_shape'),
  })
  .strict();
export type ProductHelpEntry = z.infer<typeof ProductHelpEntrySchema>;

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

export const AssistantProposalSchema = z
  .object({
  id: z.string().uuid(),
  state: z.enum(PROPOSAL_STATES),
  /** The command this proposal would run, from the allowlist. Never free text. */
  command: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
  /** Hebrew, human-readable, one line — what confirming this will do. */
  summary: z.string().min(1).max(300),
  /** The exact arguments, server-validated before the proposal was ever shown. */
  payload: z.record(z.unknown()),
  facts: z.array(FactSchema).max(2_000),
  sources: z.array(SourceReferenceSchema).max(2_000),
  expires_at: ContractTimestampSchema,
  })
  .strict();
export type AssistantProposal = z.infer<typeof AssistantProposalSchema>;

/**
 * Runtime wire contract for every successful Edge response.
 *
 * TypeScript only checks code we compiled; this schema checks the network value before React can
 * see it. It is strict at every object boundary and also verifies the cross-reference invariants
 * that a collection of individually valid facts and sources cannot express on its own.
 */
export const AssistantRunResultSchema = z
  .object({
    run_id: z.string().uuid(),
    conversation_id: z.string().uuid().nullable(),
    answer: AssistantAnswerSchema,
    facts: z.array(FactSchema).max(2_000),
    sources: z.array(SourceReferenceSchema).max(2_000),
    tools_used: z.array(z.object({
      tool: z.string().min(1).max(100),
      complete: z.boolean(),
    }).strict()).max(50),
    complete: z.boolean(),
    as_of: ContractTimestampSchema,
    proposal: AssistantProposalSchema.nullable(),
  })
  .strict()
  .superRefine((result, ctx) => {
    const facts = new Map<string, Fact>();
    result.facts.forEach((fact, index) => {
      if (facts.has(fact.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['facts', index, 'id'],
          message: 'duplicate_fact_id',
        });
      }
      facts.set(fact.id, fact);
    });

    const sources = new Set<string>();
    result.sources.forEach((source, index) => {
      if (sources.has(source.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', index, 'id'],
          message: 'duplicate_source_id',
        });
      }
      sources.add(source.id);
    });

    result.answer.blocks.forEach((block, blockIndex) => {
      if (block.type !== 'claim') return;
      for (const factId of block.fact_ids) {
        if (!facts.has(factId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['answer', 'blocks', blockIndex, 'fact_ids'],
            message: 'unknown_fact_id',
          });
        }
      }
      for (const sourceId of block.source_ids) {
        if (!sources.has(sourceId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['answer', 'blocks', blockIndex, 'source_ids'],
            message: 'unknown_source_id',
          });
        }
      }
      const supportsSemanticClaim = block.fact_ids.some((factId) => {
        const fact = facts.get(factId);
        if (!fact || fact.kind !== block.claim_kind || fact.unit !== block.claim_unit) return false;
        const sameSubject = fact.subject === null || block.subject === null
          ? fact.subject === null && block.subject === null
          : fact.subject.entity === block.subject.entity && fact.subject.id === block.subject.id;
        return sameSubject && Object.is(fact.value, block.claim_value);
      });
      if (!supportsSemanticClaim) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['answer', 'blocks', blockIndex, 'claim_value'],
          message: 'fact_does_not_support_claim_value',
        });
      }
    });

    result.answer.next_steps.forEach((step, index) => {
      if (!sources.has(step.source_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['answer', 'next_steps', index, 'source_id'],
          message: 'unknown_source_id',
        });
      }
    });

    if (result.complete !== result.tools_used.every((tool) => tool.complete)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['complete'],
        message: 'complete_does_not_match_tools',
      });
    }
  });

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

export const AssistantHistoryListRequestSchema = z.object({
  operation: z.literal('history_list'),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();
export type AssistantHistoryListRequest = z.infer<typeof AssistantHistoryListRequestSchema>;

export const AssistantHistoryLoadRequestSchema = z.object({
  operation: z.literal('history_load'),
  conversation_id: z.string().uuid(),
}).strict();
export type AssistantHistoryLoadRequest = z.infer<typeof AssistantHistoryLoadRequestSchema>;

export const AssistantConversationRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  updated_at: ContractTimestampSchema,
}).strict();
export type AssistantConversationRow = z.infer<typeof AssistantConversationRowSchema>;

export const AssistantHistoryListResponseSchema = z.object({
  conversations: z.array(AssistantConversationRowSchema).max(20),
}).strict();

export const AssistantHistoryViewSchema = z.object({
  question: z.string().trim().min(1).max(ASSISTANT_QUESTION_MAX_CHARS),
  result: AssistantRunResultSchema,
}).strict();
export type AssistantHistoryView = z.infer<typeof AssistantHistoryViewSchema>;

/**
 * A whole conversation, oldest turn first.
 *
 * The server has always built the full ordered list — `loadAuthorizedConversationViews` returns
 * every run in the conversation that still passes validation and evidence authorization — and the
 * Edge handler then returned only `views.at(-1)`. Reopening a conversation therefore showed its
 * last question and nothing else, which is what made the history list not worth having.
 *
 * The cap matches the server's own load limit. Each turn is re-validated and re-authorized on
 * every load, so a turn whose evidence the current role may no longer see is dropped as a whole
 * turn rather than rendered with holes in it.
 */
export const ASSISTANT_TRANSCRIPT_MAX_TURNS = 12;

export const AssistantHistoryTranscriptSchema = z.object({
  turns: z.array(AssistantHistoryViewSchema).min(1).max(ASSISTANT_TRANSCRIPT_MAX_TURNS),
}).strict();
export type AssistantHistoryTranscript = z.infer<typeof AssistantHistoryTranscriptSchema>;
